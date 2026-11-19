/**
 * Fetch a file from a REMOTE repository - for the repository links whose
 * project is not in the workspace.
 *
 * The user (2026-11-19): 「线上代码链接在没解析出本地文件的情况下直接点击的
 * 行为也不应退化为和shift+点击一样打开网站链接，应该从线上获取代码然后开代码
 * 弹窗」 - a link that cannot be resolved locally must still OPEN THE CODE,
 * not the web page.
 *
 * WHY GIT AND NOT THE WEB ENDPOINTS: the workspace remotes carry an ACCOUNT
 * PASSWORD (`https://user:pass@git.example/group/project.git`). Git accepts
 * it, the GitLab web endpoints do NOT: `/-/raw/<ref>/<path>` answers with the
 * SIGN-IN page (verified: HTTP 200 + `devise-layout-html`) and the API v4
 * answers 401 for both `PRIVATE-TOKEN` and basic auth. Git itself is the only
 * transport that works with the credentials the user already has, and it is
 * the one the clones were made with.
 *
 * Two ways to reach the file, in this order:
 *   1. a LOCAL repository of the same project → `git show <ref>:<file>`.
 *      No network at all when the object is already there, and the fetch
 *      (when it is not) uses the repository's own credentials.
 *   2. no local repository → a cached BARE repository per project under the
 *      temp dir, fetched with the credentials of a workspace repository on the
 *      same host.
 *
 * Only hosts that appear in a workspace repository's `origin` are reachable:
 * a document must not be able to make the Host talk to an arbitrary server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { allGitRepos } from './defs.js'

const execFileAsync = promisify(execFile)

/** The markers that introduce the ref + file part of a repository-view URL. */
const BLOB_MARKERS = ['/-/blob/', '/-/raw/', '/blob/', '/raw/']

/** How long a cached ref list / bare repository may stay around. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** repo dir -> { at, refs } - the remote ref list of a project. */
const refListCache = new Map()
/** cache dir -> { at } - the bare repositories we fetched. */
const cacheRepoAges = new Map()
/** repo dir -> { at, origin } - the `origin` URL of a local repository. */
const originCache = new Map()

/** How long an origin URL / a local ref list may be reused. */
const ORIGIN_TTL_MS = 5 * 60 * 1000

