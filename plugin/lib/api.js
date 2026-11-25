/**
 * Host HTTP API for the Markdown Reader plugin.
 *
 * Everything the page needs is served from one same-origin prefix route:
 * workspace roots, directory listing, markdown/code text, path resolution and
 * read-only git views. No client ever runs a shell command.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROUTE, VERSION } from './constants.js'
import { sendJson, sendError, sendFile, readBody } from './http.js'
import { CODE_EXTS, MARKDOWN_EXTS, HIDDEN_DIR_NAMES } from './state.js'
import { resolveDefinition, prewarmDefIndex } from './defs.js'
import { syncStatus, syncPull } from './sync.js'
import { gitGraph, listRepos } from './gitgraph.js'
import { renderHtmlPreview } from './htmlpreview.js'
import { resolveRepoUrls } from './gitlinks.js'
import { fetchRemoteFile, readRemoteFile, readRemotePatch } from './remote.js'

const execFileAsync = promisify(execFile)

/**
 * The client build id the Harness has REGISTERED right now.
 *
 * The ESM module cache keeps this module alive across disable/enable cycles, so
 * reading it once at import time is NOT enough: the value would stay at the
 * build that was current when the process started, and after a rebuild the
 * client would wait forever for it to catch up. `apply()` (index.js) runs on
 * every activation and calls `noteActivatedBuild()` to re-read the file.
 *
 * Why the client needs it at all: the page reloads itself when it detects a
 * newer bundle, and a reload between `build.mjs` and the plugin being
 * re-enabled boots the OLD registered bundle URL while the file on disk is
 * already the new one - the import fails and the app shows
 * 「应用无法启动或已意外停止」.
 */
let ACTIVATION_BUILD = ''

/** Re-read the build the Harness is about to serve (called from plugin apply()). */
export function noteActivatedBuild(packageDir) {
  try {
    const dir = packageDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'client.build.json'), 'utf8'))
    ACTIVATION_BUILD = meta && typeof meta.build === 'string' ? meta.build : ''
  } catch {
    ACTIVATION_BUILD = ''
  }
  return ACTIVATION_BUILD
}

// Best effort at import time; apply() refreshes it on every activation.
noteActivatedBuild()

const VENDOR_WHITELIST = new Set([
  'marked.min.js',
  'highlight.min.js',
  'github-dark.min.css',
  'gitgraph.min.js',
  'gitgraph.min.css',
  'mermaid.min.js',
])

/** Extensions searched as plain text and offered by quick open. */
const TEXT_EXTS = new Set([
  '.java', '.kt', '.kts', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue',
  '.py', '.go', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp', '.scala',
  '.xml', '.yml', '.yaml', '.json', '.properties', '.sql', '.sh', '.bat', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.gradle', '.toml', '.md', '.markdown',
  '.txt', '.conf', '.ini', '.env', '.gitignore', '.dockerfile',
])

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/**
 * Static assets an HTML preview may pull in (styles/scripts/fonts). Image types
 * are accepted too; anything else is refused so /api/raw never becomes a
 * general file-download endpoint.
 */
