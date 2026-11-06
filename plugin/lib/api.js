/**
 * Host HTTP API for the Markdown Reader plugin.
 *
 * Everything the page needs is served from one same-origin prefix route:
 * workspace roots, directory listing, markdown/code text, path resolution and
 * read-only git views. No client ever runs a shell command.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROUTE, VERSION } from './constants.js'
import { sendJson, sendError, sendFile, readBody } from './http.js'
import { CODE_EXTS, MARKDOWN_EXTS, HIDDEN_DIR_NAMES } from './state.js'
import { resolveDefinition } from './defs.js'
import { syncStatus, syncPull } from './sync.js'
import { gitGraph, listRepos } from './gitgraph.js'
import { renderHtmlPreview } from './htmlpreview.js'
import { resolveRepoUrls } from './gitlinks.js'

const execFileAsync = promisify(execFile)

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
      return sendJson(res, 200, { ok: true, version: VERSION, route: ROUTE, packageDir: state.packageDir })
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
    if (pathname === '/api/sync/status' && req.method === 'GET') return sendJson(res, 200, await syncStatus(state, url.searchParams.get('fetch') === '1'))
    if (pathname === '/api/sync/pull' && req.method === 'POST') return sendJson(res, 200, await syncPull(state))
    if (pathname === '/api/git/graph' && req.method === 'GET') return sendJson(res, 200, await gitGraph(state, url))
    if (pathname === '/api/git/resolve' && req.method === 'GET')
      return sendJson(res, 200, { ok: true, resolved: await resolveRepoUrls(state, url.searchParams.getAll('url'), url.searchParams.get('path') || '') })
    if (pathname === '/api/git/repos' && req.method === 'GET')
      return sendJson(res, 200, { ok: true, repos: listRepos(state, projectRoots(state, url.searchParams.get('project'))) })
    if (pathname === '/api/git/meta' && req.method === 'GET') return await apiGitMeta(res, state, url)
    if (pathname === '/api/git/file' && req.method === 'GET') return await apiGitFile(res, state, url)
    if (pathname === '/api/git/diff' && req.method === 'GET') return await apiGitDiff(res, state, url)

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
  return sendJson(res, 200, {
    ok: true,
    path: state.relOf(abs),
    content,
    lang: ext.replace(/^\./, ''),
    lineCount: content.split('\n').length,
  })
}

function apiExists(res, state, url) {
  const inputs = url.searchParams.getAll('path')
  const from = url.searchParams.get('from') || ''
  const preferredRoot = preferredRootFor(state, from)
  const results = {}
  for (const input of inputs) {
    const text = String(input || '')
    if (!text) {
      results[input] = { abs: null, exists: false }
      continue
    }
    let abs = null
    try {
      abs = state.safePath(text)
    } catch {
      abs = null
    }
    if (!abs || !fs.existsSync(abs)) {
      const hit = searchByBasename(state, text, preferredRoot)
      if (hit) {
        results[input] = { abs: state.relOf(hit), exists: true }
        continue
      }
      results[input] = { abs: null, exists: false }
      continue
    }
    results[input] = { abs: state.relOf(abs), exists: true }
  }
  return sendJson(res, 200, { ok: true, results })
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
 */
const nameIndex = { at: 0, key: '', map: new Map() }
const NAME_INDEX_TTL = 90000
const NAME_INDEX_MAX_FILES = 400000
const NAME_INDEX_MAX_DEPTH = 18

function fileNameIndex(state) {
  const key = state.roots().map((root) => root.path).join('|')
  if (nameIndex.map.size && Date.now() - nameIndex.at < NAME_INDEX_TTL && nameIndex.key === key) return nameIndex.map
  const map = new Map()
  let files = 0
  const stack = state.roots().map((root) => ({ dir: root.path, depth: 0 }))
  while (stack.length && files < NAME_INDEX_MAX_FILES) {
    const { dir, depth } = stack.pop()
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || HIDDEN_DIR_NAMES.has(dirent.name)) continue
      const child = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < NAME_INDEX_MAX_DEPTH) stack.push({ dir: child, depth: depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      files += 1
      const bucket = map.get(dirent.name)
      if (bucket) bucket.push(child)
      else map.set(dirent.name, [child])
    }
  }
  nameIndex.at = Date.now()
  nameIndex.key = key
  nameIndex.map = map
  return map
}

