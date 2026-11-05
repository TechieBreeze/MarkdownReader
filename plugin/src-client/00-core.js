/**
 * Core helpers shared by every client part: route, fetch helpers, path rules,
 * vendor loader, small storage helper and the global stylesheet.
 */

const ROUTE = '/markdown-reader'
const TREE_KEY = 'mdreader.plugin.tree.v1'

const MD_EXTS = new Set(['.md', '.markdown'])
const CODE_EXTS = new Set([
  '.java', '.kt', '.kts', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue',
  '.py', '.go', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp', '.scala',
  '.xml', '.yml', '.yaml', '.json', '.properties', '.sql', '.sh', '.bat', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.gradle', '.toml', '.md',
])

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function extOf(rel) {
  const base = String(rel || '').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function isMdFile(rel) {
  return MD_EXTS.has(extOf(rel))
}

function isCodeFile(rel) {
  return CODE_EXTS.has(extOf(rel))
}

function isImageFile(rel) {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(extOf(rel))
}

function dirnameOf(rel) {
  const value = String(rel || '')
  const at = value.lastIndexOf('/')
  return at < 0 ? '' : value.slice(0, at)
}

function encodeQuery(params) {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((item) => usp.append(key, String(item)))
    else usp.append(key, String(value))
  }
  const text = usp.toString()
  return text ? `?${text}` : ''
}

/**
 * Current-project scope (vtop name, null = all). The Host supports a `project`
 * filter on /api/search, /api/files and /api/git/repos; the panels that call
 * those endpoints (25-search.js / 28-gitgraph.js) don't know about the project
 * layer, so the scope is injected here. Set by the workbench (50-app.js).
 */
let projectScope = null
function setProjectScope(name) {
  projectScope = name || null
}
const PROJECT_SCOPED_ENDPOINTS = new Set(['/api/search', '/api/files', '/api/git/repos'])

async function fetchJson(endpoint, params, init) {
  let query = params
  if (projectScope && PROJECT_SCOPED_ENDPOINTS.has(endpoint) && !(query && query.project)) {
    query = { ...(query || {}), project: projectScope }
  }
  const response = await fetch(ROUTE + endpoint + encodeQuery(query), init)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || !payload || payload.ok === false) {
    const message = (payload && payload.error) || `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

async function postJson(endpoint, body) {
  return fetchJson(endpoint, null, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

/** Resolve a link inside a markdown document to a client-visible relative path. */
function resolveRel(mdPath, href, multi, rootNames) {
  const raw = String(href || '').replace(/\\/g, '/')
  const clean = raw.replace(/^\/+/, '')
  const segs = clean.split('/').filter((part) => part && part !== '.')
  const baseDir = dirnameOf(mdPath)
  const docRootName = multi ? String(mdPath || '').split('/')[0] : ''
  let parts
  if (raw.startsWith('/')) {
    // Root-absolute links (`/docs/x.md`) mean "from the project root". In a
    // multi-root session that is the CURRENT document's project unless the
    // first segment already names an open root.
    if (multi && rootNames && rootNames.includes(segs[0])) parts = segs
    else if (multi) parts = [docRootName, ...segs]
    else parts = segs
  } else {
    parts = [...(baseDir ? baseDir.split('/') : []), ...segs]
  }
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function splitHref(href) {
  const text = String(href || '')
  const hashAt = text.indexOf('#')
  if (hashAt < 0) return { path: text, hash: '' }
  return { path: text.slice(0, hashAt), hash: text.slice(hashAt + 1) }
}

/* ------------------------------------------------------- clipboard & toast */

/**
 * Copy text with the same three-step ladder as the standalone reader:
 * navigator.clipboard → execCommand → select for a manual Ctrl+C.
 * `http://` origins have no navigator.clipboard in Chromium, so the fallback is
 * the normal path when the harness UI is served over plain HTTP.
 */
function copyText(value) {
  const text = String(value == null ? '' : value)
  if (!text) return Promise.resolve(false)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyTextFallback(text),
    )
  }
  return Promise.resolve(copyTextFallback(text))
}