const STATIC_ASSET_TYPES = {
  ...IMAGE_TYPES,
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

export async function handleRequest(req, res, state) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let pathname = url.pathname
    const at = pathname.indexOf(ROUTE)
    if (at >= 0) pathname = pathname.slice(at + ROUTE.length)
    if (!pathname.startsWith('/')) pathname = '/' + pathname

    if (pathname.startsWith('/vendor/')) return serveVendor(res, state, pathname.slice('/vendor/'.length))
    if (pathname === '/api/ping') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        route: ROUTE,
        packageDir: state.packageDir,
        startedAt: state.startedAt || '',
        clientBuild: clientBuild(state).build,
      })
    }
    if (!pathname.startsWith('/api/')) return sendError(res, 404, 'not found')

    if (pathname === '/api/meta' && req.method === 'GET') return sendJson(res, 200, state.meta())
    if (pathname === '/api/roots' && req.method === 'POST') return await apiRoots(req, res, state)
    if (pathname === '/api/list' && req.method === 'GET') return apiList(res, state, url)
    if (pathname === '/api/markdown' && req.method === 'GET') return apiMarkdown(res, state, url)
    if (pathname === '/api/code' && req.method === 'GET') return apiCode(res, state, url)
    if (pathname === '/api/exists' && req.method === 'GET') return apiExists(res, state, url)
    if (pathname === '/api/raw' && req.method === 'GET') return apiRaw(res, state, url)
    if (pathname === '/api/html' && req.method === 'GET') return apiHtml(res, state, url)
    if (pathname === '/api/search' && req.method === 'GET') return apiSearch(res, state, url)
    if (pathname === '/api/files' && req.method === 'GET') return apiFiles(res, state, url)
    if (pathname === '/api/def' && req.method === 'POST') return await apiDef(req, res, state)
    if (pathname === '/api/client-build' && req.method === 'GET') return sendJson(res, 200, clientBuild(state))
    if (pathname === '/api/client-ping' && req.method === 'POST') return await apiClientPing(req, res, state)
    if (pathname === '/api/client-ping' && req.method === 'GET') return sendJson(res, 200, { ok: true, last: state.lastClientBuild || null })
    if (pathname === '/api/sync/status' && req.method === 'GET') return sendJson(res, 200, await syncStatus(state, url.searchParams.get('fetch') === '1'))
    if (pathname === '/api/sync/pull' && req.method === 'POST') return sendJson(res, 200, await syncPull(state))
    if (pathname === '/api/git/graph' && req.method === 'GET') return sendJson(res, 200, await gitGraph(state, url))
    if (pathname === '/api/git/resolve' && req.method === 'GET')
      return sendJson(res, 200, { ok: true, resolved: await resolveRepoUrls(state, url.searchParams.getAll('url'), url.searchParams.get('path') || '') })
    // The same, with the URL list in the BODY: a document with a hundred
    // repository links does not fit into a request line (16 KB of headers ->
    // 431 Request Header Fields Too Large, and then NOT ONE link of the
    // document was resolved).
    if (pathname === '/api/git/resolve' && req.method === 'POST')
      return sendJson(res, 200, await apiGitResolvePost(req, res, state))
    if (pathname === '/api/git/repos' && req.method === 'GET')
      return sendJson(res, 200, { ok: true, repos: listRepos(state, projectRoots(state, url.searchParams.get('project'))) })
    if (pathname === '/api/git/meta' && req.method === 'GET') return await apiGitMeta(res, state, url)
    if (pathname === '/api/git/file' && req.method === 'GET') return await apiGitFile(res, state, url)
    if (pathname === '/api/git/diff' && req.method === 'GET') return await apiGitDiff(res, state, url)
    // A repository link whose project is not in the workspace: fetch the file
    // from the remote (through git - the web endpoints do not accept the
    // account password the remotes carry) and show it in the code popup.
    if (pathname === '/api/git/remote-file' && req.method === 'GET')
      return sendJson(res, 200, await apiGitRemoteFile(state, url))

    return sendError(res, 404, `unknown endpoint: ${pathname}`)
  } catch (error) {
    try {
      sendError(res, 400, error && error.message ? error.message : String(error))
    } catch {
      // response already gone
    }
  }
}

function serveVendor(res, state, name) {
  if (!VENDOR_WHITELIST.has(name)) return sendError(res, 404, 'not found')
  return sendFile(res, path.join(state.packageDir, 'vendor', name))
}

/**
 * The build id of the client bundle that is on disk right now.
 *
 * The Harness serves plugin clients as an immutable, one-year-cached asset and
 * only re-reads the bytes when the plugin is re-registered, so a rebuilt
 * client.js can stay invisible to a browser that already loaded the plugin.
 * The client compares this id with its own BUILD_ID and reloads itself when
 * they differ, and reports what it actually loaded to `/api/client-ping` - so
 * "which build is the browser running" is answerable instead of guessed.
 */
function clientBuild(state) {
  try {
    const file = path.join(state.packageDir, 'client.build.json')
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ok: true,
      build: meta.build || '',
      at: meta.at || '',
      bytes: meta.bytes || 0,
      // What the Harness has actually REGISTERED (see ACTIVATION_BUILD): the
      // client must not reload while the two differ, or the boot fetches a
      // stale bundle URL and the import fails.
      registered: ACTIVATION_BUILD,
    }
  } catch {
    return { ok: true, build: '', at: '', bytes: 0, registered: ACTIVATION_BUILD }
  }
}

/** Remember which client build a browser actually loaded. */
async function apiClientPing(req, res, state) {
  const body = JSON.parse((await readBody(req)) || '{}')
  // MERGE, do not replace: the client reports the DOM scope and the markdown
  // render in separate pings, and the latest one must not erase the other.
  const last = {
    ...(state.lastClientBuild || {}),
    build: String(body.build || (state.lastClientBuild && state.lastClientBuild.build) || ''),
    at: new Date().toISOString(),
  }
  if (body.md) {
    // What the markdown view did with a document: fence count, diff blocks,
    // duration and any error. The diff rendering happens in the client, so
    // this is the only way to see what the running app actually did.
    last.md = body.md
  }
  if (body.dom) {
    // The DOM scope the panel lives in (shadow root or not) and which nodes
    // carry a copy confirmation - the facts behind "this overlay shows up at
    // the bottom of the Harness window".
    last.dom = body.dom
  }
  if (body.git) {
    // Default-open-branch diagnostics: the remembered map plus the last
    // decision/write made by the running page ("重开没按我切的分支" needs the
    // facts from the browser, not from the sources).
    last.git = body.git
  }
  state.lastClientBuild = last
  return sendJson(res, 200, { ok: true, last: state.lastClientBuild })
}

