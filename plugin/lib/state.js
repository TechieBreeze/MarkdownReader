/**
 * Workspace roots and path resolution.
 *
 * Mirrors the standalone reader's multi-root contract:
 *  - one root: relative paths have no prefix;
 *  - more than one root: every path a client sees is prefixed with a virtual
 *    top directory `<vtop>/` named after the root's basename (deduped _2/_3),
 *    and `safePath`/`relOf`/`rootFor` are the ONLY places that translate.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HIDDEN_DIR_NAMES = new Set(['.git', 'node_modules', '.mmd-cache', '__pycache__', '.idea', '.vscode-server'])
export const CODE_EXTS = new Set([
  '.java', '.kt', '.kts', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue',
  '.py', '.go', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp', '.scala',
  '.xml', '.yml', '.yaml', '.json', '.properties', '.sql', '.sh', '.bat', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.gradle', '.toml', '.md',
])
export const MARKDOWN_EXTS = new Set(['.md', '.markdown'])

function stateFilePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'markdown-reader.state.json')
}

function readStateFile() {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeStateFile(value) {
  try {
    const file = stateFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    // A read-only home is not a reason to break the reader; roots stay in memory.
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function dedupeVirtualNames(paths) {
  const used = new Set()
  return paths.map((rootPath) => {
    const base = path.basename(rootPath) || 'root'
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}_${n++}`
    used.add(name)
    return { name, path: rootPath }
  })
}

export function createState(config = {}) {
  const packageDir = config.packageDir || process.cwd()
  // The standalone tool's default root was two levels above the tool dir; from
  // inside `<tool>/dsh-plugin` that is three levels up.
  const fallbackRoot = path.resolve(packageDir, '..', '..', '..')
  const persisted = readStateFile()
  const configured = Array.isArray(config.roots) ? config.roots.filter((p) => typeof p === 'string' && p) : []
  const remembered = Array.isArray(persisted.roots) ? persisted.roots.filter((p) => typeof p === 'string' && p) : []

  let roots = []
  for (const p of [...configured, ...remembered]) {
    const abs = path.resolve(p)
    if (!roots.some((r) => r.path === abs) && isDir(abs)) roots.push({ path: abs })
  }
  if (roots.length === 0 && isDir(fallbackRoot)) roots.push({ path: fallbackRoot })

  const state = {
    packageDir,
    config: { ...config },
    _roots: dedupeVirtualNames(roots.map((r) => r.path)),
    // When this plugin instance registered. The Harness only re-reads the
    // client bundle when the plugin is (re-)registered, so this timestamp is
    // how one tells "the Host restarted" from "the Host kept the old client
    // snapshot".
    startedAt: new Date().toISOString(),

    roots() {
      return this._roots.map((r) => ({ name: r.name, path: r.path }))
    },

    single() {
      return this._roots.length === 1
    },

    /** Client-visible root metadata (same shape for 1 or N roots). */
    meta() {
      return { ok: true, roots: this.roots(), single: this.single() }
    },

    persistRoots() {
      writeStateFile({ roots: this._roots.map((r) => r.path) })
    },

    addRoot(input) {
      const abs = path.resolve(String(input || ''))
      if (!isDir(abs)) throw new Error(`目录不存在: ${abs}`)
      if (!this._roots.some((r) => r.path === abs)) {
        this._roots = dedupeVirtualNames([...this._roots.map((r) => r.path), abs])
        this.persistRoots()
      }
      return this.meta()
    },

    removeRoot(input) {
      const abs = path.resolve(String(input || ''))
      this._roots = this._roots.filter((r) => r.path !== abs)
      this.persistRoots()
      return this.meta()
    },

    /** Root entry owning a canonical absolute path, if any. */
    rootForAbs(abs) {
      const normalized = path.resolve(abs)
      let best = null
      for (const root of this._roots) {
        const rp = path.resolve(root.path)
        if (normalized === rp || normalized.startsWith(rp + path.sep)) {
          if (!best || rp.length > best.path.length) best = { name: root.name, path: rp }
        }
      }
      return best
    },

    /** Resolve a client path (optionally vtop-prefixed, or absolute) to an absolute path. */
    safePath(rel) {
      const raw = String(rel == null ? '' : rel).replace(/\\/g, '/')
      if (!raw) {
        if (this._roots.length === 0) throw new Error('没有打开任何工作区根')
        return this._roots[0].path
      }
      if (path.isAbsolute(raw)) {
        const root = this.rootForAbs(raw)
        if (!root) throw new Error(`路径不在工作区内: ${raw}`)
        return path.resolve(raw)
      }
      const parts = raw.split('/').filter((p) => p !== '' && p !== '.')
      let root
      let rest = parts
      if (!this.single()) {
        const candidate = this._roots.find((r) => r.name === parts[0])
        if (candidate) {
          root = candidate
          rest = parts.slice(1)
          // Defensive: an older client (or stale persisted tree state) sometimes
          // emits the project prefix twice (`<vtop>/<vtop>/…`). Accept it when the
          // repeated form does not exist on disk.
          if (rest.length > 1 && rest[0] === candidate.name && !fs.existsSync(path.resolve(root.path, ...rest))) {
            rest = rest.slice(1)
          }
        }
      }
      if (!root) {
        // Bare relative path: first root that actually contains it.
        for (const r of this._roots) {
          const candidate = path.resolve(r.path, ...rest)
          if (fs.existsSync(candidate)) {
            root = r
            break
          }
        }
        if (!root) root = this._roots[0]
        if (!root) throw new Error('没有打开任何工作区根')
      }
      const resolved = path.resolve(root.path, ...rest)
      const guard = path.resolve(root.path)
      if (resolved !== guard && !resolved.startsWith(guard + path.sep)) {
        throw new Error(`越界路径: ${raw}`)
      }
      // Reject `..` escapes that normalize back outside, even when a root prefix exists.
      return resolved
    },

    /** Client-visible path for a canonical absolute path. */
    relOf(abs) {
      const normalized = path.resolve(abs)
      const root = this.rootForAbs(normalized)
      if (!root) return normalized.replace(/\\/g, '/')
      const rel = path.relative(root.path, normalized).replace(/\\/g, '/')
      if (this.single()) return rel
      return rel ? `${root.name}/${rel}` : root.name
    },
  }

  return state
}

export { HIDDEN_DIR_NAMES }
