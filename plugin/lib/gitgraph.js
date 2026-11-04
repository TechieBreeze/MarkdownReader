/**
 * Git graph data for the 版本树 panel plus the repository inventory it needs.
 *
 * Read-only: `for-each-ref` + `log --all`. The client lays out lanes and draws
 * the SVG itself (the standalone tool dropped gitgraph.js for the same reason:
 * canvas output, unselectable text, poor dark colors).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.mmd-cache', '__pycache__', '.idea', 'dist', 'build', 'target', '.gradle', '.next', '.venv', 'venv'])

async function git(repo, args, timeout = 30000) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout,
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
    return null
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Bounded inventory of git repositories under the given roots (default: all). */
export function listRepos(state, roots) {
  const repos = []
  const seen = new Set()
  for (const root of roots && roots.length ? roots : state.roots()) {
    const stack = [{ dir: root.path, depth: 0 }]
    while (stack.length && repos.length < 300) {
      const { dir, depth } = stack.pop()
      let dirents
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue
        if (dirent.name.startsWith('.') || SKIP_DIRS.has(dirent.name)) continue
        const abs = path.join(dir, dirent.name)
        if (fs.existsSync(path.join(abs, '.git'))) {
          if (!seen.has(abs)) {
            seen.add(abs)
            repos.push({ repo: state.relOf(abs), name: path.basename(abs), path: state.relOf(abs) })
          }
          continue // a repo owns its subtree for this inventory
        }
        if (depth < 4) stack.push({ dir: abs, depth: depth + 1 })
      }
    }
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo, 'zh'))
  return repos
}

function parseRefs(decoration) {
  if (!decoration) return []
  return decoration
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('tag:'))
    .map((item) => item.replace(/^HEAD -> /, ''))
}

export async function gitGraph(state, url) {
  const rel = url.searchParams.get('path') || url.searchParams.get('repo') || ''
  if (!rel) throw new Error('缺少 path 或 repo')
  const abs = state.safePath(rel)
  const repoRoot = findGitRoot(abs)
  if (!repoRoot) throw new Error('该路径不在 git 仓库内')
  const limit = Math.min(400, Math.max(10, Number(url.searchParams.get('limit') || '200')))
  const branchText = await git(repoRoot, ['for-each-ref', '--format=%(refname:short)|%(objectname:short)', 'refs/heads/'])
  const branches = branchText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, hash] = line.split('|')
      return { name, hash }
    })
  const current = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const logText = await git(repoRoot, [
    'log',
    '--all',
    '--date-order',
    `--max-count=${limit}`,
    '--pretty=format:%H|%P|%an|%ad|%s|%D',
    '--date=format:%Y-%m-%d %H:%M',
  ])
  const commits = logText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, parents, author, date, subject, decoration] = line.split('|')
      return {
        hash,
        short: hash.slice(0, 7),
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        date,
        subject: String(subject || ''),
        refs: parseRefs(decoration),
      }
    })
  return {
    ok: true,
    repo: state.relOf(repoRoot),
    name: path.basename(repoRoot),
    current,
    branches,
    commits,
  }
}
