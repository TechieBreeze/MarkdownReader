/**
 * "同步/检查更新" for the plugin package itself.
 *
 * The standalone tool shipped this feature so one machine could develop the
 * reader while another pulled it: it configures an origin remote and branches,
 * then offers status (fetch) and a fast-forward pull. The plugin keeps the same
 * contract for its own package repository.
 *
 * Configuration (plugin row config): `syncRepo` (remote URL) and `syncBranch`
 * (branch, default the current one). When absent, the repository's own `origin`
 * is used; without any remote the endpoints report `configured: false` with a
 * human-readable reason instead of failing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(repo, args, timeout = 60000) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function gitQuiet(repo, args, timeout = 60000) {
  try {
    return (await git(repo, args, timeout)).trim()
  } catch {
    return ''
  }
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

export function syncConfig(state) {
  const config = state.config || {}
  const repoRoot = findGitRoot(state.packageDir || process.cwd())
  return {
    repoRoot,
    repoConfigured: String(config.syncRepo || '').trim(),
    branchConfigured: String(config.syncBranch || '').trim(),
  }
}

async function resolveRemote(repoRoot, configured) {
  if (configured) return configured
  return gitQuiet(repoRoot, ['remote', 'get-url', 'origin'])
}

export async function syncStatus(state, wantFetch) {
  const { repoRoot, repoConfigured, branchConfigured } = syncConfig(state)
  if (!repoRoot) {
    return { ok: true, configured: false, reason: '插件目录不在 git 仓库内，无法检查更新', repo: '', branch: '', current: '' }
  }
  const current = await gitQuiet(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchConfigured || current
  const remote = await resolveRemote(repoRoot, repoConfigured)
  const base = {
    ok: true,
    configured: !!remote,
    repo: state.relOf ? state.relOf(repoRoot) : repoRoot,
    branch,
    current,
    remote,
    behind: 0,
    ahead: 0,
    dirty: false,
    fetched: false,
    commits: [],
    reason: '',
  }
  if (!remote) {
    base.reason = '未配置同步远程仓库：可在插件 config 里设置 syncRepo / syncBranch，或给插件所在 git 仓库添加 origin 远程'
    return base
  }
  const dirtyText = await gitQuiet(repoRoot, ['status', '--porcelain'])
  base.dirty = !!dirtyText
  if (!wantFetch) return base
  try {
    await execFileAsync('git', ['-C', repoRoot, 'fetch', '--prune', remote], {
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    base.reason = `拉取远程失败: ${String((error && (error.stderr || error.message)) || error).trim()}`
    return base
  }
  base.fetched = true
  let remoteRef = ''
  try {
    remoteRef = (await git(repoRoot, ['rev-parse', `refs/remotes/origin/${branch}`])).trim()
  } catch {
    try {
      remoteRef = (await git(repoRoot, ['rev-parse', `FETCH_HEAD`])).trim()
    } catch {
      remoteRef = ''
    }
  }
  let localRef = ''
  try {
    localRef = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()
  } catch {
    localRef = ''
  }
  if (remoteRef && localRef) {
    const counts = (await gitQuiet(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])).split(/\s+/)
    base.ahead = Number(counts[0] || 0)
    base.behind = Number(counts[1] || 0)
    const logText = await gitQuiet(repoRoot, [
      'log',
      '--pretty=format:%H|%an|%ad|%s',
      '--date=format:%Y-%m-%d %H:%M',
      `-20`,
      `HEAD..${remoteRef}`,
    ])
    base.commits = logText
      ? logText.split(/\r?\n/).filter(Boolean).map((line) => {
          const [hash, author, date, ...subject] = line.split('|')
          return { hash, short: hash.slice(0, 7), author, date, subject: subject.join('|') }
        })
      : []
  }
  return base
}

export async function syncPull(state) {
  const status = await syncStatus(state, true)
  if (!status.configured) return { ok: false, error: status.reason || '未配置同步远程仓库', status }
  const { repoRoot, branchConfigured } = syncConfig(state)
  const branch = branchConfigured || status.branch
  if (status.behind === 0) {
    return { ok: true, changed: false, before: status.current, after: status.current, status, note: '已是最新，无需更新' }
  }
  if (status.dirty) {
    return { ok: false, error: '插件目录有未提交的本地改动，已取消拉取（避免覆盖）', status }
  }
  const before = (await gitQuiet(repoRoot, ['rev-parse', 'HEAD'])) || ''
  try {
    await git(repoRoot, ['pull', '--ff-only', 'origin', branch], 180000)
  } catch (error) {
    return {
      ok: false,
      error: `拉取失败: ${String((error && (error.stderr || error.message)) || error).trim()}`,
      before,
      status,
    }
  }
  const after = (await gitQuiet(repoRoot, ['rev-parse', 'HEAD'])) || before
  return {
    ok: true,
    changed: before !== after,
    before,
    after,
    status: await syncStatus(state, false),
    note: before !== after ? '已更新。Client 代码刷新页面生效；Host 代码需在插件管理器里把 bundle 禁用再启用' : '已是最新',
  }
}