/** Resolve a bare (or partly wrong) citation by filename, preferring the doc's own root. */
function searchByBasename(state, rel, preferredRoot) {
  const base = path.basename(String(rel).replace(/\\/g, '/'))
  if (!base) return null
  const hits = fileNameIndex(state).get(base)
  if (!hits || !hits.length) return null
  if (preferredRoot) {
    const inside = hits.find((hit) => hit.startsWith(preferredRoot + path.sep) || hit === path.join(preferredRoot, base))
    if (inside) return inside
  }
  // Shallowest first: a doc's citation means the top-level file, not a copy deep in target/.
  let best = hits[0]
  let bestDepth = best.split(path.sep).length
  for (const hit of hits) {
    const depth = hit.split(path.sep).length
    if (depth < bestDepth) {
      best = hit
      bestDepth = depth
    }
  }
  return best
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

async function apiGitMeta(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const branchParam = url.searchParams.get('branch') || ''
  const currentBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const branchText = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  const branches = branchText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (currentBranch && !branches.includes(currentBranch)) branches.unshift(currentBranch)
  const branch = branchParam && (branches.includes(branchParam) || branchParam === currentBranch) ? branchParam : currentBranch
  const logText = await git(repo, [
    'log',
    '--pretty=format:%H|%an|%ad|%s',
    '--date=format:%Y-%m-%d %H:%M',
    '-20',
    branch,
    '--',
    relInRepo,
  ])
  const commits = logText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...subject] = line.split('|')
      return { hash, short: hash.slice(0, 7), author, date, subject: subject.join('|') }
    })
  return sendJson(res, 200, {
    ok: true,
    path: state.relOf(abs),
    repo: state.relOf(repo),
    branch,
    currentBranch,
    branches,
    commits,
  })
}

async function apiGitFile(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const commit = url.searchParams.get('commit') || ''
  if (!commit) throw new Error('缺少 commit')
  try {
    const content = await git(repo, ['show', `${commit}:${relInRepo}`])
    return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, content })
  } catch {
    return sendJson(res, 404, { ok: false, error: '该提交中不存在此文件', path: state.relOf(abs), commit })
  }
}

async function apiGitDiff(res, state, url) {
  const { abs, repo, relInRepo } = gitTarget(state, url)
  const commit = url.searchParams.get('commit') || ''
  if (!commit) throw new Error('缺少 commit')
  let patch = ''
  try {
    patch = await git(repo, ['show', '--format=', '--patch', '--unified=3', commit, '--', relInRepo])
  } catch (error) {
    return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, hunks: [], error: String(error.message || error) })
  }
  return sendJson(res, 200, { ok: true, path: state.relOf(abs), commit, hunks: parseDiff(patch) })
}

/**
 * Parse a unified diff into hunks.
 *
 * Boundary rules (the same as the client's markdown diff-fence parser):
 *  - a hunk body runs until the next `@@` header or the next `diff --git`
 *    (a new file). The counts in the hunk header are a HINT, not a hard
 *    boundary: hand-written diffs in design docs routinely declare the wrong
 *    counts, and cutting the body there loses the tail of the change.
 *  - the counts are still used to recognise a FILE HEADER (`--- a/x`, `+++ b/x`)
 *    that follows a hunk, so a real `git diff` of several files still splits
 *    correctly.
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
      } else {
        const exhausted = oldLeft <= 0 && newLeft <= 0
        const boundary = exhausted && (line === '' || /^(--- |\+\+\+ )/.test(line))
        if (!boundary) {
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
        current = null
      }
    }
    if (!current) continue
  }
  return hunks
}

export { CODE_EXTS, MARKDOWN_EXTS }
