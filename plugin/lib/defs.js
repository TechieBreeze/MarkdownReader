/**
 * Single-target symbol resolution for Ctrl+click ("go to definition").
 *
 * The standalone tool's endpoint (`/api/java/def`) parsed Java with javalang and
 * returned ONE target (or an error). The plugin v1 only regex-scanned declaration
 * candidates, so clicking a local variable / enum constant / method returned
 * nothing. This module is the v2 resolver:
 *
 *   - Java: `javasym.js` builds the declaration/scope model; the resolution rules
 *     below mirror the standalone `server.py::_resolve_java_def` family —
 *     variable (locals/params/fields, `x.field` by receiver type), constant
 *     (enum / static final), type (local → imports/package/java.lang → interface
 *     impl), method (local → receiver type file → extends/implements chain up to
 *     3 levels → Lombok getter/setter/is → chain tail `a.b().c()`), and the
 *     auto-detect order method → type → variable when the client sends no kind.
 *   - Commit/branch views: file content is read with `git cat-file blob
 *     <rev>:<repo-relative path>`; a missing blob falls back to the workspace
 *     file like the original.
 *   - JS/TS/Vue: the original `/api/web/def` behaviour is preserved (relative /
 *     alias imports, named / default / namespace import symbols, local top-level
 *     declarations, Vue component tags) so web jumps do not regress.
 *
 * All filesystem/git access stays on Node built-ins. Results are cached per
 * process (class index, parsed models, git blobs) — never written to disk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import {
  parseJava,
  findConstDeclLineText,
  findMethodDeclText,
  findTypeDeclText,
  constReceiver,
  findMethodRefText,
  chainHeadIdent,
  getterFieldName,
  hasLombokAnnotation,
  findIdentTokenAt,
  isMethodDeclTokenToken,
  isConstructorDeclToken,
  isCallShaped,
  callQualifierFirstSegment,
  earliestMethodDecl,
  findTypeDecl,
  findFieldLines,
} from './javasym.js'

/* ---------------------------------------------------------------- constants */

// Same list as the standalone server: these packages mean "no local definition".
const JAVA_EXT_PKG_PREFIXES = [
  'java.', 'javax.', 'jdk.', 'sun.', 'com.baomidou', 'com.alibaba', 'org.', 'com.github',
  'lombok', 'io.', 'cn.', 'com.fasterxml', 'org.mybatis',
]

const JAVA_LANG_TYPES = new Set([
  'Object', 'String', 'StringBuilder', 'StringBuffer', 'CharSequence',
  'Integer', 'Long', 'Short', 'Byte', 'Double', 'Float', 'Boolean',
  'Character', 'Void', 'Number', 'Enum', 'Class', 'ClassLoader',
  'Thread', 'Runnable', 'ThreadLocal', 'System', 'Math', 'Process',
  'ProcessBuilder', 'Runtime', 'Package', 'Compiler', 'InheritableThreadLocal',
  'Throwable', 'Exception', 'RuntimeException', 'Error',
  'ArithmeticException', 'ArrayIndexOutOfBoundsException', 'ArrayStoreException',
  'ClassCastException', 'ClassNotFoundException', 'CloneNotSupportedException',
  'IllegalArgumentException', 'IllegalStateException', 'IndexOutOfBoundsException',
  'NegativeArraySizeException', 'NullPointerException', 'NumberFormatException',
  'SecurityException', 'UnsupportedOperationException',
  'StringIndexOutOfBoundsException', 'StackOverflowError', 'OutOfMemoryError',
  'Iterable', 'Comparable', 'Cloneable', 'AutoCloseable', 'Appendable',
  'StackTraceElement', 'Deprecated',
])

// Directory names neither scanned nor descended into while looking for sources.
const SEARCH_SKIP = new Set(['.git', '.idea', 'node_modules', '__pycache__', '.mvn', 'target'])
const REPO_SCAN_SKIP = new Set(['.git', '.idea', '.mvn', 'node_modules', '__pycache__', 'target', 'build', 'dist', 'src', 'out'])
const REPO_JAVA_ROOT_SKIP = new Set(['.git', 'target', 'node_modules', 'docs', 'doc'])
const CLASS_INDEX_SKIP = new Set(['target', 'node_modules', '.git', '.idea', 'build', 'dist', 'out'])

const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const MAX_TEXT_LEN = 5 * 1024 * 1024

/* ------------------------------------------------------------------- caches */

const cache = {
  repos: new Map(), // rootAbs -> { at, list }
  repoJavaRoots: new Map(), // repoAbs -> { at, list }
  classIndex: new Map(), // rootAbs -> { at, map }
  scopeClassIndex: new Map(), // moduleGroupAbs -> { at, map } (sibling modules of one repo)
  gitTree: new Map(), // `${repo}\u0000${rev}` -> { at, files }
  gitBlob: new Map(), // `${repo}\u0000${rev}\u0000${rel}` -> { at, content }
  models: new Map(), // content hash -> model
}

const REPO_TTL = 300000
const MODEL_CACHE_MAX = 256

function now() {
  return Date.now()
}

/** Small string hash for the parse cache. */
function hashText(text) {
  let hash = 2166136261
  const src = String(text || '')
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function parseModel(text, rel) {
  const key = hashText(text)
  const hit = cache.models.get(key)
  if (hit) return hit
  let model = null
  try {
    model = parseJava(text, rel)
  } catch {
    model = null
  }
  if (cache.models.size >= MODEL_CACHE_MAX) cache.models.clear()
  cache.models.set(key, model)
  return model
}

/* ------------------------------------------------------- fs / path helpers */

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile()
  } catch {
    return false
  }
}

function readDir(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
}

