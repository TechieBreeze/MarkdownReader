/** Mermaid rendering for fenced ```mermaid blocks: lazy, sequential, cached.
 *
 * Why so much machinery for a diagram: the vendored mermaid bundle is 3.3MB and a
 * single flowchart render runs the dagre layout plus DOM measurement on the main
 * thread. Rendering every diagram of a document at once is what made the original
 * tool lag ("whole machine lags"), so here:
 *   - the library is fetched only when a diagram actually scrolls into view;
 *   - at most ONE diagram renders at a time (a queue drains serially);
 *   - rendered results are cached as base64 data URLs keyed by hash(source)+theme,
 *     so a re-mounted tab gets its diagrams back instantly without re-rendering.
 *
 * The SVG is inserted as <img src="data:image/svg+xml;base64,...">, never inline.
 * An inline mermaid SVG carries a <style> block scoped to every node of every
 * diagram; 50+ of them leak thousands of global CSS rules into the page (the
 * original performance bug). SVG inside an <img> is an isolated document: no CSS
 * leak and no hundreds of SVG nodes in the main DOM.
 */

const MMD_THEME = 'dark'
const MMD_LIB_SRC = `${ROUTE}/vendor/mermaid.min.js`
const MMD_CACHE_MAX_ENTRIES = 200
const MMD_CACHE_MAX_CHARS = 24 * 1024 * 1024
const MMD_DATA_URL_PREFIX = 'data:image/svg+xml;base64,'
const MMD_SCROLL_MARGIN = '200px 0px'

const MMD_CSS = `
.mdr-mermaid{margin:1em 0;padding:2px 0;text-align:center;overflow-x:auto}
.mdr-mermaid>img{max-width:100%;height:auto;display:inline-block;border-radius:6px}
.mdr-mermaid-pending{padding:10px 14px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);text-align:center}
.mdr-mermaid-error{text-align:left;color:#ef6b6b;font-size:12px;line-height:1.6;word-break:break-word}
.mdr-mermaid-details{margin-top:6px;text-align:left;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mdr-mermaid-details>summary{cursor:pointer;user-select:none}
.mdr-mermaid-details>pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:#1e1e1e;color:#d4d4d4;font:12px/1.5 "Cascadia Code",Consolas,monospace;white-space:pre-wrap;word-break:break-all;overflow:auto;text-align:left}
`

/* --------------------------------------------------------------- module state */

/** Rendered diagrams: key = theme + hash(source) -> {source, url, width, chars}. */
const mmdCache = new Map()
let mmdCacheChars = 0
/** Single shared library-load promise: the 3.3MB script is requested at most once. */
let mmdLibPromise = null
let mmdInited = false
/** Unique suffix for mermaid.render ids (ids are global in the document). */
let mmdRenderSeq = 0
let mmdMountSeq = 0
/** Serial render queue: at most one mermaid.render() in flight. */
const mmdQueue = []
let mmdPumping = false
/** Live observers, pruned whenever their container has been detached. */
const mmdLiveRecs = new Set()
const mmdContainerRecs = new WeakMap()
/** IntersectionObserver target -> queued render entry. */
const mmdPendingByEl = new WeakMap()

/* ------------------------------------------------------------------ hash/cache */

