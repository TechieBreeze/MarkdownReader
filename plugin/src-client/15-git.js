/**
 * Code-tab git viewer (owned by the git slice): branch/commit selection, the
 * commit-version diff view, and the per-file view state / metadata caches.
 *
 * Everything here is read-only: the host exposes only git log/show/for-each-ref
 * style endpoints, the working tree is never touched. State is cached per
 * relative path at module level so switching tabs (CodeView remounts) keeps the
 * selected branch / commit, while the App still owns the tab objects themselves.
 */

/** Rows above this count are virtualized (only the viewport +/- buffer is painted). */
const GIT_V_THRESHOLD = 1500
/** Constant row height, kept in sync with .mdr-cl CSS (min-height/line-height 20px). */
const GIT_LINE_H = 20
/** Extra rows painted above and below the viewport in virtual mode. */
const GIT_BUFFER = 40

const gitMetaCache = new Map() // path -> Promise<meta|null>
const gitViewCache = new Map() // path -> mutable view state

function gitViewFor(path) {
  const key = String(path || '')
  let view = gitViewCache.get(key)
  if (!view) {
    view = {
      ready: false,
      git: false,
      repo: '',
      currentBranch: '',
      branch: '',
      branches: [],
      commits: [],
      commit: null,
      commitMeta: null,
      fileLines: null,
      hunks: [],
      hint: '',
      loading: false,
      stats: { add: 0, del: 0 },
      seq: 0, // race guard: bumped on every branch/commit selection
      branchContent: null, // content of the selected branch's HEAD (null = workspace content)
    }
    gitViewCache.set(key, view)
  }
  return view
}

/** Load /api/git/meta once per path (null = not inside a git repository). */
function loadGitMeta(path) {
  const key = String(path || '')
  const cached = gitMetaCache.get(key)
  if (cached) return cached
  const promise = fetchJson('/api/git/meta', { path: key })
    .then((payload) => {
      if (!payload || !Array.isArray(payload.branches) || payload.branches.length === 0) return null
      return {
        repo: payload.repo || '',
        branch: payload.branch || payload.currentBranch || '',
        currentBranch: payload.currentBranch || '',
        branches: payload.branches,
        commits: Array.isArray(payload.commits) ? payload.commits : [],
      }
    })
    .catch(() => null) // non-git file / host error -> hide the bar quietly
  gitMetaCache.set(key, promise)
  return promise
}

/** Full file at a commit + this commit's hunks -> the row sequence to render. */
function buildDiffRows(fileLines, hunks) {
  const rows = []
  const hasFile = Array.isArray(fileLines)
  let fileIdx = 0 // 0-based cursor into the commit-version file
  const pushFile = () => {
    rows.push({ no: fileIdx + 1, kind: 'plain', text: fileLines[fileIdx] == null ? '' : fileLines[fileIdx] })
    fileIdx += 1
  }
  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    const newStart = Number(hunk.new_start) || 1
    while (hasFile && fileIdx < newStart - 1) pushFile()
    for (const line of hunk.lines || []) {
      const text = line.text == null ? '' : line.text
      if (line.type === '-') {
        // Deleted lines have no position in the commit-version file: show them
        // inline at their old-file position, numbered with the OLD line number.
        rows.push({ no: line.old_no, kind: 'del', text })
      } else if (line.type === '+') {
        rows.push({ no: line.new_no, kind: 'add', text })
        fileIdx += 1
      } else {
        rows.push({ no: line.new_no, kind: 'ctx', text })
        fileIdx += 1
      }
    }
  }
  // Unchanged tail of the commit-version file.
  while (hasFile && fileIdx < fileLines.length) pushFile()
  return rows
}

function countDiffStats(hunks) {
  const stats = { add: 0, del: 0 }
  for (const hunk of hunks || []) {
    for (const line of hunk.lines || []) {
      if (line.type === '+') stats.add += 1
      else if (line.type === '-') stats.del += 1
    }
  }
  return stats
}