async function apiRoots(req, res, state) {
  const body = JSON.parse((await readBody(req)) || '{}')
  const action = String(body.action || '')
  if (action === 'add') return sendJson(res, 200, { ...state.addRoot(body.path), roots: state.roots(), single: state.single() })
  if (action === 'remove') return sendJson(res, 200, { ...state.removeRoot(body.path), roots: state.roots(), single: state.single() })
  throw new Error(`unknown action: ${action}`)
}

function apiList(res, state, url) {
  const rel = url.searchParams.get('path') || ''
  // Multi-root: the virtual top level lists one directory per workspace root.
  if (!rel && !state.single()) {
    const entries = state
      .roots()
      .map((root) => ({ name: root.name, path: root.name, dir: true, ext: '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return sendJson(res, 200, { ok: true, path: '', entries })
  }
  const abs = state.safePath(rel)
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw new Error(`目录不存在: ${rel}`)
  }
  if (!stat.isDirectory()) throw new Error(`不是目录: ${rel}`)
  const entries = []
  for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (dirent.name.startsWith('.') || HIDDEN_DIR_NAMES.has(dirent.name)) continue
    const childAbs = path.join(abs, dirent.name)
    let isDir = dirent.isDirectory()
    if (!isDir && !dirent.isFile()) continue
    if (isDir && entries.length > 4000) break
    entries.push({
      name: dirent.name,
      path: state.relOf(childAbs),
      dir: isDir,
      ext: isDir ? '' : path.extname(dirent.name).toLowerCase(),
    })
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))
  return sendJson(res, 200, { ok: true, path: state.relOf(abs), entries })
}

function readTextFile(abs) {
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > 32 * 1024 * 1024) throw new Error('文件过大（>32MB）')
  const buffer = fs.readFileSync(abs)
  if (buffer.includes(0)) throw new Error('二进制文件不支持文本查看')
  return buffer.toString('utf8')
}

function apiMarkdown(res, state, url) {
  const rel = url.searchParams.get('path') || ''
  if (!rel) throw new Error('缺少 path')
  const abs = state.safePath(rel)
  const content = readTextFile(abs)
  return sendJson(res, 200, { ok: true, path: state.relOf(abs), content })
}

function apiCode(res, state, url) {
  const rel = url.searchParams.get('path') || ''
  if (!rel) throw new Error('缺少 path')
  const abs = state.safePath(rel)
  const content = readTextFile(abs)
  const ext = path.extname(abs).toLowerCase()
  const resolved = state.relOf(abs)
  // A code file is about to be ctrl+clicked: warm the java class index for its
  // root in a worker thread, so the first jump is instant instead of building
  // the index (up to ~2 s on a monorepo) inside the Harness main process.
  if (ext === '.java') prewarmDefIndex(state, resolved)
  return sendJson(res, 200, {
    ok: true,
    path: resolved,
    content,
    lang: ext.replace(/^\./, ''),
    lineCount: content.split('\n').length,
  })
}

/**
 * Resolved paths, cached for a minute.
 *
 * Every mount of a document asks for the same bare paths ("切任务" re-mounts
 * the document), and each miss costs a filesystem lookup plus a basename search.
 * The cache turns the repeated question into a map lookup.
 */
const existsCache = new Map()
const EXISTS_CACHE_TTL = 60000

function apiExists(res, state, url) {
  const inputs = url.searchParams.getAll('path')
  const from = url.searchParams.get('from') || ''
  const preferredRoot = preferredRootFor(state, from)
  const results = {}
  const now = Date.now()
  for (const input of inputs) {
    const text = String(input || '')
    if (!text) {
      results[input] = { abs: null, exists: false }
      continue
    }
    const cacheKey = `${from}|${text}`
    const cached = existsCache.get(cacheKey)
    if (cached && now - cached.at < EXISTS_CACHE_TTL) {
      results[input] = { abs: cached.abs, exists: cached.exists }
      continue
    }
    let abs = null
    try {
      abs = state.safePath(text)
    } catch {
      abs = null
    }
    let found = null
    if (abs && fs.existsSync(abs)) {
      found = state.relOf(abs)
    } else {
      const hit = searchByBasename(state, text, preferredRoot)
      if (hit) found = state.relOf(hit)
    }
    const entry = found ? { abs: found, exists: true } : { abs: null, exists: false }
    existsCache.set(cacheKey, { abs: entry.abs, exists: entry.exists, at: now })
    results[input] = entry
  }
  // The basename index may still be building: the client asks again when it
  // was not ready, so the bare paths become links a moment later.
  return sendJson(res, 200, { ok: true, results, indexReady: nameIndexReady(state) })
}

