/**
 * Repository-view link resolution: turn a remote GitLab/GitHub file URL inside a
 * document into the local workspace file (+ the ref/branch it points at).
 *
 * Docs cite code as `https://git.example.com/group/microservices/customer/-/blob/
 * test2.0_merge20240312/src/main/java/.../CustomerApi.java#L143`. The local
 * checkout lives at `gits/customer/...`, so the tail is matched by suffix: the
 * ref may itself contain slashes, so the longest matching suffix decides where
 * the ref ends and the file path begins.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BLOB_MARKERS = ['/-/blob/', '/blob/', '/-/raw/', '/raw/']
const refCache = new Map()
const filesCache = new Map()

async function git(repo, args, timeout = 20000) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function gitQuiet(repo, args) {
  try {
    return (await git(repo, args)).trim()
  } catch {
    return ''
  }
}

export function parseRepoUrl(url) {
  const text = String(url || '').trim()
  if (!/^https?:\/\//i.test(text)) return null
  const afterHost = /^https?:\/\/[^/]+\/(.+)$/.exec(text)
  if (!afterHost) return null
  let rest = afterHost[1]
  let line = null
  const lineMatch = /#L(\d+)/.exec(rest)
  if (lineMatch) {
    line = Number(lineMatch[1])
    rest = rest.slice(0, lineMatch.index)
  }
  for (const marker of BLOB_MARKERS) {
    const at = rest.indexOf(marker)
    if (at < 0) continue
    const head = rest.slice(0, at)
    const tail = rest.slice(at + marker.length)
    const segs = head.split('/').filter(Boolean)
    if (!segs.length || !tail) return null
    return { project: segs[segs.length - 1], tail, line }
  }
  return null
}

async function filesByBase(repo) {
  if (filesCache.has(repo)) return filesCache.get(repo)
  const text = await gitQuiet(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
  const map = new Map()
  for (const rel of text.split(/\r?\n/)) {
    const clean = rel.replace(/\\/g, '/')
    if (!clean) continue
    const base = path.posix.basename(clean)
    if (!map.has(base)) map.set(base, [])
    map.get(base).push(clean)
  }
  filesCache.set(repo, map)
  return map
}

async function refExists(repo, ref) {
  if (!ref) return false
  const key = `${repo}\u0000${ref}`
  if (refCache.has(key)) return refCache.get(key)
  for (const name of [ref, `origin/${ref}`]) {
    const out = await gitQuiet(repo, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])
    if (out) {
      refCache.set(key, true)
      return true
    }
  }
  refCache.set(key, false)
  return false
}

function projectCandidates(state, project, preferRootName) {
  const candidates = []
  const add = (dir) => {
    try {
      if (fs.statSync(dir).isDirectory() && !candidates.includes(dir)) candidates.push(dir)
    } catch {
      // not there
    }
  }
  // 1) the plain layout (`gits/<project>`), preferred root first
  const roots = state.roots().filter((root) => (preferRootName ? root.name === preferRootName : true))
  for (const root of roots) add(path.join(root.path, 'gits', project))
  for (const root of state.roots()) {
    add(path.join(root.path, 'gits', project))
    add(path.join(root.path, project))
  }
  if (candidates.length) return candidates
  // 2) nested repositories: the remote project name can be a repo checked out
  //    inside another repo (`gits/core/data-excel`). Walk every root (bounded)
  //    for a directory named like the project that owns a `.git`.
  for (const root of state.roots()) {
    const queue = [{ dir: root.path, depth: 0 }]
    while (queue.length && candidates.length < 8) {
      const { dir, depth } = queue.shift()
      let dirents
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue
        if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
        const abs = path.join(dir, dirent.name)
        if (dirent.name === project && fs.existsSync(path.join(abs, '.git'))) {
          add(abs)
          continue
        }
        if (depth < 5) queue.push({ dir: abs, depth: depth + 1 })
      }
    }
  }
  return candidates
}

/** Resolve one remote repo URL; null when it does not map to the workspace. */
export async function resolveRepoUrl(state, url, preferRootName) {
  const info = parseRepoUrl(url)
  if (!info) return null
  const { project, tail, line } = info
  const segs = tail.split('/').filter(Boolean)
  const candidates = projectCandidates(state, project, preferRootName)
  for (const repo of candidates) {
    const map = await filesByBase(repo)
    if (!map.size) continue
    for (let k = 0; k < segs.length; k += 1) {
      const suffix = segs.slice(k).join('/')
      const base = path.posix.basename(suffix)
      if (!base || base.indexOf('.') < 0) continue
      for (const rel of map.get(base) || []) {
        const relN = rel.replace(/\\/g, '/')
        if (relN !== suffix && !relN.endsWith('/' + suffix)) continue
        const abs = path.join(repo, ...relN.split('/'))
        const ref = segs.slice(0, k).join('/')
        return {
          path: state.relOf(abs),
          line,
          repo: project,
          repoDir: state.relOf(repo),
          ref,
          refExists: await refExists(repo, ref),
        }
      }
    }
  }
  return null
}

/** Batch resolve (the document may cite dozens of links). */
export async function resolveRepoUrls(state, urls, preferPath) {
  const preferRootName = (() => {
    const rel = String(preferPath || '')
    if (!rel) return ''
    const first = rel.split('/')[0]
    return state.roots().some((root) => root.name === first) ? first : ''
  })()
  const resolved = {}
  for (const raw of urls) {
    const url = String(raw || '')
    if (!url || resolved[url]) continue
    try {
      const hit = await resolveRepoUrl(state, url, preferRootName)
      if (hit) resolved[url] = hit
    } catch {
      // one bad URL must not fail the batch
    }
  }
  return resolved
}