/** Switch branch: refetch that branch's commits AND its HEAD version of the file. */
async function selectGitBranch(path, branch, refresh) {
  const view = gitViewFor(path)
  const seq = (view.seq += 1)
  view.branch = branch
  view.commit = null
  view.commitMeta = null
  view.fileLines = null
  view.hunks = []
  view.hint = ''
  view.stats = { add: 0, del: 0 }
  view.loading = true
  refresh()
  try {
    const [meta, file] = await Promise.all([
      fetchJson('/api/git/meta', { path, branch }),
      fetchJson('/api/git/file', { path, commit: branch }).catch(() => null),
    ])
    if (view.seq !== seq) return // a newer selection already won
    view.branches = Array.isArray(meta.branches) && meta.branches.length ? meta.branches : view.branches
    view.currentBranch = meta.currentBranch || view.currentBranch
    view.commits = Array.isArray(meta.commits) ? meta.commits : []
    if (file && file.content != null) {
      // The first commit option must show THIS branch's content, not the working tree.
      view.branchContent = String(file.content)
    } else {
      view.branchContent = null
      view.hint = `⚠ 分支 ${branch} 不存在此文件`
    }
  } catch (error) {
    if (view.seq !== seq) return
    view.branchContent = null
    view.hint = `切换分支失败: ${(error && error.message) || error}`
  }
  view.loading = false
  refresh()
}

/** Select a real commit (diff view) or become back to "◎ <branch> 最新" (commit = ''). */
async function selectGitCommit(path, commit, refresh) {
  const view = gitViewFor(path)
  if (!commit) {
    view.seq += 1
    view.commit = null
    view.commitMeta = null
    view.fileLines = null
    view.hunks = []
    view.hint = ''
    view.loading = false
    view.stats = { add: 0, del: 0 }
    refresh()
    return
  }
  const seq = (view.seq += 1)
  view.commit = commit
  view.commitMeta = view.commits.find((item) => item.hash === commit || item.short === commit) || null
  view.fileLines = null
  view.hunks = []
  view.hint = ''
  view.stats = { add: 0, del: 0 }
  view.loading = true
  refresh()
  try {
    // Hunk fragments alone are not enough for a full-file diff view: fetch the
    // commit-version file in parallel and mark the hunks inside it.
    const [diff, file] = await Promise.all([
      fetchJson('/api/git/diff', { path, commit }),
      fetchJson('/api/git/file', { path, commit }).catch(() => null),
    ])
    if (view.seq !== seq) return
    view.hunks = Array.isArray(diff.hunks) ? diff.hunks : []
    view.fileLines = file && file.content != null ? String(file.content).split('\n') : null
    if (view.hunks.length === 0) {
      view.hint = '⚠ 此提交未修改该文件'
    } else {
      view.stats = countDiffStats(view.hunks)
    }
  } catch (error) {
    if (view.seq !== seq) return
    view.hunks = []
    view.fileLines = null
    view.hint = `加载提交改动失败: ${(error && error.message) || error}`
  }
  view.loading = false
  refresh()
}

/**
 * Per-path git state for CodeView: loads meta once, exposes branch/commit
 * actions. The view object is module-cached (mutable) so a remount keeps the
 * user's selection; `bump` re-renders after async work / mutation.
 */
function useGitView(tab) {
  const path = tab.path
  const [, bump] = React.useReducer((count) => count + 1, 0)
  const view = gitViewFor(path)
  React.useEffect(() => {
    const seq = view.seq
    loadGitMeta(path).then((meta) => {
      if (view.seq !== seq) return // user already changed branch/commit
      if (!meta) {
        if (!view.ready) {
          view.ready = true
          view.git = false
        }
        bump()
        return
      }
      if (!view.ready) {
        view.ready = true
        view.git = true
        view.repo = meta.repo
        view.branch = meta.branch
        view.currentBranch = meta.currentBranch
        view.branches = meta.branches
        view.commits = meta.commits
      }
      bump()
    })
    // `path` and the module-cached view decide the load; bump is stable.
  }, [path, view, bump])
  const actions = React.useMemo(
    () => ({
      selectBranch(branch) {
        if (!view.git || !branch || branch === view.branch) return
        void selectGitBranch(path, branch, bump)
      },
      selectCommit(commit) {
        const value = String(commit || '')
        if (value === (view.commit || '')) return
        void selectGitCommit(path, value, bump)
      },
      clearCommit() {
        if (!view.commit) return
        void selectGitCommit(path, '', bump)
      },
    }),
    [path, view, bump],
  )
  return { view, actions }
}