function mmdHash(text) {
  const value = String(text || '')
  let h1 = 0x811c9dc5 // FNV-1a
  let h2 = 5381 // djb2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193)
    h2 = (Math.imul(h2, 33) + code) | 0
  }
  // Two independent 32-bit hashes + length: a wrong-diagram collision is not
  // realistic, and the cached source is compared again on every hit anyway.
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}-${value.length.toString(36)}`
}

function mmdCacheKey(source) {
  return `${MMD_THEME}|${mmdHash(source)}`
}

function mmdCacheGet(key, source) {
  const entry = mmdCache.get(key)
  if (!entry || entry.source !== source) return null
  // LRU touch: move the entry to the tail of the insertion-ordered Map.
  mmdCache.delete(key)
  mmdCache.set(key, entry)
  return entry
}

function mmdCacheSet(key, source, svg) {
  const url = mmdSvgDataUrl(svg)
  if (!url) return null
  const entry = { source, url, width: mmdSvgHintWidth(svg), chars: url.length + source.length }
  const previous = mmdCache.get(key)
  if (previous) {
    mmdCache.delete(key)
    mmdCacheChars -= previous.chars
  }
  mmdCache.set(key, entry)
  mmdCacheChars += entry.chars
  // Bounded LRU: cap both entry count and approximate character weight. Keep the
  // just-inserted entry even if it alone exceeds the budget.
  while (mmdCache.size > 1 && (mmdCache.size > MMD_CACHE_MAX_ENTRIES || mmdCacheChars > MMD_CACHE_MAX_CHARS)) {
    const oldest = mmdCache.keys().next()
    if (oldest.done) break
    const dropped = mmdCache.get(oldest.value)
    mmdCache.delete(oldest.value)
    if (dropped) mmdCacheChars -= dropped.chars
  }
  if (mmdCacheChars < 0) mmdCacheChars = 0
  return entry
}

/** UTF-8 safe base64 data URL. Plain btoa() throws on non-Latin1 diagram labels. */
function mmdSvgDataUrl(svg) {
  const text = String(svg || '')
  if (!text) return ''
  try {
    let base64 = ''
    if (typeof TextEncoder === 'function') {
      const bytes = new TextEncoder().encode(text)
      const chunk = 0x8000
      let binary = ''
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      base64 = btoa(binary)
    } else {
      base64 = btoa(unescape(encodeURIComponent(text)))
    }
    return MMD_DATA_URL_PREFIX + base64
  } catch {
    try {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
    } catch {
      return ''
    }
  }
}

/** Design width from the SVG root's viewBox (mermaid often emits width="100%"). */
function mmdSvgHintWidth(svg) {
  const text = String(svg || '')
  const root = /<svg\b[^>]*>/i.exec(text)
  const head = root ? root[0] : text.slice(0, 4000)
  const viewBox = /viewBox\s*=\s*["']\s*[-+\d.]+[\s,]+[-+\d.]+[\s,]+([-+\d.]+)[\s,]+[-+\d.]+/i.exec(head)
  if (viewBox) {
    const width = Number(viewBox[1])
    if (Number.isFinite(width) && width > 0 && width <= 20000) return Math.round(width)
  }
  const widthAttr = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(head)
  if (widthAttr) {
    const width = Number(widthAttr[1])
    if (Number.isFinite(width) && width > 0 && width <= 20000) return Math.round(width)
  }
  return 0
}

/* ---------------------------------------------------------------- local style */

function mmdEnsureStyle() {
  if (document.getElementById('mdr-mermaid-style')) return
  const style = document.createElement('style')
  style.id = 'mdr-mermaid-style'
  style.textContent = MMD_CSS
  document.head.appendChild(style)
}

/* -------------------------------------------------------------- library load */

function mmdEnsureLib() {
  if (mmdLibPromise) return mmdLibPromise
  mmdLibPromise = new Promise((resolve, reject) => {
    const activate = () => {
      try {
        const lib = window.mermaid
        if (!lib || typeof lib.render !== 'function' || typeof lib.initialize !== 'function') {
          reject(new Error('mermaid 全局对象不可用'))
          return
        }
        if (!mmdInited) {
          lib.initialize({ startOnLoad: false, theme: MMD_THEME, securityLevel: 'strict' })
          mmdInited = true
        }
        resolve(lib)
      } catch (err) {
        reject(err)
      }
    }
    if (window.mermaid && typeof window.mermaid.render === 'function') {
      activate()
      return
    }
    const script = document.createElement('script')
    script.src = MMD_LIB_SRC
    script.async = true
    script.setAttribute('data-mdr-mermaid-lib', '1')
    script.onload = () => activate()
    script.onerror = () => reject(new Error(`mermaid 库加载失败: ${MMD_LIB_SRC}`))
    document.head.appendChild(script)
  })
  return mmdLibPromise
}

/* ------------------------------------------------------------------- rendering */

function mmdExtractSvg(result) {
  if (typeof result === 'string') return result
  if (result && typeof result.svg === 'string') return result.svg
  return ''
}

function mmdErrorMessage(err) {
  if (!err) return '未知错误'
  const raw = typeof err === 'string' ? err : err.message || err.reason || String(err)
  const text = String(raw).replace(/\s+/g, ' ').trim()
  if (!text) return '未知错误'
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** mermaid.render creates temporary #id / #d{id} / #i{id} nodes in <body>. */
function mmdCleanupRenderNodes(id) {
  for (const prefix of ['', 'd', 'i']) {
    const node = document.getElementById(prefix + id)
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }
}

async function mmdRenderOne(entry) {
  const el = entry.el
  if (!el || !el.isConnected) return
  const cached = mmdCacheGet(entry.key, entry.source)
  if (cached) {
    mmdApplyCached(el, cached, entry.source)
    return
  }
  let lib
  try {
    lib = await mmdEnsureLib()
  } catch (err) {
    if (el.isConnected) mmdShowError(el, entry.source, err)
    return
  }
  if (!el.isConnected) return
  const id = `mdr-mermaid-${entry.mount}-${++mmdRenderSeq}`
  let result
  try {
    result = await lib.render(id, entry.source)
  } catch (err) {
    mmdCleanupRenderNodes(id)
    if (el.isConnected) mmdShowError(el, entry.source, err)
    return
  }
  mmdCleanupRenderNodes(id)
  const svg = mmdExtractSvg(result)
  if (!svg) {
    if (el.isConnected) mmdShowError(el, entry.source, new Error('渲染结果为空'))
    return
  }
  // Cache first: if the tab was switched away while rendering, the next mount of
  // the same document still gets the diagram instantly from the cache.
  const stored = mmdCacheSet(entry.key, entry.source, svg)
  if (!el.isConnected) return
  if (stored) mmdApplyCached(el, stored, entry.source)
  else mmdShowError(el, entry.source, new Error('SVG 编码失败'))
}

/* -------------------------------------------------------------- serial queue */

function mmdEnqueue(entry) {
  if (!entry || !entry.el || !entry.el.isConnected) return
  mmdQueue.push(entry)
  mmdPump()
}

async function mmdPump() {
  if (mmdPumping) return
  mmdPumping = true
  try {
    while (mmdQueue.length) {
      const entry = mmdQueue.shift()
      if (!entry || !entry.el || !entry.el.isConnected) continue
      if (entry.el.classList.contains('mdr-mermaid-done')) continue
      try {
        await mmdRenderOne(entry)
      } catch (err) {
        // A broken diagram must never stop the queue or break the document.
        if (entry.el && entry.el.isConnected) mmdShowError(entry.el, entry.source, err)
      }
    }
  } finally {
    mmdPumping = false
  }
}

/* ------------------------------------------------------------------- observers */

function mmdStopRec(rec) {
  if (!rec) return
  try {
    rec.observer.disconnect()
  } catch {
    // already gone
  }
  mmdLiveRecs.delete(rec)
  if (rec.container && mmdContainerRecs.get(rec.container) === rec) {
    mmdContainerRecs.delete(rec.container)
  }
}

/** Disconnect observers whose container was detached (tab switch / refresh). */
function mmdPruneRecs() {
  for (const rec of [...mmdLiveRecs]) {
    if (!rec.container || !rec.container.isConnected) mmdStopRec(rec)
  }
}

function mmdHandleIntersect(rec, entries) {
  if (!rec.container || !rec.container.isConnected) {
    mmdStopRec(rec)
    return
  }
  for (const change of entries) {
    if (!change.isIntersecting) continue
    const el = change.target
    const entry = mmdPendingByEl.get(el)
    mmdPendingByEl.delete(el)
    try {
      rec.observer.unobserve(el)
    } catch {
      // already unobserved
    }
    rec.left = Math.max(0, rec.left - 1)
    if (entry) mmdEnqueue(entry)
  }
  if (rec.left <= 0) mmdStopRec(rec)
}

/* ---------------------------------------------------------------------- DOM */

function mmdCreatePlaceholder(source) {
  const el = document.createElement('div')
  el.className = 'mdr-mermaid mdr-mermaid-pending'
  el.dataset.mermaidSource = source
  const note = document.createElement('span')
  note.className = 'mdr-mermaid-note'
  note.textContent = '▦ mermaid 图 · 滚动到可见时渲染'
  el.appendChild(note)
  return el
}

/** Collapsed source block: keeps the mermaid source copyable without noise. */
function mmdSourceDetails(source) {
  const details = document.createElement('details')
  details.className = 'mdr-mermaid-details'
  const summary = document.createElement('summary')
  summary.textContent = 'mermaid 源码'
  const pre = document.createElement('pre')
  pre.textContent = source
  details.appendChild(summary)
  details.appendChild(pre)
  return details
}

function mmdApplyCached(el, cached, source) {
  if (!el || !el.isConnected) return
  if (el.classList.contains('mdr-mermaid-done')) return
  mmdPendingByEl.delete(el)
  el.classList.remove('mdr-mermaid-pending')
  el.classList.add('mdr-mermaid-done')
  el.textContent = ''
  const img = document.createElement('img')
  img.alt = 'mermaid 图'
  img.title = 'mermaid 图'
  img.loading = 'lazy'
  if (cached.width > 0) img.style.width = `${cached.width}px`
  img.onerror = () => {
    el.textContent = ''
    const note = document.createElement('div')
    note.className = 'mdr-mermaid-error'
    note.textContent = 'mermaid 图片加载失败'
    el.appendChild(note)
  }
  img.src = cached.url
  el.appendChild(img)
  el.appendChild(mmdSourceDetails(source))
}

function mmdShowError(el, source, err) {
  if (!el || !el.isConnected) return
  mmdPendingByEl.delete(el)
  el.classList.remove('mdr-mermaid-pending')
  el.classList.add('mdr-mermaid-failed')
  el.textContent = ''
  const note = document.createElement('div')
  note.className = 'mdr-mermaid-error'
  note.textContent = `mermaid 渲染失败: ${mmdErrorMessage(err)}`
  el.appendChild(note)
  el.appendChild(mmdSourceDetails(source))
}

/* ------------------------------------------------------------------- entry */

function enhanceMermaid(container, scroller) {
  if (!container || typeof container.querySelectorAll !== 'function') return
  try {
    const codes = container.querySelectorAll('code[data-mermaid-source]')
    const pendingEls = container.querySelectorAll('.mdr-mermaid[data-mermaid-source]')
    if ((!codes || !codes.length) && (!pendingEls || !pendingEls.length)) {
      // No mermaid fence in this document: never touch / load the 3.3MB library.
      return
    }
    mmdEnsureStyle()
    mmdPruneRecs()
    // Refresh replaces innerHTML of the SAME .mdr-md container, so the previous
    // observer can outlive its placeholders. Drop it here, before the early return
    // paths below (cache-hit rebuilds register no new observer at all).
    const previous = mmdContainerRecs.get(container)
    if (previous) mmdStopRec(previous)
    const mount = ++mmdMountSeq

    const items = []
    const created = new Set()
    if (codes && codes.length) {
      for (const code of codes) {
        const source = code.getAttribute('data-mermaid-source') || ''
        if (!source.trim()) continue
        const holder = code.closest('pre') || code
        if (!holder.parentNode) continue
        const el = mmdCreatePlaceholder(source)
        created.add(el)
        holder.replaceWith(el)
        items.push({ el, source })
      }
    }
    // A re-run on the same container (defensive: 10-markdown re-enhances after a
    // rebuild in place) may find already-created placeholders instead of <code>.
    for (const el of pendingEls || []) {
      if (created.has(el)) continue
      if (el.classList.contains('mdr-mermaid-done') || el.classList.contains('mdr-mermaid-failed')) continue
      if (el.querySelector('img')) continue
      const source = el.getAttribute('data-mermaid-source') || ''
      if (!source.trim()) continue
      items.push({ el, source })
    }
    if (!items.length) return

    // Cache hits are restored synchronously during insert -> rebuilt tab has its
    // diagrams back before the first paint and its scroll height is correct again.
    const waiting = []
    for (const item of items) {
      const key = mmdCacheKey(item.source)
      const hit = mmdCacheGet(key, item.source)
      if (hit) mmdApplyCached(item.el, hit, item.source)
      else waiting.push({ el: item.el, source: item.source, key, mount })
    }
    if (!waiting.length) return

    if (typeof window.IntersectionObserver !== 'function') {
      // Degrade gracefully: still serial through the queue, so only one renders.
      waiting.forEach((entry) => mmdEnqueue(entry))
      return
    }
    const scrollRoot = scroller || (container.closest ? container.closest('.mdr-content') : null)
    const rec = { container, left: waiting.length, observer: null }
    rec.observer = new window.IntersectionObserver((entries) => mmdHandleIntersect(rec, entries), {
      root: scrollRoot || null,
      rootMargin: MMD_SCROLL_MARGIN,
      threshold: 0,
    })
    mmdContainerRecs.set(container, rec)
    mmdLiveRecs.add(rec)
    for (const entry of waiting) {
      mmdPendingByEl.set(entry.el, entry)
      rec.observer.observe(entry.el)
    }
  } catch (err) {
    // Mermaid rendering is an enhancement: a failure must not break the document.
    if (window.console && console.warn) console.warn('[markdown-reader] mermaid:', err)
  }
}