/** Root that owns the requesting document (`from`), or null. */
function preferredRootFor(state, from) {
  if (!from) return null
  try {
    const root = state.rootForAbs(state.safePath(from))
    return root ? root.path : null
  } catch {
    return null
  }
}

/**
 * Basename -> absolute paths index for one workspace root.
 *
 * Bounded depth is the reason this index exists: a fixed per-root depth silently
 * lost every Java file under `gits/<svc>/src/main/java/...` (10+ levels), so the
 * reader could not resolve the bare filenames docs cite in tables while it did
 * resolve shallower `.xml` mappers. Indexing once also keeps a doc with dozens of
 * bare paths from running dozens of directory walks.
 *
 * The walk is BIG (the 微服务 workspace holds >400k files and the walk took ~6 s
 * in Node). Building it inside a request BLOCKED the whole Host: every other
 * API call queued behind it, so opening a document felt like the app was
 * hanging ("切任务加载文档速度慢"). Therefore:
 *  - the index is built in the BACKGROUND, in chunks, yielding to the event loop
 *    between chunks, so the Host keeps answering requests;
 *  - it is PERSISTED on disk, so the next app start loads it in ~100 ms instead
 *    of walking the workspace again;
 *  - the request answers with what it knows and tells the client whether the
 *    index was ready (`indexReady`), and the client asks again when it was not.
 */
const nameIndex = { at: 0, key: '', map: new Map(), building: false, ready: false, pending: null }
const NAME_INDEX_TTL = 10 * 60 * 1000
/** Layout version of the cache file: bump it when the walk or the format
 *  changes, so the stale cache is ignored and the worker rebuilds it. */
const NAME_INDEX_VERSION = 'v2'
/** How many names are kept. The full index of the 微服务 workspace holds tens
 *  of thousands of entries; the worker writes the capped set to disk and hands
 *  the same set to the main thread, so neither side holds a huge map. */
const NAME_INDEX_MAX_SAVED = 20000

/** Where the index is cached between app runs. */
function nameIndexFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'markdown-reader.nameindex.tsv')
}

/** The identity of the current roots: a different set of roots needs a new index. */
function nameIndexKey(state) {
  return state.roots().map((root) => root.path).join('|')
}

/**
 * Load the persisted index (fast path: no walk at all).
 *
 * The file is a TSV (`<at>\t<key>\n<name>\t<path>\n...`): a compact format
 * that can be read line by line without parsing a huge JSON string.
 */
function loadNameIndexFromDisk(state) {
  if (nameIndex.map.size) return nameIndex.map
  try {
    const raw = fs.readFileSync(nameIndexFile(), 'utf8')
    const lines = raw.split('\n')
    const header = (lines.shift() || '').split('\t')
    const at = Number(header[0])
    const key = header[1] || ''
    // A cache written by an older layout (or an older walk order) is ignored:
    // the worker rebuilds it. Without this a stale cache keeps the resolver
    // blind for the whole TTL.
    if (header[2] !== NAME_INDEX_VERSION) return nameIndex.map
    if (!at || key !== nameIndexKey(state)) return nameIndex.map
    if (Date.now() - at > NAME_INDEX_TTL) return nameIndex.map
    const map = new Map()
    for (const line of lines) {
      if (!line) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      map.set(line.slice(0, tab), line.slice(tab + 1))
      if (map.size >= NAME_INDEX_MAX_SAVED) break
    }
    if (!map.size) return nameIndex.map
    nameIndex.at = at
    nameIndex.key = key
    nameIndex.map = map
    nameIndex.ready = true
  } catch {
    // No cache yet: the background build will create it.
  }
  return nameIndex.map
}

/**
 * Build the index in a WORKER THREAD.
 *
 * The Host runs in the Harness's MAIN process - the same process that serves
 * the app's web requests and the plugin client bundles. Walking the workspace
 * there blocked that process for seconds, and the app's own boot then failed
 * to fetch the plugin bundle ("Failed to fetch" -> "web boot: 1 entry did not
 * activate" -> the crash dialog). A worker leaves the main thread free: the
 * tree listing, the markdown fetch and the boot's bundle request are served
 * immediately, and the reader feels instant again.
 */