/** Branch + commit dropdowns and the 清除 button, shown inside .mdr-code-head. */
function GitBar(props) {
  const { view, actions } = props
  const branchOptions = view.branches.map((branch) => h('option', { key: branch, value: branch }, branch))
  const commitOptions = [h('option', { key: '__latest', value: '' }, `◎ ${view.branch || '当前分支'} 最新`)]
  for (const commit of view.commits) {
    commitOptions.push(
      h(
        'option',
        { key: commit.hash, value: commit.hash },
        `${commit.short} ${commit.author} ${commit.date} ${String(commit.subject || '').slice(0, 30)}`,
      ),
    )
  }
  return h(
    'span',
    { className: 'mdr-git-bar' },
    h(
      'select',
      {
        className: 'mdr-git-sel',
        title: '选择分支',
        value: view.branch,
        onChange: (event) => actions.selectBranch(event.target.value),
      },
      branchOptions,
    ),
    h(
      'select',
      {
        className: 'mdr-git-sel',
        title: '选择提交，查看该提交对当前文件的改动',
        value: view.commit || '',
        onChange: (event) => actions.selectCommit(event.target.value),
      },
      commitOptions,
    ),
    h('button', { className: 'mdr-git-btn', title: '清除提交选择，回到最新版本', onClick: actions.clearCommit }, '清除'),
  )
}

/** Git-related styles; the body padding/overflow override makes the body the scroller. */
const GIT_CSS = `
.mdr-code .mdr-code-body{position:relative;overflow:auto;padding:0}
.mdr-code .mdr-git-bar{display:flex;align-items:center;gap:6px;flex:0 0 auto;max-width:100%}
.mdr-code .mdr-git-sel{max-width:190px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;cursor:pointer}
.mdr-code .mdr-git-sel:hover{border-color:var(--dsw-alias-brand-primary)}
.mdr-code .mdr-git-btn{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.mdr-code .mdr-git-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mdr-code .mdr-git-info{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:0 0 auto;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px}
.mdr-code .mdr-git-hash{font-family:Consolas,"Courier New",monospace;color:#d7ba7d}
.mdr-code .mdr-git-author{color:#89d185}
.mdr-code .mdr-git-date{color:var(--dsw-alias-label-secondary)}
.mdr-code .mdr-git-subject{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.mdr-code .mdr-git-stat{margin-left:auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mdr-code .mdr-git-note{color:#e2c08d}
.mdr-code .mdr-cl.mdr-git-add{background:rgba(46,160,67,.15)}
.mdr-code .mdr-cl.mdr-git-add .mdr-cl-no{background:rgba(46,160,67,.25);color:#3fb950}
.mdr-code .mdr-cl.mdr-git-del{background:rgba(248,81,73,.12)}
.mdr-code .mdr-cl.mdr-git-del .mdr-cl-no{background:rgba(248,81,73,.2);color:#f48771}
.mdr-code .mdr-cl.mdr-git-del .mdr-cl-code{text-decoration:line-through;opacity:.72}
.mdr-code .mdr-code-head{flex-wrap:wrap;row-gap:4px}
.mdr-code .mdr-code-body.mdr-git-vscroll{padding:0}
.mdr-code .mdr-git-vwrap{position:relative;min-width:100%}
.mdr-code .mdr-git-vscroll .mdr-cl{position:absolute;left:0;height:${GIT_LINE_H}px;line-height:${GIT_LINE_H}px;min-height:0}
.mdr-code .mdr-git-vscroll .mdr-cl-no{position:static}
.mdr-code .mdr-cl.hit{background:rgba(255,214,102,.16);box-shadow:inset 3px 0 0 #ffd33d}
`