function realKey(abs) {
  try {
    const real = fs.realpathSync.native(abs)
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    const resolved = path.resolve(abs)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
}

function within(abs, rootAbs) {
  if (!abs || !rootAbs) return false
  const p = realKey(abs)
  const r = realKey(rootAbs)
  return p === r || p.startsWith(r + path.sep)
}

function sameReal(a, b) {
  if (!a || !b) return false
  return realKey(a) === realKey(b)
}

/**
 * `_root_for` + vtop stripping: which workspace root owns a client-visible path
 * and what the path is relative to that root. Mirrors the standalone semantics
 * (first path segment matching a virtual root name wins, otherwise root #1).
 */
function rootInfo(state, relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/')
  const parts = raw.split('/').filter((part) => part && part !== '.')
  const roots = state.roots()
  const first = parts[0]
  const named = state.single() ? null : roots.find((root) => root.name === first)
  if (named) return { rootAbs: named.path, rootName: named.name, relInRoot: parts.slice(1).join('/') }
  const rootAbs = roots.length ? roots[0].path : null
  const rootName = roots.length ? roots[0].name : ''
  return { rootAbs, rootName, relInRoot: parts.join('/') }
}

/**
 * Strict version of the standalone `safe_path`: only returns a path that exists
 * (or is a valid candidate under a root), trying every root for bare relative
 * paths. Returns null when nothing resolves.
 */
function resolveAbs(state, relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/')
  if (!raw) return null
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw)
    for (const root of state.roots()) if (within(abs, root.path)) return abs
    return null
  }
  const parts = raw.split('/').filter((part) => part && part !== '.')
  const roots = state.roots()
  const first = parts[0]
  const named = state.single() ? null : roots.find((root) => root.name === first)
  if (named) {
    const candidate = path.resolve(named.path, ...parts.slice(1))
    return within(candidate, named.path) ? candidate : null
  }
  for (const root of roots) {
    const candidate = path.resolve(root.path, ...parts)
    if (!within(candidate, root.path)) continue
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Absolute path that may not exist yet, but is still under a root (candidate form). */
function candidateAbs(state, relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/')
  if (!raw) return null
  const parts = raw.split('/').filter((part) => part && part !== '.')
  const roots = state.roots()
  const named = state.single() ? null : roots.find((root) => root.name === parts[0])
  if (named) {
    const candidate = path.resolve(named.path, ...parts.slice(1))
    return within(candidate, named.path) ? candidate : null
  }
  const rootAbs = roots.length ? roots[0].path : null
  if (!rootAbs) return null
  const candidate = path.resolve(rootAbs, ...parts)
  return within(candidate, rootAbs) ? candidate : null
}

function relOf(state, abs) {
  if (!abs) return ''
  return state.relOf(abs)
}

/* -------------------------------------------------------------- git access */

function gitShowFile(repoAbs, rev, repoRel) {
  const key = `${repoAbs}\u0000${rev}\u0000${repoRel}`
  const hit = cache.gitBlob.get(key)
  if (hit && now() - hit.at < REPO_TTL) return hit.content
  let content = null
  try {
    content = execFileSync('git', ['-C', repoAbs, 'cat-file', 'blob', `${rev}:${repoRel}`], {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    })
  } catch {
    content = null
  }
  if (cache.gitBlob.size > 256) cache.gitBlob.clear()
  cache.gitBlob.set(key, { at: now(), content })
  return content
}

function gitTreeFiles(repoAbs, rev) {
  const key = `${repoAbs}\u0000${rev}`
  const hit = cache.gitTree.get(key)
  if (hit && now() - hit.at < REPO_TTL) return hit.files
  let files = []
  try {
    const out = execFileSync('git', ['-C', repoAbs, 'ls-tree', '-r', '--name-only', rev], {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    })
    files = String(out).split(/\r?\n/).filter(Boolean)
  } catch {
    files = []
  }
  cache.gitTree.set(key, { at: now(), files })
  return files
}

/** Repo root + repo-relative path for a client-visible path (`_repo_for_rel`). */
function repoForRel(state, relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/')
  const parts = raw.split('/').filter((part) => part && part !== '.')
  const roots = state.roots()
  const named = state.single() ? null : roots.find((root) => root.name === parts[0])
  const rootAbs = named ? named.path : roots.length ? roots[0].path : null
  const relParts = named ? parts.slice(1) : parts
  if (!rootAbs || !relParts.length) return { repo: null, repoRel: null }
  for (let i = relParts.length; i > 0; i -= 1) {
    const candidate = path.join(rootAbs, ...relParts.slice(0, i))
    if (isDir(path.join(candidate, '.git'))) return { repo: candidate, repoRel: relParts.slice(i).join('/') }
  }
  return { repo: null, repoRel: null }
}

function pathInView(state, relPath, viewCommit) {
  if (!viewCommit) return false
  const { repo, repoRel } = repoForRel(state, relPath)
  if (!repo || !repoRel) return false
  return gitShowFile(repo, viewCommit, repoRel) != null
}

/** Read a file, preferring the requested git revision (`_load_file_content`). */
function loadFileContent(state, relPath, viewCommit) {
  const abs = resolveAbs(state, relPath)
  if (viewCommit) {
    const { repo, repoRel } = repoForRel(state, relPath)
    if (repo && repoRel) {
      const content = gitShowFile(repo, viewCommit, repoRel)
      if (content != null) return content
      return null // file not in that revision
    }
  }
  if (!abs || !isFile(abs)) return null
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/* ---------------------------------------------------- repository discovery */

function discoverGitRepos(rootAbs) {
  const hit = cache.repos.get(rootAbs)
  if (hit && now() - hit.at < REPO_TTL) return hit.list
  const found = []
  const seen = new Set()
  const addRepo = (dir) => {
    const abs = path.resolve(dir)
    if (seen.has(abs)) return
    seen.add(abs)
    found.push(abs)
  }
  /**
   * Walk a directory tree and collect every folder that holds a `.git`.
   */
  const scan = (startDir, maxDepth) => {
    if (!isDir(startDir)) return
    const stack = [{ dir: startDir, depth: 0 }]
    while (stack.length) {
      const { dir, depth } = stack.pop()
      for (const entry of readDir(dir)) {
        if (entry.name === '.git') {
          addRepo(dir)
          continue
        }
        if (!entry.isDirectory()) continue
        if (REPO_SCAN_SKIP.has(entry.name)) continue
        if (depth < maxDepth) stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }

  // The CK layout keeps its repositories under `<root>/gits/`.
  scan(path.join(rootAbs, 'gits'), 6)

  /**
   * OTHER layouts keep the repository deeper in the tree.
   *
   * The jjy workspace is `code/jjy/modules/<module>/.git` (the reader's root
   * is `code`, and `code/jjy` itself is not a repository). It was invisible to
   * the discovery, so the class index had no entry for it and EVERY
   * cross-module jump in that workspace failed with 「未找到定义」 (the enum
   * `HermesTypeEnum` lives in the sibling module `poseidon`). Scan the root's
   * own tree for `.git` folders - the heavy directories are skipped.
   */
  scan(rootAbs, 4)

  found.sort()
  cache.repos.set(rootAbs, { at: now(), list: found })
  return found
}

function allGitRepos(state, preferRoot) {
  const key = state.roots().map((root) => root.path).join('|')
  let hit = cache.repos.get('__all__' + key)
  if (!hit || now() - hit.at >= REPO_TTL) {
    const list = []
    for (const root of state.roots()) for (const repo of discoverGitRepos(root.path)) list.push(repo)
    hit = { at: now(), list }
    cache.repos.set('__all__' + key, hit)
  }
  if (preferRoot && isDir(preferRoot)) {
    const inside = hit.list.filter((repo) => within(repo, preferRoot))
    if (inside.length) return inside
  }
  return hit.list
}

function repoJavaRoots(repoAbs) {
  const hit = cache.repoJavaRoots.get(repoAbs)
  if (hit && now() - hit.at < REPO_TTL) return hit.list
  const roots = []
  for (const sub of ['main', 'test']) roots.push(path.join(repoAbs, 'src', sub, 'java'))
  const names = readDir(repoAbs).map((entry) => entry.name).sort()
  for (const name of names) {
    if (REPO_JAVA_ROOT_SKIP.has(name)) continue
    const first = path.join(repoAbs, name)
    if (!isDir(first) || !isDir(path.join(first, 'src'))) continue
    for (const sub of ['main', 'test']) roots.push(path.join(first, 'src', sub, 'java'))
    const subNames = readDir(first).map((entry) => entry.name).sort()
    for (const name2 of subNames) {
      if (REPO_JAVA_ROOT_SKIP.has(name2)) continue
      const second = path.join(first, name2)
      if (!isDir(second) || !isDir(path.join(second, 'src'))) continue
      for (const sub of ['main', 'test']) roots.push(path.join(second, 'src', sub, 'java'))
    }
  }

  /**
   * DEEPER module layouts.
   *
   * The jjy-o2o repository keeps its modules four levels down
   * (`<repo>/xls-platform/jar/<module>/src/main/java`). The two levels above
   * found nothing, so the class index had no entry for those modules and every
   * cross-module jump into them failed with 「未找到定义」 - clicking an enum
   * constant (`HermesTypeEnum.COUPON`) included. Walk the repository for
   * `<dir>/src/{main,test}/java` instead of assuming a fixed depth.
   */
  const found = new Set(roots.map((value) => path.resolve(value)))
  const stack = [{ dir: repoAbs, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    for (const entry of readDir(dir)) {
      if (!entry.isDirectory()) continue
      if (REPO_JAVA_ROOT_SKIP.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      if (isDir(path.join(child, 'src'))) {
        for (const sub of ['main', 'test']) {
          const javaRoot = path.join(child, 'src', sub, 'java')
          if (isDir(javaRoot)) found.add(path.resolve(javaRoot))
        }
      }
      if (depth < 5) stack.push({ dir: child, depth: depth + 1 })
    }
  }

  const unique = [...found]
  cache.repoJavaRoots.set(repoAbs, { at: now(), list: unique })
  return unique
}

/* ----------------------------------------------------------- class index */

const CLASS_INDEX_TTL = 1800000 // 30 min: source trees rarely change mid-session
const classIndexBuilds = new Map() // `${rootAbs}` / `${repoAbs}` -> Promise

/**
 * FQN -> class file list for the given repositories under `rootAbs`.
 *
 * Pure (only absolute paths in, entries out) so the same walk can run in a
 * worker thread: on a monorepo the full walk takes seconds (80 repositories,
 * 21k java files in the jjy workspace) and the Host lives in the Harness MAIN
 * process - doing it there freezes the whole app, which is the trap documented
 * in the skill for the basename index.
 *
 * `onlyRepos` narrows the walk to a few repositories: a cross-module jump
 * almost always stays inside the clicked file's own repository, and one
 * repository (~1 s) is much cheaper than the whole workspace (~4 s).
 *
 * @returns {Array<[string, string[]]>} entries, ready to build a Map from.
 */
export function buildClassIndexEntries(rootAbs, prefix, onlyRepos, scanDir) {
  const entries = []
  const map = new Map()
  const prefixed = prefix || ''
  const rootReal = path.resolve(rootAbs)
  const repos = onlyRepos && onlyRepos.length ? onlyRepos : discoverGitRepos(scanDir || rootAbs)
  for (const repo of repos) {
    for (const javaRoot of repoJavaRoots(repo)) {
      if (!isDir(javaRoot)) continue
      const rootRel = path.relative(rootReal, javaRoot).replace(/\\/g, '/')
      const stack = [javaRoot]
      while (stack.length) {
        const dir = stack.pop()
        for (const entry of readDir(dir)) {
          if (entry.isDirectory()) {
            if (!CLASS_INDEX_SKIP.has(entry.name)) stack.push(path.join(dir, entry.name))
            continue
          }
          if (!entry.isFile() || !entry.name.endsWith('.java')) continue
          const abs = path.join(dir, entry.name)
          const pkgRel = path.relative(javaRoot, abs).replace(/\\/g, '/')
          const fqn = pkgRel.slice(0, -'.java'.length).replace(/\//g, '.')
          const rel = `${prefixed}${rootRel ? rootRel + '/' : ''}${pkgRel}`
          const bucket = map.get(fqn)
          if (bucket) bucket.push(rel)
          else map.set(fqn, [rel])
        }
      }
    }
  }
  for (const [fqn, files] of map) entries.push([fqn, files])
  return entries
}

/**
 * Build an index on a WORKER THREAD and install it, so a later ctrl+click is
 * instant instead of blocking the main process.
 * Fire-and-forget: one build per cache key at a time, failures are ignored.
 *
 * `key` is what the install replaces: a root (`rootAbs`) for the whole index,
 * or `${rootAbs}\u0000${repo}` for a single repository.
 */
function prewarmIndex(key, workerData, install, onDone) {
  const debug = process.env.MDR_DEBUG === '1'
  if (debug) console.error('[defs] prewarm', key, 'ready=', install.ready(), 'running=', classIndexBuilds.has(key))
  if (classIndexBuilds.has(key)) return
  if (install.ready()) return
  let worker = null
  const promise = new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        if (worker) worker.terminate()
      } catch {
        // already gone
      }
      resolve(ok)
    }
    try {
      worker = new Worker(new URL('./classindex-worker.js', import.meta.url), { workerData })
    } catch {
      finish(false)
      return
    }
    worker.on('message', (message) => {
      if (!message || !Array.isArray(message.entries)) {
        if (debug) console.error('[defs] prewarm failed', key, message && message.error)
        finish(false)
        return
      }
      if (debug) console.error('[defs] prewarm done', key, message.entries.length, 'entries')
      install.done(message.entries)
      finish(true)
      if (typeof onDone === 'function') {
        try {
          onDone()
        } catch {
          // chained prewarming is an optimisation only
        }
      }
    })
    worker.on('error', (error) => {
      if (debug) console.error('[defs] prewarm error', key, error && error.message)
      finish(false)
    })
    worker.on('exit', () => finish(false))
  }).finally(() => classIndexBuilds.delete(key))
  classIndexBuilds.set(key, promise)
}

/** Prefix the client-visible paths of a root need (`<vtop>/...` when multi-root). */
export function classIndexPrefix(state, rootAbs) {
  const info = state.roots().find((root) => path.resolve(root.path) === path.resolve(rootAbs))
  return state.single() || !info ? '' : `${info.name}/`
}

/**
 * The index SCOPE of a clicked file: the directory that holds its repository.
 *
 * A module layout like `gits/<project>/xls-platform/jar/<module>/.git` makes
 * every module its own repository, so "the file's own repository" never
 * contains the sibling module it refers to; the parent directory does. When the
 * repository already sits directly under a workspace root the parent IS the
 * root - that is the full index, so there is nothing cheaper to build.
 */
function scopeOfRepo(state, repo) {
  if (!repo) return null
  const parent = path.dirname(path.resolve(repo))
  if (!parent || parent === path.resolve(repo)) return null
  const roots = state.roots()
  for (const root of roots) {
    if (path.resolve(root.path) === parent) return null
  }
  return parent
}

/**
 * Prewarm the index of the scope that owns `relPath` (fire and forget).
 * Called when a code file is opened, so the first ctrl+click finds a ready
 * index instead of building one in the main process.
 */
export function prewarmDefIndex(state, relPath) {
  try {
    const info = rootInfo(state, relPath)
    if (!info || !info.rootAbs) return
    const prefix = classIndexPrefix(state, info.rootAbs)
    const scope = scopeOfRepo(state, repoForRel(state, relPath).repo)
    if (!scope) {
      const hit = cache.classIndex.get(info.rootAbs)
      prewarmIndex(
        info.rootAbs,
        { rootAbs: info.rootAbs, prefix },
        {
          ready: () => {
            const fresh = cache.classIndex.get(info.rootAbs)
            return !!(fresh && now() - fresh.at < CLASS_INDEX_TTL)
          },
          done: (entries) => cache.classIndex.set(info.rootAbs, { at: now(), map: new Map(entries) }),
        },
      )
      return
    }
    const hit = cache.scopeClassIndex.get(scope)
    const warmRoot = () => {
      const rootHit = cache.classIndex.get(info.rootAbs)
      prewarmIndex(
        info.rootAbs,
        { rootAbs: info.rootAbs, prefix },
        {
          ready: () => {
            const fresh = cache.classIndex.get(info.rootAbs)
            return !!(fresh && now() - fresh.at < CLASS_INDEX_TTL)
          },
          done: (entries) => cache.classIndex.set(info.rootAbs, { at: now(), map: new Map(entries) }),
        },
      )
    }
    prewarmIndex(
      `${info.rootAbs}\u0000${scope}`,
      { rootAbs: info.rootAbs, prefix, scanDir: scope },
      {
        ready: () => !!(hit && now() - hit.at < CLASS_INDEX_TTL),
        done: (entries) => cache.scopeClassIndex.set(scope, { at: now(), map: new Map(entries) }),
      },
      warmRoot,
    )
  } catch {
    // prewarming is an optimisation only
  }
}

/** FQN -> files for ONE module group (cached; the cheap half of the index). */
function scopeClassIndex(state, scope, rootAbs) {
  const hit = cache.scopeClassIndex.get(scope)
  if (hit && now() - hit.at < CLASS_INDEX_TTL) return hit.map
  const map = new Map(buildClassIndexEntries(rootAbs, classIndexPrefix(state, rootAbs), null, scope))
  cache.scopeClassIndex.set(scope, { at: now(), map })
  return map
}

/** Look a FQN up in the clicked file's module group first; null when unknown. */
function lookupScope(state, preferRepo, rootAbs, fqn) {
  const scope = scopeOfRepo(state, preferRepo)
  if (!scope) return null
  const bucket = scopeClassIndex(state, scope, rootAbs).get(fqn)
  return bucket && bucket.length ? bucket : null
}

/**
 * FQN -> class file list for one workspace root (`_class_index` in the original).
 * Built lazily from the java source roots of every git repo under the root;
 * O(1) lookups afterwards (a click can query dozens of wildcard-import types).
 */
function classIndex(state, rootAbs) {
  const hit = cache.classIndex.get(rootAbs)
  if (hit && now() - hit.at < CLASS_INDEX_TTL) return hit.map
  const map = new Map(buildClassIndexEntries(rootAbs, classIndexPrefix(state, rootAbs)))
  cache.classIndex.set(rootAbs, { at: now(), map })
  return map
}

/**
 * Does `fqn` exist as a source file?
 *
 * The clicked file's own repository is consulted first: a local type is there,
 * and answering from one repository avoids building the whole workspace index
 * (a monorepo root can hold 80 repositories) inside the Harness main process.
 */
function typeSrcExists(state, fqn, preferRoot, preferRepo) {
  if (!fqn || !preferRoot) return false
  if (preferRepo) {
    const own = lookupScope(state, preferRepo, preferRoot, fqn)
    if (own) return true
  }
  const bucket = classIndex(state, preferRoot).get(fqn)
  return !!(bucket && bucket.length)
}

function isExternalFqn(fqn) {
  return !!fqn && JAVA_EXT_PKG_PREFIXES.some((prefix) => fqn.startsWith(prefix))
}

/**
 * Type name -> fully-qualified name (`_type_fqn_in_tree`): explicit import,
 * wildcard imports (project-internal file first), java.lang whitelist, then
 * wildcard/JDK/project fallbacks and finally the same package.
 */
function typeFqnInTree(state, model, typeName, pkg, preferRoot, preferRepo) {
  for (const imp of model.imports) {
    if (!imp.wildcard && imp.path.endsWith('.' + typeName)) return imp.path
  }
  let jdkHit = null
  let extHit = null
  let projHit = null
  for (const imp of model.imports) {
    if (!imp.wildcard || !imp.path || imp.static) continue
    const base = imp.path.replace(/[.*]+$/, '')
    if (!base) continue
    const fqn = `${base}.${typeName}`
    const jdk = base.startsWith('java.') || base.startsWith('javax.')
    const external = isExternalFqn(base + '.')
    // A framework/JDK package has no source here: asking the index would build
    // the whole workspace index just to answer "no".
    if (!jdk && !external && typeSrcExists(state, fqn, preferRoot, preferRepo)) return fqn
    if (base.startsWith('java.') || base.startsWith('javax.')) {
      if (!jdkHit) jdkHit = fqn
    } else if (isExternalFqn(base + '.')) {
      if (!extHit) extHit = fqn
    } else if (!projHit) {
      projHit = fqn
    }
  }
  if (JAVA_LANG_TYPES.has(typeName)) return `java.lang.${typeName}`
  if (jdkHit) return jdkHit
  if (extHit) return extHit
  if (projHit) return projHit
  if (pkg) return `${pkg}.${typeName}`
  return null
}

function findByPackagePath(state, relJava, projRoot, preferRepo) {
  if (!projRoot) return null
  let fqn = String(relJava || '').replace(/\\/g, '/')
  if (fqn.endsWith('.java')) fqn = fqn.slice(0, -'.java'.length)
  fqn = fqn.replace(/\//g, '.')
  // The clicked file's own repository first: a cross-module jump almost always
  // stays inside it, and one repository is much cheaper to index than the
  // whole workspace (a monorepo root can hold 80 repositories).
  if (preferRepo) {
    const own = lookupScope(state, preferRepo, projRoot, fqn)
    if (own) return own[0]
  }
  const bucket = classIndex(state, projRoot).get(fqn)
  if (!bucket || !bucket.length) return null
  if (preferRepo) {
    for (const candidate of bucket) {
      const { repo } = repoForRel(state, candidate)
      if (repo && sameReal(repo, preferRepo)) return candidate
    }
  }
  return bucket[0]
}

/**
 * Java file by SIMPLE class name, answered from the class index.
 *
 * `resolveTypeFile` used to fall back to `searchFile`, which walks the whole
 * repository on EVERY click. Measured on the jjy-o2o repository: 1.7 s per
 * unresolved name, in the Harness MAIN process - the same "the click freezes
 * the app" trap as the basename index. The class index already holds every
 * java file of every repository under the root, so scanning its keys answers
 * the same question in a few milliseconds.
 */
function findBySimpleName(state, rootAbs, simpleName, preferRepo) {
  if (!rootAbs || !simpleName) return null
  const suffix = `.${simpleName}`
  const collect = (index) => {
    const bucket = []
    for (const [fqn, files] of index) {
      if (fqn !== simpleName && !fqn.endsWith(suffix)) continue
      for (const rel of files) bucket.push(rel)
    }
    bucket.sort((a, b) => a.split('/').length - b.split('/').length)
    return bucket
  }
  // The clicked file's own module group first (cheap), the whole root on a miss.
  if (preferRepo) {
    const scope = scopeOfRepo(state, preferRepo)
    if (scope) {
      const own = collect(scopeClassIndex(state, scope, rootAbs))
      if (own.length) return own[0]
    }
  }
  const index = classIndex(state, rootAbs)
  if (!index.size) return null
  const bucket = collect(index)
  if (!bucket.length) return null
  if (preferRepo) {
    const prefRel = String(relOf(state, preferRepo) || '').replace(/\\/g, '/')
    if (prefRel) {
      for (const candidate of bucket) {
        if (candidate.startsWith(`${prefRel}/`)) return candidate
      }
    }
  }
  return bucket[0]
}

/* ---------------------------------------------------- basename file search */

function findUnder(absDir, maxDepth, base) {
  if (!absDir || !isDir(absDir)) return null
  const queue = [{ dir: absDir, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()
    for (const entry of readDir(dir)) {
      if (SEARCH_SKIP.has(entry.name)) continue
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (entry.name === base) return path.join(dir, entry.name)
    }
  }
  return null
}

/** Basename search across the current project (`_search_file`). */
function searchFile(state, base, viewCommit, preferRepo, preferRoot) {
  let searchRoot = null
  if (preferRoot && isDir(preferRoot)) searchRoot = preferRoot
  else if (state.roots().length === 1) searchRoot = state.roots()[0].path
  if (!searchRoot) return null

  if (preferRepo && within(preferRepo, searchRoot)) {
    const hit = findUnder(preferRepo, 12, base)
    if (hit) return relOf(state, hit)
  }
  for (const repo of allGitRepos(state, searchRoot)) {
    if (preferRepo && sameReal(repo, preferRepo)) continue
    if (!within(repo, searchRoot)) continue
    const hit = findUnder(repo, 12, base)
    if (hit) return relOf(state, hit)
  }
  const gitsDir = path.join(searchRoot, 'gits')
  if (isDir(gitsDir)) {
    const names = readDir(gitsDir).map((entry) => entry.name).sort()
    for (const name of names) {
      const cand = path.join(gitsDir, name)
      if (!isDir(cand)) continue
      if (preferRepo && sameReal(cand, preferRepo)) continue
      const hit = findUnder(cand, 4, base)
      if (hit) return relOf(state, hit)
    }
  }
  for (const [rel, depth] of [['docs', 3], ['gits/ckdocs', 3], ['tools', 3], ['pvh', 3], ['pvhth', 3]]) {
    if (rel.startsWith('gits')) continue
    const hit = findUnder(path.join(searchRoot, ...rel.split('/')), depth, base)
    if (hit) return relOf(state, hit)
  }
  if (viewCommit) {
    for (const repo of allGitRepos(state, searchRoot)) {
      if (!within(repo, searchRoot)) continue
      const files = gitTreeFiles(repo, viewCommit)
      for (const relInRepo of files) {
        if (path.posix.basename(relInRepo.replace(/\\/g, '/')) !== base) continue
        return relOf(state, path.join(repo, relInRepo.replace(/\//g, path.sep)))
      }
    }
  }
  return null
}

/* ------------------------------------------------------- type file lookup */

/** Type name -> client-visible class file path (`_resolve_type_file`). */
function resolveTypeFile(state, model, typeName, srcRel, viewCommit) {
  const pkg = model.pkg
  const srcNorm = String(srcRel || '').replace(/\\/g, '/')
  const rootMatch = /^(.*\/src\/(?:main|test)\/java\/)/.exec(srcNorm)
  const rootPrefix = rootMatch ? rootMatch[1] : null
  const projRoot = rootInfo(state, srcRel).rootAbs
  const preferRepo = repoForRel(state, srcRel).repo
  const fqn = String(typeName).includes('.')
    ? typeName
    : typeFqnInTree(state, model, typeName, pkg, projRoot, preferRepo)
  const candidates = []
  if (fqn) {
    candidates.push(fqn.replace(/\./g, '/') + '.java')
    if (rootPrefix && fqn.includes('.')) candidates.unshift(rootPrefix + fqn.replace(/\./g, '/') + '.java')
  }
  if (rootPrefix) {
    if (pkg) candidates.push(rootPrefix + pkg.replace(/\./g, '/') + '/' + typeName + '.java')
    for (const imp of model.imports) {
      if (imp.wildcard && imp.path) candidates.push(rootPrefix + imp.path.replace(/\./g, '/') + '/' + typeName + '.java')
    }
  }
  for (const candidate of candidates) {
    const abs = candidateAbs(state, candidate)
    if (!abs) continue
    if (isFile(abs)) return relOf(state, abs)
    if (viewCommit && pathInView(state, candidate, viewCommit)) return relOf(state, abs)
  }
  if (fqn && fqn.includes('.')) {
    const hit = findByPackagePath(state, fqn.replace(/\./g, '/') + '.java', projRoot, preferRepo)
    if (hit) return hit
  }
  if (fqn && isExternalFqn(fqn)) return null
  const byName = findBySimpleName(state, projRoot, typeName, preferRepo)
  if (byName) return byName
  // Only walk the tree when the class index has no coverage at all (a root
  // without any java source root). Otherwise the index scan above is final -
  // walking a big repository on every click blocked the Harness main process
  // for 1.7 s per unresolved name.
  if (projRoot && classIndex(state, projRoot).size) return null
  return searchFile(state, typeName + '.java', viewCommit, preferRepo, projRoot)
}

/* ----------------------------------------------------- declaration helpers */

function findFieldLine(model, name, withLombok) {
  const lines = findFieldLines(model, name, withLombok)
  return lines.length ? lines[0] : null
}

function varDecls(model, name) {
  const decls = []
  for (const field of model.fields) {
    if (field.name === name && field.line) decls.push({ line: field.line, typeName: field.typeName, rank: 0 })
  }
  for (const param of model.params) {
    if (param.name === name && param.line) decls.push({ line: param.line, typeName: param.typeName, rank: 1 })
  }
  for (const local of model.locals) {
    if (local.name === name && local.line) decls.push({ line: local.line, typeName: local.typeName, rank: 2 })
  }
  decls.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.rank - b.rank))
  return decls
}

function extrasFor(model, name, clickLine) {
  const matches = model.extras.filter((extra) => extra.name === name && extra.line)
  if (!matches.length) return null
  const before = matches.filter((extra) => extra.line <= clickLine).sort((a, b) => b.line - a.line)
  if (before.length) return before[0]
  matches.sort((a, b) => a.line - b.line)
  return matches[0]
}

/** Receiver type of a qualifier (`_receiver_type`). */
function receiverType(model, qualifier) {
  if (!qualifier || typeof qualifier !== 'string') return null
  const first = qualifier.split('.')[0]
  if (!first) return null
  if (first[0] >= 'A' && first[0] <= 'Z') return first
  if (first === 'this' || first === 'super') return null
  const decls = varDecls(model, first)
  return decls.length ? decls[0].typeName : null
}

/** `_type_framework_parent`: does a type extend/implement an external framework type? */
function typeFrameworkParent(state, model, typeDecl, preferRoot) {
  if (!typeDecl) return false
  const parents = [...(typeDecl.extendsNames || []), ...(typeDecl.implementsNames || [])]
  for (const parentName of parents) {
    if (!parentName) continue
    const fqn = typeFqnInTree(state, model, parentName, model.pkg, preferRoot)
    if (fqn && isExternalFqn(fqn)) return true
  }
  return false
}

function firstOuterType(model) {
  for (const decl of model.types) {
    if ((decl.kind === 'class' || decl.kind === 'interface') && decl.line) return decl
  }
  return null
}

/** Lombok getter/setter/is -> field declaration line, following `extends` up to 2 levels. */
function lombokFieldLine(state, model, methodName, srcRel, viewCommit, depth) {
  if (depth > 2) return null
  const fieldName = getterFieldName(methodName)
  if (!fieldName) return null
  const line = findFieldLine(model, fieldName, true)
  if (line) return line
  const outer = firstOuterType(model)
  if (!outer) return null
  const parentName = (outer.extendsNames && outer.extendsNames[0]) || null
  if (!parentName) return null
  const parentTarget = resolveTypeFile(state, model, parentName, srcRel, viewCommit)
  if (!parentTarget) return null
  const content = loadFileContent(state, parentTarget, viewCommit)
  if (content == null) return null
  const parentModel = parseModel(content, parentTarget)
  if (!parentModel) return null
  return lombokFieldLine(state, parentModel, methodName, parentTarget, viewCommit, depth + 1)
}

/* ------------------------------------------------------------ impl lookup */

/** Interface -> implementation entry (`_resolve_impl`). */
function resolveImpl(state, targetRel, typeName, methodName, viewCommit) {
  const abs = resolveAbs(state, targetRel)
  if (!abs) return null
  const candidates = []
  candidates.push(path.join(path.dirname(abs), typeName + 'Impl.java'))
  const rootMatch = /^(.*\/src\/(?:main|test)\/java\/)/.exec(String(targetRel).replace(/\\/g, '/'))
  if (rootMatch) {
    const rootPrefix = rootMatch[1]
    const relJava = String(targetRel).replace(/\\/g, '/').slice(rootMatch[0].length)
    const pkgDir = relJava.includes('/') ? relJava.slice(0, relJava.lastIndexOf('/')) : ''
    if (pkgDir) candidates.push(rootPrefix + pkgDir + '/impl/' + typeName + 'Impl.java')
  }
  let implRel = null
  for (const candidate of candidates) {
    const candidatePath = candidateAbs(state, candidate)
    if (!candidatePath) continue
    if (isFile(candidatePath) || (viewCommit && pathInView(state, candidate, viewCommit))) {
      implRel = relOf(state, candidatePath)
      break
    }
  }
  if (!implRel) {
    const targetProject = rootInfo(state, targetRel).rootAbs
    const found = searchFile(state, typeName + 'Impl.java', viewCommit, repoForRel(state, targetRel).repo, targetProject)
    if (!found) return null
    implRel = found
  }
  const content = loadFileContent(state, implRel, viewCommit)
  if (content == null) return null
  const model = parseModel(content, implRel)
  if (!model) {
    const line = methodName
      ? findMethodDeclText(content, methodName)
      : findTypeDeclText(content, typeName + 'Impl')
    if (!line) return null
    return { file: implRel, line }
  }
  if (methodName) {
    const methodNode = earliestMethodDecl(model, methodName)
    if (!methodNode) {
      const line = findMethodDeclText(content, methodName)
      if (!line) return null
      return { file: implRel, line }
    }
    return { file: implRel, line: methodNode.line }
  }
  const typeNode = findTypeDecl(model, typeName + 'Impl')
  if (typeNode) return { file: implRel, line: typeNode.line }
  const line = findTypeDeclText(content, typeName + 'Impl')
  if (!line) return null
  return { file: implRel, line }
}

/** Mapper interface -> Mapper.xml statement line (`_resolve_mapper_xml`). */
function resolveMapperXml(state, base, javaRel, viewCommit) {
  const xmlName = base + '.xml'
  let xmlRel = null
  const rootMatch = /^(.*?\/src\/(?:main|test)\/)/.exec(String(javaRel).replace(/\\/g, '/'))
  if (rootMatch) {
    let rootPrefix = rootMatch[1]
    const first = String(javaRel).replace(/\\/g, '/').split('/')[0]
    const roots = state.roots()
    const isVtop = !state.single() && roots.some((root) => root.name === first) && String(javaRel).includes('/')
    if (isVtop) rootPrefix = rootPrefix.slice(first.length + 1)
    const projectRoot = rootInfo(state, javaRel).rootAbs
    const resRoot = path.join(projectRoot, ...(rootPrefix + 'resources').split('/').filter(Boolean))
    if (isDir(resRoot)) {
      const stack = [resRoot]
      while (stack.length && !xmlRel) {
        const dir = stack.pop()
        for (const entry of readDir(dir)) {
          if (entry.isDirectory()) {
            if (entry.name !== '.git' && entry.name !== 'target') stack.push(path.join(dir, entry.name))
            continue
          }
          if (entry.name === xmlName) {
            xmlRel = relOf(state, path.join(dir, entry.name))
            break
          }
        }
      }
    }
  }
  if (!xmlRel) {
    const found = searchFile(state, xmlName, viewCommit, repoForRel(state, javaRel).repo, rootInfo(state, javaRel).rootAbs)
    if (!found) return null
    xmlRel = found
  }
  const content = loadFileContent(state, xmlRel, viewCommit)
  if (content == null) return null
  const statements = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const m = /<(select|insert|update|delete)\b[^>]*\bid="([^"]+)"/.exec(lines[index])
    if (m) statements.push({ method: m[2], line: index + 1 })
  }
  return { file: xmlRel, statements }
}

/** Interface method declaration clicked -> implementation (`_resolve_iface_method`). */
function resolveIfaceMethod(state, srcRel, ifaceName, methodName, viewCommit) {
  if (String(ifaceName).toLowerCase().endsWith('mapper')) {
    const xml = resolveMapperXml(state, ifaceName, srcRel, viewCommit)
    if (xml) {
      for (const statement of xml.statements) {
        if (statement.method === methodName) {
          return { file: xml.file, line: statement.line, impl: null, kind: 'xml', defName: methodName }
        }
      }
    }
    return null
  }
  const impl = resolveImpl(state, srcRel, ifaceName, methodName, viewCommit)
  if (impl) return { file: impl.file, line: impl.line, impl: null, kind: 'method', defName: methodName }
  return null
}

/* -------------------------------------------------------- core resolution */

/** Receiver-type method resolution, following extends/implements up to 3 levels. */
function resolveRecvChain(state, model, srcRel, recvType, name, pkg, viewCommit, depth, visited) {
  if (depth > 3 || visited.has(recvType)) return { error: '未找到定义' }
  visited.add(recvType)
  const target = resolveTypeFile(state, model, recvType, srcRel, viewCommit)
  if (!target) {
    const fqn = typeFqnInTree(state, model, recvType, pkg, rootInfo(state, srcRel).rootAbs)
    return { error: isExternalFqn(fqn) ? '外部/框架方法，无本地定义' : '未找到定义' }
  }
  const content = loadFileContent(state, target, viewCommit)
  if (content == null) return { error: '未找到定义' }
  const targetModel = parseModel(content, target)
  if (!targetModel) {
    const line = findMethodDeclText(content, name)
    if (!line) return { error: '未找到定义' }
    return { file: target, line, impl: null, kind: 'method', defName: name }
  }
  const typeNode = findTypeDecl(targetModel, recvType)
  if (!typeNode) return { error: '未找到定义' }
  const methodNode = earliestMethodDecl(targetModel, name)
  if (methodNode) {
    const impl = typeNode.kind === 'interface' ? resolveImpl(state, target, recvType, name, viewCommit) : null
    return { file: target, line: methodNode.line, impl, kind: 'method', defName: name }
  }
  const fieldLine = lombokFieldLine(state, targetModel, name, target, viewCommit, 0)
  if (fieldLine) return { file: target, line: fieldLine, impl: null, kind: 'method', defName: name }
  if (typeFrameworkParent(state, targetModel, typeNode, rootInfo(state, target).rootAbs)) {
    return { error: '外部/框架方法，无本地定义' }
  }
  const parents = [...(typeNode.extendsNames || []), ...(typeNode.implementsNames || [])]
  for (const parentName of parents) {
    if (!parentName || visited.has(parentName)) continue
    const result = resolveRecvChain(state, model, srcRel, parentName, name, pkg, viewCommit, depth + 1, visited)
    if (result) return result
  }
  return { error: '未找到定义' }
}

/** Chain tail `a.b().c()` clicked at `c`: walk the line text back to the head. */
function resolveChainTail(state, model, srcRel, line, col, name, viewCommit, srcText) {
  if (!srcText) return null
  const lines = String(srcText).split('\n')
  if (line < 1 || line > lines.length) return null
  const lineText = lines[line - 1]
  let idx = lineText.lastIndexOf(name)
  while (idx > col - 1) idx = lineText.lastIndexOf(name, idx - 1)
  if (idx < 0) return null
  const head = chainHeadIdent(lineText, idx + 1)
  if (!head) return null
  const recvType = receiverType(model, head)
  if (!recvType) return null
  const target = resolveTypeFile(state, model, recvType, srcRel, viewCommit)
  if (!target) {
    const fqn = typeFqnInTree(state, model, recvType, model.pkg, rootInfo(state, srcRel).rootAbs)
    return isExternalFqn(fqn) ? { error: '外部/框架方法，无本地定义' } : null
  }
  const content = loadFileContent(state, target, viewCommit)
  if (content == null) return null
  const targetModel = parseModel(content, target)
  if (!targetModel) return null
  const typeNode = findTypeDecl(targetModel, recvType)
  if (!typeNode) return null
  const methodNode = earliestMethodDecl(targetModel, name)
  if (!methodNode) {
    if (typeFrameworkParent(state, targetModel, typeNode, rootInfo(state, target).rootAbs)) {
      return { error: '外部/框架方法，无本地定义' }
    }
    return null
  }
  const impl = typeNode.kind === 'interface' ? resolveImpl(state, target, recvType, name, viewCommit) : null
  return { file: target, line: methodNode.line, impl, kind: 'method', defName: name }
}

/** Token-level replacement for javalang's `_find_invocation`. */
function findInvocation(model, line, col, name) {
  const token = findIdentTokenAt(model, line, col, name)
  if (!token) return null
  if (!isCallShaped(model, token)) return null
  if (isMethodDeclTokenToken(model, token)) return null
  if (isConstructorDeclToken(model, token)) return null
  return { token, qualifier: callQualifierFirstSegment(model, token) }
}

/** Core resolver; mirrors `_resolve_java_def` step by step. */
function resolveJavaDef(state, model, srcRel, line, col, name, kind, viewCommit, srcText) {
  const pkg = model.pkg
  const lines = String(srcText || model.text || '').split('\n')
  const lineText = line >= 1 && line <= lines.length ? lines[line - 1] : ''
  const projRoot = rootInfo(state, srcRel).rootAbs

  if (kind === 'constant') {
    const textLine = findConstDeclLineText(srcText, name)
    if (textLine) return { file: srcRel, line: textLine, impl: null, kind: 'constant', defName: name }
    const fieldLine = findFieldLine(model, name, false)
    if (fieldLine) return { file: srcRel, line: fieldLine, impl: null, kind: 'constant', defName: name }
    const recv = constReceiver(srcText, line, col, name)
    if (recv) {
      const target = resolveTypeFile(state, model, recv, srcRel, viewCommit)
      if (target) {
        const content = loadFileContent(state, target, viewCommit)
        if (content != null) {
          const targetLine = findConstDeclLineText(content, name)
          if (targetLine) return { file: target, line: targetLine, impl: null, kind: 'constant', defName: name }
        }
      }
    }
    return { error: '未找到定义' }
  }

  let isMethodRef = false
  if (kind === 'variable' || kind === 'field') {
    isMethodRef = !!findMethodRefText(lineText, col, name)
    if (!isMethodRef) {
      // `obj.field`: resolve the receiver variable's type and look the field up there.
      let fieldQualifier = null
      const before = lineText.slice(0, Math.max(0, col - 1)).replace(/\s+$/, '')
      const m = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before)
      if (m && m[1] !== 'this' && m[1] !== 'super') fieldQualifier = m[1]
      if (fieldQualifier) {
        const fieldRecv = receiverType(model, fieldQualifier)
        if (fieldRecv) {
          const fieldTarget = resolveTypeFile(state, model, fieldRecv, srcRel, viewCommit)
          if (fieldTarget) {
            const fieldContent = loadFileContent(state, fieldTarget, viewCommit)
            if (fieldContent != null) {
              const fieldModel = parseModel(fieldContent, fieldTarget)
              if (fieldModel) {
                const fieldLine = findFieldLine(fieldModel, name, false)
                if (fieldLine) return { file: fieldTarget, line: fieldLine, impl: null, kind: 'field', defName: name }
              }
            }
          }
        }
      }
      const decls = varDecls(model, name).filter((decl) => decl.line)
      if (decls.length) return { file: srcRel, line: decls[0].line, impl: null, kind: 'variable', defName: name }
      // javalang does not model catch/lambda/try-with-resources/record/var
      // declarations; resolve them as a strict superset (only when the
      // javalang-equivalent pool above found nothing).
      const extra = extrasFor(model, name, line)
      if (extra) {
        return { file: srcRel, line: extra.line, impl: null, kind: 'variable', defName: name }
      }
      return { error: '未找到定义' }
    }
  }

  if (kind === 'type') {
    const typeNode = findTypeDecl(model, name)
    if (typeNode) return { file: srcRel, line: typeNode.line, impl: null, kind: 'type', defName: name }
    const target = resolveTypeFile(state, model, name, srcRel, viewCommit)
    if (!target) {
      const fqn = typeFqnInTree(state, model, name, pkg, projRoot)
      return { error: isExternalFqn(fqn) ? '外部/框架方法，无本地定义' : '未找到定义' }
    }
    const content = loadFileContent(state, target, viewCommit)
    if (content == null) return { error: '未找到定义' }
    const targetModel = parseModel(content, target)
    if (!targetModel) {
      const textLine = findTypeDeclText(content, name)
      if (!textLine) return { error: '未找到定义' }
      return { file: target, line: textLine, impl: null, kind: 'type', defName: name }
    }
    const targetType = findTypeDecl(targetModel, name)
    if (!targetType) {
      const textLine = findTypeDeclText(content, name)
      if (!textLine) return { error: '未找到定义' }
      return { file: target, line: textLine, impl: null, kind: 'type', defName: name }
    }
    const impl = targetType.kind === 'interface' ? resolveImpl(state, target, name, null, viewCommit) : null
    return { file: target, line: targetType.line, impl, kind: 'type', defName: name }
  }

  // ---- method ----
  const invocation = findInvocation(model, line, col, name)
  if (!invocation) {
    const methodRefQualifier = findMethodRefText(lineText, col, name)
    if (methodRefQualifier) {
      const recvType = receiverType(model, methodRefQualifier)
      if (recvType) {
        return resolveRecvChain(state, model, srcRel, recvType, name, pkg, viewCommit, 0, new Set())
      }
      return { error: '未找到定义' }
    }
    // Clicked a method declaration itself: interface method -> implementation.
    for (const method of model.methods) {
      if (method.name !== name || method.line !== line) continue
      if (method.isInterface) {
        const result = resolveIfaceMethod(state, srcRel, method.typeName, name, viewCommit)
        if (result) return result
      }
      return { file: srcRel, line, impl: null, kind: 'method', defName: name }
    }
    const local = earliestMethodDecl(model, name)
    if (local) return { file: srcRel, line: local.line, impl: null, kind: 'method', defName: name }
    return { error: '未找到定义' }
  }

  const qualifier = invocation.qualifier
  if (!qualifier || qualifier === 'this' || qualifier === 'super') {
    const local = earliestMethodDecl(model, name)
    if (local) return { file: srcRel, line: local.line, impl: null, kind: 'method', defName: name }
    const fieldLine = lombokFieldLine(state, model, name, srcRel, viewCommit, 0)
    if (fieldLine) return { file: srcRel, line: fieldLine, impl: null, kind: 'method', defName: name }
    const cls = firstOuterType(model)
    if (cls && typeFrameworkParent(state, model, cls, projRoot)) {
      return { error: '外部/框架方法，无本地定义' }
    }
    if (cls) {
      const chained = resolveRecvChain(state, model, srcRel, cls.name, name, pkg, viewCommit, 0, new Set())
      if (chained && !chained.error) return chained
    }
    const tail = resolveChainTail(state, model, srcRel, line, col, name, viewCommit, srcText)
    if (tail) return tail
    return { error: '未找到定义' }
  }

  const recvType = receiverType(model, qualifier)
  if (!recvType) {
    const local = earliestMethodDecl(model, name)
    if (local) return { file: srcRel, line: local.line, impl: null, kind: 'method', defName: name }
    return { error: '未找到定义' }
  }
  return resolveRecvChain(state, model, srcRel, recvType, name, pkg, viewCommit, 0, new Set())
}

/* ---------------------------------------------------------- web resolver */

const WEB_FILE_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue)$/i
const VUE_FILE_RE = /\.vue$/i
const WEB_EXT_ORDER = ['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const WEB_INDEX_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.vue', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts']
const RE_IMPORT_FROM = /(?:^|[^\w$.])import\s+([^'"();]*?)\s*from\s*['"]([^'"]+)['"]/gm
const RE_EXPORT_FROM = /(?:^|[^\w$.])export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+)\s+from\s*['"]([^'"]+)['"]/gm
const RE_IMPORT_BARE = /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/gm
const RE_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_VUE_TAG = /<\s*([A-Za-z][\w.-]*)\b/g
const WEB_BUILTIN_TAGS = new Set([
  'template', 'script', 'style', 'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'label', 'img', 'svg', 'path', 'g', 'br', 'hr', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 'small', 'section', 'header',
  'footer', 'main', 'nav', 'aside', 'article', 'router-view', 'router-link', 'transition',
  'keep-alive', 'slot', 'component',
])

function webDirOf(rel) {
  const p = String(rel || '').replace(/\\/g, '/')
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
}

function joinRel(baseDir, ...parts) {
  const stack = String(baseDir || '').split('/').filter(Boolean)
  for (const part of parts) {
    for (const seg of String(part || '').split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (stack.length) stack.pop()
        continue
      }
      stack.push(seg)
    }
  }
  return stack.join('/')
}

function stripCommentsLine(line) {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1] || ''
    if (quote) {
      out += ch
      if (ch === '\\') {
        if (next) {
          out += next
          i += 1
        }
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && (next === '/' || next === '*')) break
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    out += ch
  }
  return out
}