async function buildNameIndexAsync(state) {
  if (nameIndex.building) return nameIndex.pending
  nameIndex.building = true
  const key = nameIndexKey(state)
  const pending = (async () => {
    const roots = state.roots().map((root) => root.path)
    const entries = await runNameIndexWorker(roots, key)
    if (!entries || !entries.length) return
    const map = new Map()
    for (const item of entries) {
      if (!Array.isArray(item) || item.length !== 2) continue
      map.set(String(item[0]), String(item[1]))
    }
    if (!map.size) return
    nameIndex.at = Date.now()
    nameIndex.key = key
    nameIndex.map = map
    nameIndex.ready = true
    // The misses cached while the index was building may be hits now.
    existsCache.clear()
  })()
    .catch(() => {})
    .finally(() => {
      nameIndex.building = false
    })
  nameIndex.pending = pending
  return pending
}

/** Run the index worker and hand back its entries. */
function runNameIndexWorker(roots, key) {
  return new Promise((resolve) => {
    let worker = null
    try {
      worker = new Worker(new URL('./nameindex-worker.js', import.meta.url), {
        workerData: { roots, key, version: NAME_INDEX_VERSION, cacheFile: nameIndexFile() },
      })
    } catch {
      resolve([])
      return
    }
    let done = false
    const finish = (entries) => {
      if (done) return
      done = true
      try {
        worker.terminate()
      } catch {
        /* already gone */
      }
      resolve(entries || [])
    }
    worker.on('message', (message) => finish((message && message.entries) || []))
    worker.on('error', () => finish([]))
    worker.on('exit', () => finish([]))
  })
}

/** The index (possibly still being built) + whether it is complete. */
function fileNameIndex(state) {
  loadNameIndexFromDisk(state)
  const key = nameIndexKey(state)
  if (nameIndex.map.size && nameIndex.key !== key) {
    // The roots changed: the old index does not describe this workspace.
    nameIndex.map = new Map()
    nameIndex.ready = false
  }
  if (!nameIndex.map.size && !nameIndex.building) {
    // Start the walk right away; the request does NOT wait for it.
    buildNameIndexAsync(state)
  }
  return nameIndex.map
}

/** Is the index complete? (The client asks again when it is not.) */
function nameIndexReady(state) {
  loadNameIndexFromDisk(state)
  if (!nameIndex.map.size && !nameIndex.building) buildNameIndexAsync(state)
  return nameIndex.ready
}

/** Resolve a bare (or partly wrong) citation by filename, preferring the doc's own root. */
function searchByBasename(state, rel, preferredRoot) {
  const base = path.basename(String(rel).replace(/\\/g, '/'))
  if (!base) return null
  const hit = fileNameIndex(state).get(base)
  if (!hit) return null
  if (preferredRoot && (hit.startsWith(preferredRoot + path.sep) || hit === path.join(preferredRoot, base))) {
    return hit
  }
  return hit
}

function apiRaw(res, state, url) {
  const rel = url.searchParams.get('path') || ''
  if (!rel) throw new Error('缺少 path')
  const abs = state.safePath(rel)
  const ext = path.extname(abs).toLowerCase()
  const type = STATIC_ASSET_TYPES[ext]
  if (!type) return sendError(res, 415, '该文件类型不支持预览/引用')
  const body = fs.readFileSync(abs)
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
  })
  res.end(body)
  return undefined
}

function apiHtml(res, state, url) {
  const html = renderHtmlPreview(state, url.searchParams.get('path') || '')
  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ------------------------------------------------------------ search & index

const SKIP_DIRS = new Set(['.git', 'node_modules', '.mmd-cache', '__pycache__', '.idea', '.next', 'dist', 'build', 'target', '.gradle', '.venv', 'venv'])

/** Roots addressed by the optional `project=<vtop>` scope (absent/__all__ = all). */
function projectRoots(state, project) {
  const name = String(project || '').trim()
  if (!name || name === '__all__') return state.roots()
  return state.roots().filter((root) => root.name === name)
}

/** Bounded depth-first walk shared by search and quick open. */
function walkWorkspace(state, roots, options, visit) {
  const maxDepth = options.maxDepth || 10
  const maxFiles = options.maxFiles || 30000
  const budgetMs = options.budgetMs || 2500
  const started = Date.now()
  let files = 0
  let truncated = false
  const stack = []
  for (const root of roots && roots.length ? roots : state.roots()) stack.push({ dir: root.path, depth: 0 })
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (files >= maxFiles || Date.now() - started > budgetMs) {
        truncated = true
        return { files, truncated }
      }
      if (dirent.name.startsWith('.') && dirent.name !== '.gitignore') continue
      if (SKIP_DIRS.has(dirent.name) || HIDDEN_DIR_NAMES.has(dirent.name)) continue
      const abs = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: abs, depth: depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      const ext = path.extname(dirent.name).toLowerCase()
      if (!TEXT_EXTS.has(ext) && ext !== '') continue
      files += 1
      visit(abs, state.relOf(abs), ext)
    }
  }
  return { files, truncated }
}