function copyTextFallback(text) {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    area.remove()
    return ok
  } catch {
    return false
  }
}

let toastTimer = null

/** Transient status line at the bottom of the viewport (replaces the original's #toast). */
function toast(message, kind) {
  let node = document.getElementById('mdr-toast')
  if (!node) {
    node = document.createElement('div')
    node.id = 'mdr-toast'
    document.body.appendChild(node)
  }
  node.className = 'mdr-toast show' + (kind === 'err' ? ' err' : '')
  node.textContent = String(message == null ? '' : message)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.className = 'mdr-toast'
  }, 2600)
}

function copyWithToast(value, okMessage) {
  const text = String(value == null ? '' : value)
  if (!text) {
    toast('没有可复制的内容', 'err')
    return
  }
  copyText(text).then((ok) => toast(ok ? okMessage || '已复制到剪贴板' : '复制失败：请手动选中后按 Ctrl+C', ok ? 'ok' : 'err'))
}

/* ------------------------------------------------- path right-click menu */

/**
 * Right-click a path (code modal head / code tab head / html tab head / image
 * name / search hit / tree row / tab) → copy the path or the file name.
 *
 * The standalone reader only covered the four path labels; the tree row and the
 * tab strip are included here because they are the same affordance shape and a
 * file tree is the first place a path gets copied from.
 */
const PATH_MENU_SELECTOR = [
  '.mdr-code-path',
  '.mdr-cmodal-path',
  '.mdr-html-path',
  '.mdr-image-name',
  '.mdr-search-path',
  '.mdr-tr',
  '.mdr-tab',
].join(',')

let pathMenu = null

function pathMenuClose() {
  if (pathMenu && pathMenu.parentNode) pathMenu.parentNode.removeChild(pathMenu)
  pathMenu = null
  document.removeEventListener('mousedown', pathMenuOnDocMouseDown, true)
  document.removeEventListener('keydown', pathMenuOnKey, true)
}

function pathMenuOnDocMouseDown(event) {
  if (pathMenu && pathMenu.contains(event.target)) return
  pathMenuClose()
}

function pathMenuOnKey(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  pathMenuClose()
}

