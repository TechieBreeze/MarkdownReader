/**
 * Symbol definition lookup (the plugin's replacement for the standalone tool's
 * Java/AST and JS/Vue resolvers).
 *
 * Deliberately source-level and bounded: a click sends the file plus the symbol;
 * we scan the surrounding repository for declarations and rank the candidates.
 * Java gets declaration-kind heuristics (class/interface/enum/record, method,
 * field); JS/TS also resolves relative imports before looking for declarations.
 */
import fs from 'node:fs'
import path from 'node:path'

const CODE_EXTS = new Set([
  '.java', '.kt', '.kts', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue',
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.mmd-cache', '__pycache__', '.idea', 'dist', 'build', 'target', '.gradle', '.next'])

function findGitRoot(abs) {
  let dir = abs
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
  } catch {
    return null
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function snippetAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 240)
}

/* --------------------------------------------------------------- Java scan */

const JAVA_DECL_RES = [
  { kind: 'type', re: (n) => new RegExp(`\\b(class|interface|enum|record|@interface)\\s+${n}\\b`, 'g') },
  { kind: 'method', re: (n) => new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\\s+)*[A-Za-z_$][\\w$<>,.\\[\\] \\t]*?[ \\t]+${n}\\s*\\(`, 'gm') },
  { kind: 'field', re: (n) => new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|final|volatile|transient)\\s+)*[A-Za-z_$][\\w$<>,.\\[\\] \\t]*?[ \\t]+${n}\\s*(?:=|;)`, 'gm') },
]

/* ----------------------------------------------------------------- Web scan */

function webDeclRes(name) {
  return [
    { kind: 'type', re: new RegExp(`\\b(?:class|interface|type|enum)\\s+${name}\\b`, 'g') },
    { kind: 'function', re: new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g') },
    { kind: 'function', re: new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function|\\()`, 'g') },
    { kind: 'export', re: new RegExp(`\\bexport\\s+(?:default\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`, 'g') },
  ]
}

function resolveImport(text, importFrom, fromAbs) {
  let target = importFrom
  if (!target.startsWith('.')) return null
  const baseDir = path.dirname(fromAbs)
  const base = path.resolve(baseDir, target)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.vue`, path.join(base, 'index.ts'), path.join(base, 'index.js'), path.join(base, 'index.tsx')]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // next candidate
    }
  }
  return null
}

/** If the clicked symbol is imported in this file, return the resolved target. */
function importedTarget(fileAbs, text, symbol) {
  const importRes = [
    new RegExp(`import\\s+[^;'"]*\\b${escapeRegExp(symbol)}\\b[^;'"]*from\\s*['"]([^'"]+)['"]`, 'g'),
    new RegExp(`import\\s*\\{[^}]*\\b${escapeRegExp(symbol)}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`, 'g'),
    new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${escapeRegExp(symbol)}\\b[^}]*\\}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g'),
    new RegExp(`(?:const|let|var)\\s+${escapeRegExp(symbol)}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g'),
  ]
  for (const re of importRes) {
    re.lastIndex = 0
    const match = re.exec(text)
    if (match) {
      const resolved = resolveImport(text, match[1], fileAbs)
      if (resolved) return resolved
    }
  }
  return null
}

/* -------------------------------------------------------------------- scan */

function walk(rootAbs, onFile) {
  const stack = [{ dir: rootAbs, depth: 0 }]
  let files = 0
  const started = Date.now()
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || SKIP_DIRS.has(dirent.name)) continue
      if (files > 8000 || Date.now() - started > 3000) return
      const abs = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < 14) stack.push({ dir: abs, depth: depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      if (!CODE_EXTS.has(path.extname(dirent.name).toLowerCase())) continue
      files += 1
      onFile(abs)
    }
  }
}

function scanFile(abs, relPathFn, symbol, importTarget, results) {
  let text
  try {
    const stat = fs.statSync(abs)
    if (stat.size > 4 * 1024 * 1024) return
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return
  }
  const name = escapeRegExp(symbol)
  const ext = path.extname(abs).toLowerCase()
  const isJava = ext === '.java' || ext === '.kt' || ext === '.kts'
  const res = isJava ? JAVA_DECL_RES.map(({ kind, re }) => ({ kind, re: re(name) })) : webDeclRes(name)
  const isTarget = importTarget && path.resolve(abs) === path.resolve(importTarget)
  for (const { kind, re } of res) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text)) !== null) {
      // For the `class|interface|...` groups, only accept the declaration name we asked for.
      const index = match.index + (match[0].length - match[0].trimStart().length)
      results.push({
        abs,
        path: relPathFn(abs),
        line: lineAt(text, index),
        kind,
        name: symbol,
        snippet: snippetAt(text, index),
        exact: !!isTarget,
      })
      if (match[0].length === 0) re.lastIndex += 1
    }
  }
}

export function findDefinitions(state, request) {
  const rel = String(request.path || '')
  const symbol = String(request.symbol || '')
  const context = String(request.context || '')
  if (!rel) throw new Error('缺少 path')
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol) || symbol.length > 80) throw new Error('无效的符号名')
  const abs = state.safePath(rel)
  const repoRoot = findGitRoot(abs) || path.dirname(abs)

  let text = ''
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    text = ''
  }
  const importTarget = importedTarget(abs, text, symbol)

  const results = []
  const relPathFn = (target) => state.relOf(target)
  const currentDir = path.dirname(abs)
  const currentRepo = repoRoot
  const preferType = /^[A-Z]/.test(symbol)

  const roots = importTarget ? [path.dirname(importTarget)] : [currentRepo]
  for (const root of roots) {
    walk(root, (fileAbs) => {
      // Imported symbol: only the target module needs to be scanned for its declaration.
      if (importTarget && path.resolve(fileAbs) !== path.resolve(importTarget)) return
      scanFile(fileAbs, relPathFn, symbol, importTarget, results)
    })
  }

  // If the import hop produced nothing, fall back to scanning the repository.
  if (!results.length && importTarget) {
    walk(currentRepo, (fileAbs) => scanFile(fileAbs, relPathFn, symbol, importTarget, results))
  }

  const seen = new Set()
  const scored = []
  for (const item of results) {
    const key = `${item.path}:${item.line}:${item.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    let score = 0
    if (item.exact) score += 40
    if (path.dirname(item.abs) === currentDir) score += 8
    if (path.resolve(item.abs) === path.resolve(abs)) score += 4
    if (preferType) {
      if (item.kind === 'type') score += 6
      if (item.kind === 'field') score -= 2
    } else {
      if (item.kind === 'method' || item.kind === 'function') score += 6
      if (item.kind === 'type') score += 2
    }
    if (context && item.snippet.includes(context)) score += 1
    scored.push({ ...item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  const candidates = scored.slice(0, 20).map(({ abs: _abs, exact: _exact, score: _score, ...rest }) => rest)
  return { ok: true, symbol, path: state.relOf(abs), repo: state.relOf(repoRoot), candidates }
}