function apiSearch(res, state, url) {
  const query = (url.searchParams.get('q') || '').trim()
  if (query.length < 2) throw new Error('搜索词至少 2 个字符')
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit') || '120')))
  const caseSensitive = url.searchParams.get('case') === '1'
  const needle = caseSensitive ? query : query.toLowerCase()
  const results = []
  let scanned = 0
  const roots = projectRoots(state, url.searchParams.get('project'))
  const walkResult = walkWorkspace(state, roots, { maxFiles: 12000, maxDepth: 12, budgetMs: 3500 }, (abs, rel, ext) => {
    if (results.length >= limit) return
    let text
    try {
      const stat = fs.statSync(abs)
      if (stat.size > 2 * 1024 * 1024) return
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      return
    }
    scanned += 1
    if (text.includes('\u0000')) return
    const haystack = caseSensitive ? text : text.toLowerCase()
    let from = 0
    while (results.length < limit) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      const lineStart = text.lastIndexOf('\n', at) + 1
      const lineEnd = text.indexOf('\n', at)
      const lineNo = text.slice(0, at).split('\n').length
      const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim()
      const column = at - lineStart + 1
      results.push({ path: rel, line: lineNo, column, text: lineText.slice(0, 400) })
      from = at + Math.max(1, needle.length)
    }
  })
  return sendJson(res, 200, { ok: true, query, results, scanned, truncated: walkResult.truncated })
}

let quickIndex = { at: 0, key: '', items: [] }

function quickIndexItems(state, roots) {
  const key = (roots && roots.length ? roots : state.roots()).map((root) => root.path).join('|')
  if (Date.now() - quickIndex.at < 60000 && quickIndex.key === key) return quickIndex.items
  const items = []
  walkWorkspace(state, roots, { maxFiles: 30000, maxDepth: 14, budgetMs: 4000 }, (abs, rel) => {
    items.push({ path: rel, name: path.basename(abs), dir: path.dirname(rel).replace(/\\/g, '/') })
  })
  quickIndex = { at: Date.now(), key, items }
  return items
}

function apiFiles(res, state, url) {
  const query = (url.searchParams.get('q') || '').trim()
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || '40')))
  const items = quickIndexItems(state, projectRoots(state, url.searchParams.get('project')))
  const lower = query.toLowerCase()
  const scored = []
  for (const item of items) {
    const name = item.name.toLowerCase()
    const rel = item.path.toLowerCase()
    let score = -1
    if (!lower) score = 0
    else if (name === lower) score = 0
    else if (name.startsWith(lower)) score = 1
    else if (name.includes(lower)) score = 2
    else if (rel.includes(lower)) score = 3
    if (score >= 0) scored.push({ score, item })
  }
  scored.sort((a, b) => (a.score - b.score) || a.item.path.localeCompare(b.item.path, 'zh'))
  return sendJson(res, 200, {
    ok: true,
    total: scored.length,
    items: scored.slice(0, limit).map((entry) => entry.item),
  })
}

// --------------------------------------------------------- symbol definitions

/**
 * POST /api/def — v2 single-target "go to definition" contract.
 *
 * Request: { path, line, col, name, kind, text?, branch?, commit? }
 *   - `kind`: method | type | variable | constant | '' (auto: method→type→variable)
 *   - `text` is the client's current view text (commit/branch views send that
 *     revision's text); when absent the Host reads the workspace file / git blob.
 * Success: { ok, file, line, kind, defName, impl }
 * Not found: HTTP 400 { ok: false, error } (error text is shown by the client).
 *
 * The standalone v1 client sent `{ path, symbol, context }`; that shape is still
 * accepted (line/col derived from the context line) while the web client lands.
 */
async function apiDef(req, res, state) {
  const body = JSON.parse((await readBody(req)) || '{}')
  const result = resolveDefinition(state, body)
  if (!result || result.error) {
    return sendJson(res, 400, { ok: false, error: (result && result.error) || '未找到定义' })
  }
  return sendJson(res, 200, {
    ok: true,
    file: result.file,
    line: result.line,
    kind: result.kind,
    defName: result.defName,
    impl: result.impl || null,
  })
}

// ---------------------------------------------------------------- git (read-only)

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