function iterModuleSpecs(srcText) {
  // Order matters: dynamic `import('x')` is emitted as a bare spec too by the
  // original, but dedupe is by (module, line) so duplicates collapse.
  const list = []
  const seen = new Set()
  const add = (mod, line, clause) => {
    const key = `${mod}\u0000${line}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ mod, line, clause: clause || '' })
  }
  const lineOf = (text, offset) => text.slice(0, offset).split('\n').length
  let m
  const src = String(srcText || '')
  RE_IMPORT_FROM.lastIndex = 0
  while ((m = RE_IMPORT_FROM.exec(src)) !== null) {
    add(m[2], lineOf(src, m.index + m[0].indexOf('from')), m[1])
  }
  RE_EXPORT_FROM.lastIndex = 0
  while ((m = RE_EXPORT_FROM.exec(src)) !== null) {
    add(m[1], lineOf(src, m.index), '')
  }
  RE_IMPORT_BARE.lastIndex = 0
  while ((m = RE_IMPORT_BARE.exec(src)) !== null) add(m[1], lineOf(src, m.index), '')
  RE_DYNAMIC.lastIndex = 0
  while ((m = RE_DYNAMIC.exec(src)) !== null) add(m[1], lineOf(src, m.index), '')
  RE_REQUIRE.lastIndex = 0
  while ((m = RE_REQUIRE.exec(src)) !== null) add(m[1], lineOf(src, m.index), '')
  return list
}

function findSrcRoot(baseDir) {
  const parts = String(baseDir || '').split('/').filter((part) => part && part !== '.')
  for (let i = parts.length; i >= 0; i -= 1) {
    const head = parts.slice(0, i).join('/')
    const last = head.split('/').pop()
    if (last === 'src' || last === 'lib' || last === 'app') return head
    if (i < parts.length && ['src', 'lib', 'app'].includes(parts[i])) return parts.slice(0, i + 1).join('/')
  }
  return null
}

function findProjRoot(baseDir) {
  const parts = String(baseDir || '').split('/').filter((part) => part && part !== '.')
  for (let i = parts.length; i >= 0; i -= 1) {
    const head = parts.slice(0, i).join('/')
    if (!head) return null
    const last = head.split('/').pop()
    if (last.includes('-') || last.includes('_') || ['web', 'frontend', 'app', 'ui', 'client'].includes(last.toLowerCase())) {
      return head
    }
    if (i === 0) return ''
  }
  return ''
}

function resolveWebModule(spec, srcRelInRoot, exists) {
  const text = String(spec || '').trim()
  if (!text || text.startsWith('http:') || text.startsWith('https:') || text.startsWith('//') || text.startsWith('data:')) return []
  if (!/^[.~@/]/.test(text)) return []
  const baseDir = webDirOf(srcRelInRoot)
  let alias = null
  if (text.startsWith('~')) alias = text.slice(1)
  else if (text.startsWith('@/')) alias = text.slice(2)
  else if (text.startsWith('@')) alias = text.slice(1)
  else if (text.startsWith('/')) alias = text.replace(/^\/+/, '')
  const bases = []
  if (alias === null) {
    bases.push(joinRel(baseDir, text))
  } else {
    const aliasClean = alias.replace(/^\.?\//, '').replace(/^\.\//, '')
    const stripped = aliasClean.replace(/^(?:src|lib|app|packages)\//, '')
    bases.push(aliasClean)
    const srcRoot = findSrcRoot(baseDir)
    if (srcRoot !== null && stripped) {
      bases.push(joinRel(srcRoot, stripped))
      bases.push(`${srcRoot}/${stripped}`)
    }
    const projRoot = findProjRoot(baseDir)
    if (projRoot !== null && stripped) bases.push(joinRel(projRoot, stripped))
    bases.push(joinRel(baseDir, stripped))
    if (stripped !== aliasClean) bases.push(joinRel(baseDir, aliasClean))
  }
  const candidates = []
  const seen = new Set()
  for (const base of bases) {
    if (!base || seen.has(base)) continue
    seen.add(base)
    for (const ext of WEB_EXT_ORDER) candidates.push(base + ext)
    candidates.push(base)
    for (const name of WEB_INDEX_NAMES) candidates.push(base + '/' + name)
  }
  const out = []
  const seenOut = new Set()
  for (const candidate of candidates) {
    if (seenOut.has(candidate)) continue
    seenOut.add(candidate)
    if (exists(candidate)) return [candidate]
    out.push(candidate)
  }
  return out
}

const DECL_RES = [
  { re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, group: 1 },
  { re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, group: 1 },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    group: 1,
  },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=/, group: 1 },
]
const RE_CLASS_MEMBER = /^\s{2,}(?:public |private |protected |static |readonly |async |get |set )*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*[:{]/
const RE_EXPORT_DEFAULT_FN = /^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)/
const RE_EXPORT_DEFAULT_CLASS = /^\s*export\s+default\s+class\s+(\w+)/
const RE_EXPORT_DEFAULT_IDENT = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)/

function findDeclLine(targetText, name) {
  if (!targetText || !name) return null
  const lines = String(targetText).split('\n')
  let scriptLo = 0
  let scriptHi = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('<script')) scriptLo = i
    if (lines[i].includes('</script>')) {
      scriptHi = i + 1
      break
    }
  }
  const inScript = scriptHi - scriptLo > 0
  const scan = (lo, hi) => {
    for (let i = lo; i < hi; i += 1) {
      const line = stripCommentsLine(lines[i])
      if (!line.trim()) continue
      for (const { re, group } of DECL_RES) {
        const m = re.exec(line)
        if (m && m[group] === name) return i + 1
      }
      const member = RE_CLASS_MEMBER.exec(line)
      if (member && member[1] === name) return i + 1
    }
    return null
  }
  let hit = scan(scriptLo, inScript ? scriptHi : lines.length)
  if (hit) return hit
  if (inScript) {
    hit = scan(0, lines.length)
    if (hit) return hit
  }
  for (let i = scriptLo; i < (inScript ? scriptHi : lines.length); i += 1) {
    const line = stripCommentsLine(lines[i])
    for (const re of [RE_EXPORT_DEFAULT_FN, RE_EXPORT_DEFAULT_CLASS, RE_EXPORT_DEFAULT_IDENT]) {
      const m = re.exec(line)
      if (m && m[1] === name) return i + 1
    }
  }
  return null
}

function findDefaultExportLine(targetText) {
  if (!targetText) return null
  const lines = String(targetText).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripCommentsLine(lines[i])
    if (RE_EXPORT_DEFAULT_FN.test(line) || RE_EXPORT_DEFAULT_CLASS.test(line)) return i + 1
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripCommentsLine(lines[i])
    const m = RE_EXPORT_DEFAULT_IDENT.exec(line)
    if (m) {
      const hit = findDeclLine(targetText, m[1])
      return hit || i + 1
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*export\s+default\b/.test(stripCommentsLine(lines[i]))) return i + 1
  }
  return null
}

const _MISS = { miss: true }
const _NAMESPACE = { namespace: true }

function matchImportClause(clause, name) {
  const text = String(clause || '').trim()
  if (!text) return _MISS
  const brace = /\{([^}]*)\}/.exec(text)
  if (brace) {
    for (const rawPart of brace[1].split(',')) {
      const part = rawPart.trim()
      if (!part) continue
      let local = part
      let orig = part
      if (part.includes(' as ')) {
        const pieces = part.split(' as ')
        orig = pieces[0].trim()
        local = pieces[1].trim()
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue
      if (local === name) return orig
    }
  }
  const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(text)
  if (ns) return ns[1] === name ? _NAMESPACE : _MISS
  const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(text)
  if (def) return def[1] === name ? 'default' : _MISS
  return _MISS
}

function findImportedSymbol(srcText, name) {
  if (!name || !srcText) return null
  const src = String(srcText)
  RE_IMPORT_FROM.lastIndex = 0
  let m
  while ((m = RE_IMPORT_FROM.exec(src)) !== null) {
    const got = matchImportClause(m[1], name)
    if (got !== _MISS) return { mod: m[2], symbol: got }
  }
  const requireRe = /(?:const|let|var)\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = requireRe.exec(src)) !== null) {
    const got = matchImportClause(m[1], name)
    if (got !== _MISS) return { mod: m[2], symbol: got }
  }
  const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g
  while ((m = nsRe.exec(src)) !== null) {
    if (m[1] === name) return { mod: m[2], symbol: _NAMESPACE }
  }
  return null
}

function pascalFromTag(tag) {
  return String(tag || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function vueComponentCandidates(tag, srcRelInRoot) {
  const pascal = pascalFromTag(tag)
  const dir = webDirOf(srcRelInRoot)
  const bases = [dir, joinRel(dir, 'components'), joinRel(dir, '..'), joinRel(dir, '../components'), joinRel(dir, '../..'), joinRel(dir, '../../components')]
  const out = []
  const seen = new Set()
  for (const base of bases) {
    const candidate = joinRel(base, pascal + '.vue')
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    out.push(candidate)
  }
  return out
}

function resolveWebDef(state, rel, relInRoot, text, line, col, name, kind) {
  const lines = String(text || '').split('\n')
  const toFull = (candidate) => {
    const prefix = rootInfo(state, rel)
    const clean = String(candidate || '').replace(/\\/g, '/')
    if (!clean) return null
    if (state.single()) return clean
    return joinRel(prefix.rootName, clean)
  }
  const webExists = (candidate) => {
    const full = toFull(candidate)
    const abs = full ? resolveAbs(state, full) : null
    return !!(abs && isFile(abs))
  }
  const webLoad = (candidate) => {
    const full = toFull(candidate)
    const abs = full ? resolveAbs(state, full) : null
    if (!abs || !isFile(abs)) return null
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }
  if (!name && line >= 1 && line <= lines.length) {
    const lineText = stripCommentsLine(lines[line - 1])
    let i = Math.min(col, lineText.length)
    let s = i
    while (s > 0 && /[A-Za-z0-9_$]/.test(lineText[s - 1])) s -= 1
    let e = i
    while (e < lineText.length && /[A-Za-z0-9_$]/.test(lineText[e])) e += 1
    const word = lineText.slice(s, e)
    if (word) name = word
  }
  // 1) click on an import/require line -> module target (+ named symbol line)
  if (line >= 1 && line <= lines.length) {
    for (const spec of iterModuleSpecs(text)) {
      if (spec.line !== line) continue
      const candidates = resolveWebModule(spec.mod, relInRoot, webExists)
      let target = null
      for (const candidate of candidates) {
        const full = toFull(candidate)
        if (full && webExists(candidate)) {
          target = full
          break
        }
      }
      if (!target) continue
      const targetRel = state.single() ? target : target.split('/').slice(1).join('/')
      const targetText = webLoad(targetRel) || ''
      const sym = name
      let targetLine = sym ? findDeclLine(targetText, sym) : null
      if (targetLine == null && sym === 'default') targetLine = findDefaultExportLine(targetText)
      if (targetLine == null) targetLine = findDefaultExportLine(targetText) || 1
      return { file: target, line: targetLine, impl: null, kind: kind || 'type', defName: sym || target.split('/').pop() }
    }
    // 2) Vue component tag
    if (VUE_FILE_RE.test(rel)) {
      const lineText = stripCommentsLine(lines[line - 1])
      RE_VUE_TAG.lastIndex = 0
      let m
      while ((m = RE_VUE_TAG.exec(lineText)) !== null) {
        const tag = m[1]
        const tagCol = m.index + m[0].indexOf(tag) + 1
        if (col < tagCol || col > tagCol + tag.length) continue
        if (WEB_BUILTIN_TAGS.has(tag.toLowerCase())) continue
        for (const candidate of vueComponentCandidates(tag, relInRoot)) {
          if (!webExists(candidate)) continue
          const full = toFull(candidate)
          const targetText = webLoad(candidate) || ''
          const declLine = findDeclLine(targetText, pascalFromTag(tag))
          return { file: full, line: declLine || 1, impl: null, kind: 'type', defName: pascalFromTag(tag) }
        }
      }
    }
  }
  // 3) local declarations, then imported symbols
  if (name) {
    const declLine = findDeclLine(text, name)
    if (declLine) return { file: rel, line: declLine, impl: null, kind: kind || 'variable', defName: name }
    const imported = findImportedSymbol(text, name)
    if (imported) {
      const candidates = resolveWebModule(imported.mod, relInRoot, webExists)
      for (const candidate of candidates) {
        if (!webExists(candidate)) continue
        const full = toFull(candidate)
        const targetRel = state.single() ? full : full.split('/').slice(1).join('/')
        const targetText = webLoad(targetRel) || ''
        if (imported.symbol && imported.symbol.namespace) {
          return { file: full, line: 1, impl: null, kind: kind || 'type', defName: name }
        }
        let targetLine = findDeclLine(targetText, imported.symbol)
        if (targetLine == null && imported.symbol === 'default') targetLine = findDefaultExportLine(targetText)
        if (targetLine == null) targetLine = 1
        return { file: full, line: targetLine, impl: null, kind: kind || 'variable', defName: imported.symbol }
      }
    }
  }
  return { error: '未找到定义' }
}

/* ------------------------------------------------------------- Kotlin glue */

/**
 * Kotlin is not what the standalone tool supported (`/api/java/def` rejected
 * `.kt`), but the plugin used to offer regex candidates for it. Keep a small
 * line-based resolver so clicking a Kotlin declaration still works instead of
 * always failing.
 */
function resolveKotlinDef(state, rel, text, line, col, name, kind) {
  const lines = String(text || '').split('\n')
  if (!name && line >= 1 && line <= lines.length) {
    const lineText = lines[line - 1]
    let i = Math.min(col, lineText.length)
    let s = i
    while (s > 0 && /[A-Za-z0-9_$]/.test(lineText[s - 1])) s -= 1
    let e = i
    while (e < lineText.length && /[A-Za-z0-9_$]/.test(lineText[e])) e += 1
    name = lineText.slice(s, e)
  }
  if (!name) return { error: '未找到定义' }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const funRe = new RegExp(`^\\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator)\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.?.<>]+\\s*\\.)?${escaped}\\s*\\(`)
  const valRe = new RegExp(`^\\s*(?:(?:public|private|protected|internal|override|open|const|lateinit|val|var)\\s+)*${escaped}\\s*(?::|\\s*=)`)
  const classRe = new RegExp(`^\\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum)\\s+)*(?:class|interface|object|enum\\s+class)\\s+${escaped}\\b`)
  for (let index = 0; index < lines.length; index += 1) {
    if (funRe.test(lines[index])) return { file: rel, line: index + 1, impl: null, kind: 'method', defName: name }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (classRe.test(lines[index])) return { file: rel, line: index + 1, impl: null, kind: 'type', defName: name }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (valRe.test(lines[index])) return { file: rel, line: index + 1, impl: null, kind: 'variable', defName: name }
  }
  return { error: '未找到定义' }
}

/* ---------------------------------------------------------------- entry */

/** Normalize a request path the way the standalone `/api/java/def` does. */
function resolveRequestPath(state, relPath, viewCommit) {
  const abs = resolveAbs(state, relPath)
  if (abs && isFile(abs)) return relOf(state, abs)
  // Old docs cite renamed directories; fall back to a basename search.
  const base = path.posix.basename(String(relPath || '').replace(/\\/g, '/'))
  if (!base) return null
  const found = searchFile(state, base, viewCommit, repoForRel(state, relPath).repo, rootInfo(state, relPath).rootAbs)
  if (found) return found
  if (viewCommit && pathInView(state, relPath, viewCommit)) return relPath
  return null
}

function deriveNameFromText(text, line, col) {
  const lines = String(text || '').split('\n')
  if (line < 1 || line > lines.length) return ''
  const lineText = lines[line - 1]
  const i = Math.min(col, lineText.length)
  let s = i
  while (s > 0 && /[A-Za-z0-9_$]/.test(lineText[s - 1])) s -= 1
  let e = i
  while (e < lineText.length && /[A-Za-z0-9_$]/.test(lineText[e])) e += 1
  return lineText.slice(s, e)
}

/**
 * Resolve one Ctrl+click request.
 * Returns `{ ok: true, file, line, kind, defName, impl }` or `{ error }`.
 */
export function resolveDefinition(state, body) {
  const request = body || {}
  const rawPath = String(request.path || '').replace(/\\/g, '/')
  if (!rawPath) return { error: '缺少 path' }
  const branch = request.branch ? String(request.branch) : ''
  const commit = request.commit ? String(request.commit) : ''
  if ((branch && !REV_RE.test(branch)) || (commit && !REV_RE.test(commit))) return { error: 'invalid branch/commit' }
  const viewCommit = commit || branch || ''

  let text = typeof request.text === 'string' ? request.text : ''
  if (text.length > MAX_TEXT_LEN) return { error: 'text too large' }

  const rel = resolveRequestPath(state, rawPath, viewCommit) || rawPath
  if (!text) {
    const loaded = loadFileContent(state, rel, viewCommit)
    if (loaded == null) return { error: 'invalid params' }
    text = loaded
  }
  if (!String(text).trim()) return { error: '解析失败' }

  let line = Number(request.line)
  let col = Number(request.col)
  let name = String(request.name || request.symbol || '').trim()
  if (!name && request.symbol) name = String(request.symbol).trim()
  if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1 || col < 1) {
    // Backward compatibility with the v1 client ({ path, symbol, context }).
    const symbol = name || String(request.symbol || '').trim()
    if (!symbol) return { error: 'invalid params' }
    const context = String(request.context || '').trim()
    const lines = String(text).split('\n')
    let foundLine = 0
    let foundCol = 0
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim()
      if (context && trimmed === context) {
        const at = lines[index].indexOf(symbol)
        if (at >= 0) {
          foundLine = index + 1
          foundCol = at + 1
          break
        }
      }
    }
    if (!foundLine) {
      const rx = new RegExp(`(?:^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w$]|$)`)
      for (let index = 0; index < lines.length; index += 1) {
        const m = rx.exec(lines[index])
        if (!m) continue
        foundLine = index + 1
        foundCol = m.index + m[0].indexOf(symbol) + 1
        break
      }
    }
    if (!foundLine) return { error: '未找到定义' }
    line = foundLine
    col = foundCol
    name = symbol
  }
  if (!name) name = deriveNameFromText(text, line, col)
  if (!name) return { error: '未找到定义' }

  const kind = typeof request.kind === 'string' ? request.kind : ''

  if (WEB_FILE_RE.test(rel)) {
    return resolveWebDef(state, rel, rootInfo(state, rel).relInRoot, text, line, col, name, kind)
  }
  if (/\.kts?$/i.test(rel)) {
    return resolveKotlinDef(state, rel, text, line, col, name, kind)
  }

  const model = parseModel(text, rel)
  if (!model) return { error: '解析失败' }
  if (!kind) {
    let firstError = null
    for (const candidateKind of ['method', 'type', 'variable']) {
      const result = resolveJavaDef(state, model, rel, line, col, name, candidateKind, viewCommit, text)
      if (result && !result.error) return result
      if (!firstError) firstError = result
    }
    return firstError || { error: '未找到定义' }
  }
  return resolveJavaDef(state, model, rel, line, col, name, kind, viewCommit, text)
}

/** Backward-compatible alias (the v1 API exported `findDefinitions`). */
export function findDefinitions(state, body) {
  return resolveDefinition(state, body)
}