async function gitRaw(args, timeout = 30000) {
  const { stdout } = await execFileAsync('git', args, {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function git(repo, args, timeout = 30000) {
  return gitRaw(['-C', repo, ...args], timeout)
}

async function gitQuiet(repo, args, timeout = 30000) {
  try {
    return (await git(repo, args, timeout)).trim()
  } catch {
    return ''
  }
}

/**
 * Split a repository-view URL into its parts.
 *
 * @returns {{host:string, projectPath:string, project:string, tail:string, line:number|null}|null}
 */
export function parseRemoteBlobUrl(url) {
  const text = String(url || '').trim()
  if (!/^https?:\/\//i.test(text)) return null
  const host = hostOf(text)
  if (!host) return null
  const rest0 = text.slice(text.indexOf('://') + 3 + host.length + 1)
  let rest = rest0
  let line = null
  const lineMatch = /#L(\d+)/.exec(rest)
  if (lineMatch) {
    line = Number(lineMatch[1])
    rest = rest.slice(0, lineMatch.index)
  }
  for (const marker of BLOB_MARKERS) {
    const at = rest.indexOf(marker)
    if (at < 0) continue
    const head = rest.slice(0, at).replace(/\.git$/, '')
    const tail = rest.slice(at + marker.length)
    const segs = head.split('/').filter(Boolean)
    if (!segs.length || !tail) return null
    return { host, projectPath: segs.join('/'), project: segs[segs.length - 1], tail, line }
  }
  return null
}

/**
 * The credentials of a repository URL, if it carries them.
 *
 * @returns {{user:string, pass:string}|null}
 */
export function credentialsOf(remoteUrl) {
  const m = /^https?:\/\/([^/@]+)@(.+)$/i.exec(String(remoteUrl || '').trim())
  if (!m) return null
  const at = m[1].indexOf(':')
  if (at < 0) return null
  const decode = (text) => {
    try {
      return decodeURIComponent(text)
    } catch {
      return text
    }
  }
  return { user: decode(m[1].slice(0, at)), pass: decode(m[1].slice(at + 1)) }
}

/** The origin URL of a local repository (empty when it has none). */
async function originOf(repo) {
  const hit = originCache.get(repo)
  if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.origin
  const origin = (await gitQuiet(repo, ['remote', 'get-url', 'origin'], 10000)) || ''
  originCache.set(repo, { at: Date.now(), origin })
  return origin
}

/** The host of a URL, without the userinfo (`https://user:pass@host/...`). */
function hostOf(url) {
  const m = /^https?:\/\/(?:[^/@]+@)?([^/]+)/i.exec(String(url || '').trim())
  return m ? m[1] : ''
}

/** The host + project of a repository URL. */
function originParts(origin) {
  const text = String(origin || '').trim()
  const m = /^https?:\/\/(?:[^/@]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(text)
  if (!m) return null
  return { host: m[1], projectPath: m[2].replace(/\.git$/, '') }
}

/** Every repository of the workspace, with its origin URL. */
async function workspaceRepos(state) {
  const repos = []
  // The discovery is already cached in defs.js - do NOT walk the tree again.
  let dirs = []
  try {
    dirs = allGitRepos(state) || []
  } catch {
    dirs = []
  }
  for (const dir of dirs) {
    repos.push({ dir, origin: await originOf(dir) })
  }
  return repos
}

/**
 * The branch/tag names of a repository.
 *
 * The LOCAL refs come first: they are free (no network) and they cover the
 * branches the user has. The remote list is only consulted when the local one
 * does not know the ref.
 */
async function localRefs(repo) {
  const out = await gitQuiet(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/tags'], 15000)
  const refs = new Set()
  for (const line of out.split(/\r?\n/)) {
    const name = line.trim()
    if (name) refs.add(name)
  }
  return refs
}

/**
 * The remote ref list of a project (branch and tag names).
 *
 * @returns {Promise<Set<string>>} empty when the remote cannot be reached.
 */
async function remoteRefs(repo) {
  if (!repo) return new Set()
  const hit = refListCache.get(repo)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.refs
  const out = await gitQuiet(repo, ['ls-remote', '--heads', '--tags', 'origin'], 30000)
  const refs = new Set()
  for (const line of out.split(/\r?\n/)) {
    const m = /^[0-9a-f]{40}\s+(\S+)$/i.exec(line.trim())
    if (!m) continue
    const name = m[1].replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')
    refs.add(name)
  }
  refListCache.set(repo, { at: Date.now(), refs })
  return refs
}

/**
 * Split "ref/and/the/file.java" into the ref and the file path.
 *
 * A ref may contain slashes (`feature/x`), so the LONGEST prefix that is a
 * known branch/tag wins. A pinned commit is a hash in the first segment.
 */
export function splitRefAndFile(tail, refs) {
  const segs = String(tail || '').split('/').filter(Boolean)
  if (segs.length < 2) return null
  if (/^[0-9a-f]{7,40}$/i.test(segs[0])) return { ref: segs[0], file: segs.slice(1).join('/') }
  const known = refs instanceof Set ? refs : new Set(refs || [])
  for (let k = Math.min(segs.length - 1, 8); k >= 1; k -= 1) {
    const ref = segs.slice(0, k).join('/')
    if (known.has(ref)) return { ref, file: segs.slice(k).join('/') }
  }
  return null
}

/** The bare repository cache of one project. */
function cacheDirFor(host, projectPath) {
  const safe = `${host}__${projectPath}`.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return path.join(os.tmpdir(), 'markdown-reader-remote', safe)
}

/**
 * The URL of a project WITH the credentials of a workspace repository.
 *
 * @returns {Promise<string|null>} null when no repository of that host is known.
 */
async function authenticatedUrl(repos, host, projectPath) {
  for (const repo of repos) {
    const parts = originParts(repo.origin)
    if (!parts || parts.host !== host) continue
    const cred = credentialsOf(repo.origin)
    if (!cred) continue
    return `https://${encodeURIComponent(cred.user)}:${encodeURIComponent(cred.pass)}@${host}/${projectPath}.git`
  }
  return null
}

/** The bare repository of a project, created on demand. */
async function ensureCacheRepo(host, projectPath, authUrl) {
  const dir = cacheDirFor(host, projectPath)
  const age = cacheRepoAges.get(dir)
  if (age && Date.now() - age.at < CACHE_TTL_MS && fs.existsSync(path.join(dir, 'HEAD'))) return dir
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
  } catch {
    return null
  }
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      await gitRaw(['init', '--bare', '--quiet', dir], 20000)
      await git(dir, ['remote', 'add', 'origin', authUrl], 20000)
    } catch {
      return null
    }
  }
  cacheRepoAges.set(dir, { at: Date.now() })
  return dir
}

/** Read a file out of a git repository at a ref. */
async function readFileAtRef(repo, ref, file) {
  if (!repo) return null
  // The object may already be there (the branch was fetched before).
  const known = await gitQuiet(repo, ['cat-file', '-e', `${ref}^{commit}`], 10000)
  if (!known) {
    try {
      await git(repo, ['fetch', '--depth', '1', '--quiet', 'origin', ref], 120000)
    } catch {
      return null
    }
  }
  try {
    return await git(repo, ['show', `${ref}:${file}`], 30000)
  } catch {
    // The ref was just fetched: FETCH_HEAD holds it.
    try {
      return await git(repo, ['show', `FETCH_HEAD:${file}`], 30000)
    } catch {
      return null
    }
  }
}

/**
 * Fetch a ref into the cached bare repository and return its sha.
 *
 * The cached repository is a scratch clone: a `--depth 1` fetch there is fine
 * (it is what makes the fetch cheap) and the USER's clone is never touched.
 */
async function fetchIntoCache(dir, ref) {
  const known = await gitQuiet(dir, ['cat-file', '-e', `${ref}^{commit}`], 10000)
  if (known) {
    const sha = await gitQuiet(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10000)
    if (sha) return sha
  }
  try {
    await git(dir, ['fetch', '--depth', '1', '--quiet', 'origin', ref], 120000)
  } catch {
    return null
  }
  return (await gitQuiet(dir, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD'], 10000)) || null
}

/**
 * The cached bare repository of a local repository's project, with the ref
 * fetched into it.
 *
 * @returns {Promise<{dir:string, sha:string}|null>}
 */
export async function remoteRepoDir(repoDir, ref) {
  if (!repoDir) return null
  const origin = await originOf(repoDir)
  const parts = originParts(origin)
  if (!parts) return null
  const dir = await ensureCacheRepo(parts.host, parts.projectPath, origin)
  if (!dir) return null
  if (!ref) return { dir, sha: '' }
  const sha = await fetchIntoCache(dir, ref)
  if (!sha) return null
  return { dir, sha }
}

/**
 * Read a file at a ref that the local repository does NOT have - from the
 * REMOTE, without touching the local repository.
 *
 * The local clone is left alone on purpose: `git fetch --depth 1` into it would
 * write `.git/shallow` and turn the user's clone into a SHALLOW repository.
 * The file is read from the cached bare repository of the project instead.
 *
 * @returns {Promise<string|null>} the file content, null when it is not there.
 */
export async function readRemoteFile(repoDir, ref, file) {
  if (!repoDir || !ref || !file) return null
  const remote = await remoteRepoDir(repoDir, ref)
  if (!remote) return null
  try {
    return await git(remote.dir, ['show', `${remote.sha}:${file}`], 30000)
  } catch {
    return null
  }
}

/**
 * The patch of a commit that the local repository does not have.
 *
 * @returns {Promise<string|null>}
 */
export async function readRemotePatch(repoDir, ref, file) {
  if (!repoDir || !ref) return null
  const remote = await remoteRepoDir(repoDir, ref)
  if (!remote) return null
  try {
    return await git(remote.dir, ['show', '--format=', '--patch', '--unified=3', remote.sha, '--', file], 60000)
  } catch {
    return null
  }
}

/**
 * Fetch a file from a remote repository.
 *
 * @returns {Promise<{ok:boolean, error?:string, content?:string, path?:string,
 *   ref?:string, repo?:string, line?:number, source?:string}>}
 */
export async function fetchRemoteFile(state, url) {
  const parsed = parseRemoteBlobUrl(url)
  if (!parsed) return { ok: false, error: '无法识别的仓库链接' }
  const { host, projectPath, project, tail, line } = parsed
  const repos = await workspaceRepos(state)
  // The local repository of the same project, if the workspace has one, and
  // the credentials of that host (the local repo may be another project).
  let local = null
  let hostKnown = false
  for (const repo of repos) {
    const parts = originParts(repo.origin)
    if (!parts || parts.host !== host) continue
    hostKnown = true
    if (parts.projectPath === projectPath || parts.projectPath.split('/').pop() === project) {
      local = repo
      break
    }
  }
  if (!hostKnown) return { ok: false, error: `工作区里没有 ${host} 的仓库，无法取线上文件` }

  let cacheDir = null
  let refs = new Set()
  if (local) {
    // The LOCAL branches are free; the remote list is the fallback for a ref
    // the clone does not have (a branch that was created after the clone).
    refs = await localRefs(local.dir)
    const localSplit = splitRefAndFile(tail, refs)
    if (!localSplit) {
      refs = await remoteRefs(local.dir)
    }
  } else {
    const authUrl = await authenticatedUrl(repos, host, projectPath)
    if (!authUrl) return { ok: false, error: `工作区里没有 ${host} 的凭据，无法取线上文件` }
    cacheDir = await ensureCacheRepo(host, projectPath, authUrl)
    if (!cacheDir) return { ok: false, error: '无法创建线上文件缓存' }
    refs = await remoteRefs(cacheDir)
  }
  const split = splitRefAndFile(tail, refs)
  if (!split) return { ok: false, error: '无法识别链接里的版本（ref）' }
  const { ref, file } = split

  let content = null
  let source = ''
  if (local) {
    source = 'local'
    content = await readFileAtRef(local.dir, ref, file)
  }
  if (content == null && cacheDir) {
    source = 'remote'
    content = await readFileAtRef(cacheDir, ref, file)
  }
  if (content == null) {
    // No local repository of that project: fetch it into the cache.
    const authUrl = await authenticatedUrl(repos, host, projectPath)
    if (!authUrl) return { ok: false, error: `工作区里没有 ${host} 的凭据，无法取线上文件` }
    cacheDir = cacheDir || (await ensureCacheRepo(host, projectPath, authUrl))
    if (!cacheDir) return { ok: false, error: '无法创建线上文件缓存' }
    source = 'remote'
    content = await readFileAtRef(cacheDir, ref, file)
  }
  if (content == null) return { ok: false, error: `线上仓库里没有 ${ref}:${file}` }
  return { ok: true, content, path: file, ref, repo: projectPath, line: line || 0, source }
}