function findGitRoot(abs) {
  let dir = abs
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
  } catch {
    dir = path.dirname(dir)
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function gitTarget(state, url) {
  const rel = url.searchParams.get('path') || ''
  if (!rel) throw new Error('缺少 path')
  const abs = state.safePath(rel)
  const repo = findGitRoot(abs)
  if (!repo) throw new Error('该文件不在 git 仓库内')
  const relInRepo = path.relative(repo, abs).replace(/\\/g, '/')
  return { abs, repo, relInRepo }
}

/**
 * The branches that CONTAIN a commit.
 *
 * A link that pins a commit (GitLab permalink `.../-/blob/<sha>/…`) belongs to
 * a branch, and the popup has to show THAT branch: a document with a CK and a
 * TH link pins commits on two different branches, and showing the local
 * checkout's branch for both was wrong (user: 「打开ck和th两个环境的代码链接，
 * 显示的分支都是同一个」, 2026-11-25).
 *
 * The remote-tracking branches are included (a branch that only exists on the
 * remote is still the branch the commit belongs to); the `origin/` prefix is
 * dropped so the name matches the one the dropdown shows.
 *
 * @returns {Promise<string[]>} the branch names, empty when the commit is not
 *   in the local object store.
 */
async function branchesContaining(repo, commit) {
  if (!repo || !commit) return []
  let out = ''
  try {
    out = await git(repo, [
      'for-each-ref',
      '--contains',
      commit,
      '--format=%(refname:short)',
      'refs/heads/',
      'refs/remotes/',
    ])
  } catch {
    return []
  }
  const names = []
  for (const line of out.split(/\r?\n/)) {
    let name = String(line || '').trim()
    if (!name) continue
    if (name.startsWith('origin/')) name = name.slice('origin/'.length)
    if (!name || name === 'HEAD') continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

async function apiGitMeta(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const branchParam = url.searchParams.get('branch') || ''
  const commitParam = url.searchParams.get('commit') || ''
  const currentBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const branchText = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  const branches = branchText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (currentBranch && !branches.includes(currentBranch)) branches.unshift(currentBranch)
  // The REQUESTED branch wins - even when the local clone does not have it
  // (it may exist on the remote, and the link's ref is authoritative). It used
  // to be silently replaced by the local branch, so a link to another branch
  // showed the checkout's content.
  const branch = branchParam || currentBranch
  const remote = !!(branchParam && !branches.includes(branchParam))
  if (remote) branches.push(branchParam)
  // The branches of a pinned commit (the popup shows the branch of the commit,
  // not the branch of the checkout).
  const contains = commitParam ? await branchesContaining(repo, commitParam) : []
  for (const name of contains) {
    if (!branches.includes(name)) branches.push(name)
  }
  let commits = []
  try {
    const logText = await git(repo, [
      'log',
      '--pretty=format:%H|%an|%ad|%s',
      '--date=format:%Y-%m-%d %H:%M',
      '-20',
      branch,
      '--',
      relInRepo,
    ])
    commits = logText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, ...subject] = line.split('|')
        return { hash, short: hash.slice(0, 7), author, date, subject: subject.join('|') }
      })
  } catch {
    // The branch is not in the local object store (a remote-only branch): the
    // file itself is fetched from the remote, the commit list stays empty.
    commits = []
  }
  return sendJson(res, 200, {
    ok: true,
    path: state.relOf(abs),
    repo: state.relOf(repo),
    branch,
    currentBranch,
    branches,
    commits,
    // The branch is not in the local clone (it exists on the remote only).
    remote,
    // The branches that contain the requested commit.
    contains,
  })
}

async function apiGitFile(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const commit = url.searchParams.get('commit') || ''
  if (!commit) throw new Error('缺少 commit')
  try {
    const content = await git(repo, ['show', `${commit}:${relInRepo}`])
    return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, content, source: 'local' })
  } catch {
    // The ref is not in the local object store (a branch or a commit that only
    // exists on the remote): the LINK's remote is authoritative, so the file is
    // read from the remote - without touching the local clone (a `--depth 1`
    // fetch into it would turn the clone into a shallow repository).
    const remote = await readRemoteFile(repo, commit, relInRepo)
    if (remote != null) {
      return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, content: remote, source: 'remote' })
    }
    return sendJson(res, 404, { ok: false, error: '该提交中不存在此文件', path: state.relOf(abs), commit })
  }
}

/**
 * Resolve a batch of repository links whose URL list comes in the body.
 *
 * The URL list of a link-heavy document does not fit into a request line
 * (the server answers 431 when the headers get too big), and then the whole
 * batch fails: every link of the document stays a plain web link.
 */
async function apiGitResolvePost(req, res, state) {
  let body = {}
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    return { ok: false, error: 'invalid body', resolved: {} }
  }
  const urls = Array.isArray(body.urls) ? body.urls.map((item) => String(item || '')).filter(Boolean) : []
  const resolved = await resolveRepoUrls(state, urls, String(body.path || ''))
  return { ok: true, resolved }
}