function pathMenuOpen(x, y, items) {
  pathMenuClose()
  const menu = document.createElement('div')
  menu.className = 'mdr-ctx'
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mdr-ctx-item'
    button.textContent = item.label
    button.title = item.title || item.label
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      pathMenuClose()
      item.action()
    })
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`
  pathMenu = menu
  // Defer so the very right-click that opened the menu cannot close it.
  setTimeout(() => {
    document.addEventListener('mousedown', pathMenuOnDocMouseDown, true)
    document.addEventListener('keydown', pathMenuOnKey, true)
  }, 0)
}

/** Path shown by an element: explicit attribute → title → text. */
function pathOfElement(element) {
  if (!element) return ''
  const explicit = element.getAttribute('data-mdr-path') || element.getAttribute('data-path')
  if (explicit) return explicit
  const title = (element.getAttribute('title') || '').trim()
  if (title) return title.split('\n')[0].replace(/:\d+$/, '')
  return (element.textContent || '').trim()
}

function pathMenuTarget(event) {
  if (!event.target || !event.target.closest) return null
  const hit = event.target.closest(PATH_MENU_SELECTOR)
  if (!hit) return null
  const path = pathOfElement(hit)
  if (!path || /\s/.test(path)) return null
  return path
}

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
  document.addEventListener('contextmenu', (event) => {
    const path = pathMenuTarget(event)
    if (!path) return
    event.preventDefault()
    const fileName = path.split(/[\\/]/).pop()
    pathMenuOpen(event.clientX, event.clientY, [
      { label: '复制路径', title: path, action: () => copyWithToast(path, '已复制路径') },
      { label: '复制文件名', title: fileName, action: () => copyWithToast(fileName, '已复制文件名') },
    ])
  })
}

/* ------------------------------------------------------------------ vendor */

let vendorPromise = null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`加载失败: ${src}`))
    document.head.appendChild(script)
  })
}

function ensureVendor() {
  if (vendorPromise) return vendorPromise
  vendorPromise = (async () => {
    if (!window.marked) await loadScript(`${ROUTE}/vendor/marked.min.js`)
    if (!window.hljs) await loadScript(`${ROUTE}/vendor/highlight.min.js`)
    if (!window.marked || !window.hljs) throw new Error('本地渲染库加载失败')
    return { marked: window.marked, hljs: window.hljs }
  })()
  return vendorPromise
}

/* ----------------------------------------------------------------- storage */

const treeStorage = {  load() {
    try {
      const value = JSON.parse(localStorage.getItem(TREE_KEY) || '[]')
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  },
  save(paths) {
    try {
      localStorage.setItem(TREE_KEY, JSON.stringify([...paths]))
    } catch {
      // private mode / quota: expansion stays in memory only
    }
  },
}

const TABS_KEY = 'mdreader.plugin.tabs.v1'
const SCROLL_KEY = 'mdreader.plugin.scroll.v1'

const tabsStorage = {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(TABS_KEY) || 'null')
      if (!value || !Array.isArray(value.tabs)) return null
      const tabs = value.tabs
        .filter((tab) => tab && typeof tab.path === 'string' && (tab.kind === 'md' || tab.kind === 'code'))
        .map((tab) => ({ id: `${tab.kind}:${tab.path}`, kind: tab.kind, path: tab.path, line: Number(tab.line) || 0 }))
      if (!tabs.length) return null
      const activeId = tabs.some((tab) => tab.id === value.activeId) ? value.activeId : tabs[tabs.length - 1].id
      return { tabs, activeId }
    } catch {
      return null
    }
  },
  save(tabs, activeId) {
    try {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({ tabs: tabs.map((tab) => ({ kind: tab.kind, path: tab.path, line: tab.line || 0 })), activeId }),
      )
    } catch {
      // ignore storage failures
    }
  },
}

/* ------------------------------------------------ workbench (项目 → 任务) keys */

/**
 * The standalone reader's two layers need two independent stores per project:
 *
 *   任务集/标签页  curProject ? mdreader.plugin.tasks.<project>.v1
 *                              : mdreader.plugin.tasks.v1   (全部项目 / legacy)
 *   目录树展开态   mdreader.plugin.tree.<project|all>.v1
 *
 * Migration sources: the earlier plugin stored one flat tab set under
 * mdreader.plugin.tabs.v1 (see tabsStorage above); the standalone tool used
 * mdreader.tasks.v1 / mdreader.tree.v1. The tree legacy key is read once as the
 * default for the 全部 view, then re-saved under the new key.
 */
const LEGACY_TREE_KEY = TREE_KEY
const PROJECT_KEY = 'mdreader.plugin.project.v1'

function taskStoreKey(project) {
  return project ? `mdreader.plugin.tasks.${project}.v1` : 'mdreader.plugin.tasks.v1'
}

function treeStoreKey(project) {
  return `mdreader.plugin.tree.${project || 'all'}.v1`
}

function readStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    return value == null ? fallback : value
  } catch {
    return fallback
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private mode / quota: the in-memory state still works for this page
  }
}

/** Persisted project selection (null = 全部). */
function loadProjectSelection() {
  const value = readStoredJson(PROJECT_KEY, null)
  return value && typeof value.name === 'string' && value.name ? value.name : null
}

function saveProjectSelection(project) {
  writeStoredJson(PROJECT_KEY, { name: project || '' })
}

/** Expansion paths for one project view; migrates the pre-project tree key. */
function loadTreeExpansion(project) {
  const stored = readStoredJson(treeStoreKey(project), null)
  let paths = stored && Array.isArray(stored.paths) ? stored.paths.filter((item) => typeof item === 'string') : null
  if (!paths && !project) {
    const legacy = readStoredJson(LEGACY_TREE_KEY, null)
    paths = Array.isArray(legacy) ? legacy.filter((item) => typeof item === 'string') : []
  }
  return paths || []
}

function saveTreeExpansion(project, paths) {
  writeStoredJson(treeStoreKey(project), { paths: [...paths] })
}

/**
 * Per-tab scroll offsets, keyed by `${kind}:${path}`. Writes are debounced so a
 * scroll gesture costs one localStorage write per ~350ms, and the in-memory copy
 * is authoritative when storage is unavailable.
 */
const scrollStorage = (() => {
  const cache = { value: null, timer: 0 }
  const read = () => {
    if (cache.value) return cache.value
    try {
      const parsed = JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}')
      cache.value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      cache.value = {}
    }
    return cache.value
  }
  const flush = () => {
    cache.timer = 0
    try {
      localStorage.setItem(SCROLL_KEY, JSON.stringify(read()))
    } catch {
      // quota / private mode: in-memory copy still works for this page
    }
  }
  return {
    get(key) {
      const value = Number(read()[key])
      return Number.isFinite(value) && value > 0 ? value : 0
    },
    set(key, value) {
      if (!key) return
      read()[key] = Math.max(0, Math.round(Number(value) || 0))
      if (!cache.timer) cache.timer = setTimeout(flush, 350)
    },
    /** Write the in-memory map right now (used when the page is about to unload). */
    flushNow() {
      if (cache.timer) {
        clearTimeout(cache.timer)
        cache.timer = 0
      }
      flush()
    },
  }
})()

/* ------------------------------------------------------------------- icons */

function svgIcon(paths, viewBox) {
  return (props) => {
    const size = (props && props.size) || 16
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: viewBox || '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
      paths.map((d, index) => h('path', { key: index, d })),
    )
  }
}

const Icons = {
  doc: svgIcon(['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5']),
  code: svgIcon(['M8 9l-3 3 3 3', 'M16 9l3 3-3 3', 'M13 5l-2 14']),
  image: svgIcon(['M4 5h16v14H4z', 'M4 15l4-4 4 4 3-3 5 5', 'M9 9.5h.01']),
  folder: svgIcon(['M4 6h5l2 2h9v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z']),
  refresh: svgIcon(['M20 11a8 8 0 1 0-2.3 6.4', 'M20 4v7h-7']),
  close: svgIcon(['M6 6l12 12', 'M18 6L6 18']),
  layers: svgIcon(['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5']),
  search: svgIcon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4']),
}

function fileIcon(ext) {
  if (MD_EXTS.has(ext)) return { kind: 'doc', color: '#4E9BD6' }
  if (['.json', '.xml', '.yml', '.yaml', '.properties', '.toml'].includes(ext)) return { kind: 'code', color: '#C9A227' }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return { kind: 'image', color: '#8A6FD1' }
  return { kind: 'code', color: '#57A773' }
}

/* ------------------------------------------------------------------- style */

const APP_CSS = `
.mdr-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.mdr-topbar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;background:var(--dsw-alias-bg-layer-1)}
.mdr-brand{display:flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap}
.mdr-brand svg{color:var(--dsw-alias-brand-primary)}
.mdr-path{flex:1;min-width:80px;max-width:520px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.mdr-path:focus{border-color:var(--dsw-alias-brand-primary)}
.mdr-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap}
.mdr-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mdr-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mdr-spacer{flex:1}
.mdr-body{display:flex;flex:1;min-height:0}
.mdr-tree{flex:0 0 262px;min-width:180px;max-width:40%;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:4px 0 12px;background:var(--dsw-alias-bg-layer-1)}
.mdr-right{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.mdr-tabbar{display:flex;align-items:stretch;gap:2px;overflow-x:auto;flex:0 0 auto;padding:3px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mdr-tab{display:flex;align-items:center;gap:6px;max-width:230px;padding:5px 8px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;font-size:12.5px}
.mdr-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.mdr-tab.on{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.mdr-tab-name{overflow:hidden;text-overflow:ellipsis}
.mdr-tab-close{display:inline-flex;padding:1px;border-radius:4px;opacity:.55}
.mdr-tab-close:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}
.mdr-content{flex:1;min-height:0;overflow:auto;position:relative;scroll-behavior:auto;overflow-anchor:none}
.mdr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--dsw-alias-label-secondary)}
.mdr-empty h2{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mdr-err{position:absolute;left:16px;right:16px;top:8px;z-index:5;padding:7px 10px;border-radius:6px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.18)}
.mdr-tree-toolbar{display:flex;align-items:center;gap:6px;padding:4px 10px 6px;position:sticky;top:0;left:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.mdr-tree-tip{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 行宽跟内容 + 横向滚动（对齐原版）：每行至少铺满树宽，文件名不截断；
   前导列（缩进箭头 / 图标）固定宽度，保证同级行的左侧严格对齐。 */
.mdr-tr{display:flex;align-items:center;gap:4px;padding:2px 8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary);width:max-content;min-width:100%}
.mdr-tr:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mdr-tr.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mdr-caret{display:inline-flex;flex:0 0 12px;width:12px;justify-content:center;transition:transform .12s;color:var(--dsw-alias-label-secondary);font-size:10px}
.mdr-caret.open{transform:rotate(90deg)}
.mdr-ticon{display:inline-flex;flex:0 0 auto}
.mdr-tname{flex:none;overflow:visible;text-overflow:clip;white-space:nowrap}
.mdr-tip{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mdr-roots{position:absolute;right:12px;top:42px;z-index:20;width:360px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.28)}
.mdr-roots h3{margin:0 0 8px;font-size:12.5px;font-weight:600}
.mdr-root-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.mdr-root-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);direction:rtl;text-align:left}
.mdr-roots input{width:100%;box-sizing:border-box;margin-top:8px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.mdr-content.code{overflow:hidden;display:flex;flex-direction:column}
.mdr-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.28);padding-top:10vh}
.mdr-panel{width:min(700px,86vw);max-height:74vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 40px rgba(0,0,0,.4);overflow:hidden}
.mdr-panel-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;font-weight:600;font-size:12.5px}
.mdr-panel-body{overflow:auto;padding:4px 0;flex:1;min-height:0}
.mdr-panel-input{flex:1;min-width:60px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none;font-weight:400}
.mdr-item-row{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;font-size:12.5px}
.mdr-item-row:hover{background:var(--dsw-alias-bg-layer-2)}
.mdr-item-row.on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mdr-item-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-item-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mdr-hit-line{color:var(--dsw-alias-label-secondary);padding:1px 12px;font-family:"Cascadia Code",Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all}
.mdr-hit-line mark{background:rgba(255,214,102,.28);color:var(--dsw-alias-label-primary);border-radius:2px}
.mdr-md-wrap{position:relative;min-height:100%}
.mdr-md{padding:18px 30px 80px;max-width:1100px;margin:0 auto;line-height:1.72;font-size:14px}
.mdr-md h1,.mdr-md h2,.mdr-md h3,.mdr-md h4{color:var(--dsw-alias-label-primary);font-weight:600;line-height:1.35;margin:1.4em 0 .6em}
.mdr-md h1{font-size:1.7em;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:.35em}
.mdr-md h2{font-size:1.35em;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:.25em}
.mdr-md h3{font-size:1.15em}
.mdr-md p,.mdr-md li{color:var(--dsw-alias-label-primary)}
.mdr-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.mdr-md a:hover{text-decoration:underline}
.mdr-md a.mdr-jump{display:inline-flex;align-items:center;gap:4px;padding:0 5px;border:1px solid rgba(78,155,214,.45);border-radius:4px;background:rgba(78,155,214,.12);color:#6bb3e0;cursor:pointer;font-size:.95em}
.mdr-md a.mdr-jump:hover{background:rgba(78,155,214,.24);text-decoration:none}
.mdr-badge{display:inline-flex;align-items:center;padding:0 4px;border-radius:3px;background:rgba(78,155,214,.3);color:#cfe6ff;font-size:10.5px;font-weight:600;line-height:1.6}
.mdr-line-token{opacity:.55}
.mdr-md code{font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:.92em;padding:.15em .35em;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mdr-md pre{margin:1em 0;padding:12px 14px;border-radius:8px;background:#1e1e1e;overflow:auto;line-height:1.55}
.mdr-md pre code{padding:0;background:transparent;color:#d4d4d4;font-size:12.5px}
.mdr-md blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.mdr-md table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto;max-width:100%}
.mdr-md th,.mdr-md td{border:1px solid var(--dsw-alias-border-l1);padding:6px 10px}
.mdr-md th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.mdr-md img{max-width:100%;border-radius:6px}
.mdr-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:1.8em 0}
.mdr-mermaid-note{color:#d4a94a;font-size:12px}
.mdr-code{display:flex;flex-direction:column;height:100%;min-height:0}
.mdr-code-viewwrap{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.mdr-code-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.mdr-code-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.mdr-code-body{background:#1e1e1e;padding:8px 0 40px;flex:1;min-height:0}
.mdr-cl{display:flex;min-height:20px;line-height:20px;font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:12.5px}
.mdr-cl.hit{background:rgba(255,214,102,.16)}
.mdr-cl-no{flex:0 0 62px;text-align:right;padding-right:14px;color:#858585;background:#252526;border-right:1px solid #3e3e42;user-select:none;position:sticky;left:0;z-index:1}
.mdr-cl-code{flex:1;padding-left:16px;color:#d4d4d4;white-space:pre;tab-size:4}
.mdr-root .hljs-keyword,.mdr-root .hljs-tag,.mdr-root .hljs-attr,.mdr-root .hljs-meta,.mdr-root .hljs-selector-tag{color:#569cd6}
.mdr-root .hljs-string,.mdr-root .hljs-selector-attr,.mdr-root .hljs-template-tag,.mdr-root .hljs-attr-value{color:#ce9178}
.mdr-root .hljs-comment,.mdr-root .hljs-quote{color:#6a9955}
.mdr-root .hljs-number,.mdr-root .hljs-literal,.mdr-root .hljs-symbol,.mdr-root .hljs-bullet{color:#b5cea8}
.mdr-root .hljs-type,.mdr-root .hljs-title.class_,.mdr-root .hljs-built_in,.mdr-root .hljs-title.class{color:#4ec9b0}
.mdr-root .hljs-title.function_,.mdr-root .hljs-title.function{color:#dcdcaa}
.mdr-root .hljs-variable,.mdr-root .hljs-params,.mdr-root .hljs-property,.mdr-root .hljs-attr-name,.mdr-root .hljs-subst{color:#9cdcfe}
.mdr-root .hljs-regexp,.mdr-root .hljs-link{color:#d16969}
.mdr-root .hljs-title{color:#dcdcaa}
.mdr-def-busy{cursor:progress}
.mdr-def-snippet{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-ctx{position:fixed;z-index:2147483000;min-width:148px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.4);display:flex;flex-direction:column}
.mdr-ctx-item{display:block;width:100%;text-align:left;padding:6px 10px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.mdr-ctx-item:hover{background:var(--dsw-alias-bg-layer-2)}
.mdr-toast{position:fixed;left:50%;bottom:38px;z-index:2147483000;transform:translateX(-50%) translateY(8px);padding:7px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12.5px;box-shadow:0 8px 26px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.mdr-toast.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
`