/**
 * Fetch a file from a REMOTE repository.
 *
 * The link points at a project that is not in the workspace (or at a file the
 * workspace does not have): the code is fetched through git and shown in the
 * code popup instead of opening the web page.
 */
async function apiGitRemoteFile(state, url) {
  const target = String(url.searchParams.get('url') || '').trim()
  if (!target) return { ok: false, error: '缺少 url' }
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http(s) 链接' }
  try {
    const result = await fetchRemoteFile(state, target)
    if (!result.ok) return result
    return {
      ok: true,
      path: result.path,
      ref: result.ref,
      repo: result.repo,
      line: result.line || 0,
      source: result.source,
      content: result.content,
      lineCount: String(result.content || '').split('\n').length,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

async function apiGitDiff(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const commit = url.searchParams.get('commit') || ''
  if (!commit) throw new Error('缺少 commit')
  let patch = ''
  try {
    // `--first-parent`: a MERGE commit has no diff by default, and the CK/TH
    // links of the docs pin exactly those (the merge of the day). The diff
    // against the first parent is what the repository shows as "Changes".
    patch = await git(repo, ['show', '--first-parent', '--format=', '--patch', '--unified=3', commit, '--', relInRepo])
  } catch (error) {
    // The commit is not in the local object store: read the patch from the
    // remote (the link's remote is authoritative).
    const remotePatch = await remotePatchOf(repo, commit, relInRepo)
    if (remotePatch != null) {
      return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, hunks: parseDiff(remotePatch), source: 'remote' })
    }
    return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, hunks: [], error: String(error.message || error) })
  }
  return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, hunks: parseDiff(patch), source: 'local' })
}

/** The patch of a commit that the local repository does not have. */
async function remotePatchOf(repo, commit, relInRepo) {
  return readRemotePatch(repo, commit, relInRepo)
}

/**
 * Is this line a FILE HEADER of a diff (`--- a/x`, `+++ b/x`, `--- /dev/null`)?
 *
 * The shape decides, not the counts of the hunk header: the counts are only a
 * hint (hand-written diffs declare them wrong), and a hunk whose counts are too
 * small would otherwise swallow the file header of the next file.
 */
function isDiffFileHeaderLine(line) {
  return /^(---|\+\+\+) (a\/|b\/|\/dev\/null)/.test(String(line == null ? '' : line))
}

/**
 * Parse a unified diff into hunks.
 *
 * Boundary rules (the same as the client's markdown diff-fence parser):
 *  - a hunk body runs until the next `@@` header, the next `diff --git`
 *    (a new file) or the FILE HEADER of the next file (`--- a/x`, `+++ b/x`,
 *    `--- /dev/null`). The counts in the hunk header are a HINT, not a hard
 *    boundary: hand-written diffs in design docs routinely declare the wrong
 *    counts, and cutting the body there loses the tail of the change.
 *  - an empty line inside a hunk body is a context row, it does not end the
 *    hunk.
 *  - trailing blank lines are stripped first: `git show --patch` output ends
 *    with a newline, so splitting it yields a trailing empty line that would
 *    otherwise become a phantom row - and that phantom row consumed a REAL
 *    line of the commit-version file, so the line right after a hunk rendered
 *    empty (the 2026-11-05 bug).
 */
export function parseDiff(patch) {
  const hunks = []
  const text = String(patch == null ? '' : patch).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  let current = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[3])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      current = {
        old_start: oldNo,
        new_start: newNo,
        old_count: oldLeft,
        new_count: newLeft,
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current) {
      if (line.startsWith('diff --git ')) {
        current = null
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" - not a body line, but it does NOT end
        // the hunk either.
        continue
      } else if (isDiffFileHeaderLine(line)) {
        // The file header of the next file ends this hunk.
        current = null
      } else {
        const kind = line[0]
        if (kind === '+') {
          current.lines.push({ type: '+', text: line.slice(1), old_no: null, new_no: newNo })
          newNo += 1
          if (newLeft > 0) newLeft -= 1
          continue
        }
        if (kind === '-') {
          current.lines.push({ type: '-', text: line.slice(1), old_no: oldNo, new_no: null })
          oldNo += 1
          if (oldLeft > 0) oldLeft -= 1
          continue
        }
        current.lines.push({ type: ' ', text: line.slice(1), old_no: oldNo, new_no: newNo })
        oldNo += 1
        newNo += 1
        if (oldLeft > 0) oldLeft -= 1
        if (newLeft > 0) newLeft -= 1
        continue
      }
    }
    if (!current) continue
  }
  return hunks
}

export { CODE_EXTS, MARKDOWN_EXTS }
