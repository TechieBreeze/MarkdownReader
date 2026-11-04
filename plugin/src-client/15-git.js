/**
 * Code-tab git viewer (owned by the git slice): branch/commit selection, the
 * commit-version diff view, and the per-file view state / metadata caches.
 *
 * Everything here is read-only: the host exposes only git log/show/for-each-ref
 * style endpoints, the working tree is never touched. State is cached at module
 * level so switching tabs (CodeView remounts) keeps the selected branch /
 * commit, while the App still owns the tab objects themselves.
 *
 * View keys: a code tab is keyed by its path; the code modal passes its own
 * `gitKey` ("modal:<path>") so the popup's branch/commit view never mutates the
 * branch the tab underneath is showing.
 */

/** Rows above this count are virtualized (only the viewport +/- buffer is painted). */
const GIT_V_THRESHOLD = 1500
/** Constant row height, kept in sync with .mdr-cl CSS (min-height/line-height 20px). */
const GIT_LINE_H = 20
/** Extra rows painted above and below the viewport in virtual mode. */
const GIT_BUFFER = 40

const gitMetaCache = new Map() // path -> Promise<meta|null>
const gitViewCache = new Map() // view key -> mutable view state

function gitViewKey(tab) {
  const source = tab || {}
  return String(source.gitKey || source.path || '')
}

function gitViewFor(key) {
  const name = String(key || '')
  let view = gitViewCache.get(name)
  if (!view) {
    view = {
      ready: false,
      readyPromise: null,
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
    gitViewCache.set(name, view)
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

/**
 * Load the git meta for a view once and seed the initial branch/commits. Shared
 * by the initial mount and by `applyGitTarget` so a git-adapted link cannot race
 * the initial load.
 */
async function ensureGitViewReady(key, path, refresh) {
  const view = gitViewFor(key)
  if (view.ready) return view
  if (!view.readyPromise) {
    view.readyPromise = loadGitMeta(path).then((meta) => {
      if (!view.ready) {
        view.ready = true
        if (!meta) {
          view.git = false
        } else {
          view.git = true
          view.repo = meta.repo
          view.branch = meta.branch
          view.currentBranch = meta.currentBranch
          view.branches = meta.branches
          view.commits = meta.commits
        }
      }
      refresh()
      return view
    })
  }
  return view.readyPromise
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

/**
 * Switch branch: refetch that branch's commits AND its HEAD version of the file.
 * The meta endpoint resolves the requested branch against the real ref list, so
 * the applied view is what the dropdowns then show (`effective`), not a typo.
 */
async function selectGitBranch(key, path, branch, refresh) {
  const view = gitViewFor(key)
  const seq = (view.seq += 1)
  view.branch = String(branch || '')
  view.commit = null
  view.commitMeta = null
  view.fileLines = null
  view.hunks = []
  view.hint = ''
  view.stats = { add: 0, del: 0 }
  view.loading = true
  refresh()
  try {
    const meta = await fetchJson('/api/git/meta', { path, branch })
    if (view.seq !== seq) return // a newer selection already won
    const effective = meta.branch || branch
    view.branches = Array.isArray(meta.branches) && meta.branches.length ? meta.branches : view.branches
    view.currentBranch = meta.currentBranch || view.currentBranch
    view.commits = Array.isArray(meta.commits) ? meta.commits : []
    view.branch = effective
    // "git show <branch>:<file>" is the branch HEAD file — the first commit
    // option must render THIS branch's content, not the working tree.
    const file = await fetchJson('/api/git/file', { path, commit: effective }).catch(() => null)
    if (view.seq !== seq) return
    if (file && file.content != null) {
      view.branchContent = String(file.content)
    } else {
      view.branchContent = null
      view.hint = `⚠ 分支 ${effective} 不存在此文件`
    }
  } catch (error) {
    if (view.seq !== seq) return
    view.branchContent = null
    view.hint = `切换分支失败: ${(error && error.message) || error}`
  }
  view.loading = false
  refresh()
}

/** Select a real commit (diff view) or go back to "◎ <branch> 最新" (commit = ''). */
async function selectGitCommit(key, path, commit, refresh) {
  const view = gitViewFor(key)
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
    view.commitMeta = view.commitMeta || (diff && diff.meta) || (file && file.meta) || null
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
 * Apply a git-adapted link (`tab.branch` / `tab.commit`, modal request
 * `{path,line,branch,commit}`): a commit view wins, otherwise the requested
 * branch's HEAD file is loaded. Switching branch refetches that branch's commit
 * list AND file, so the dropdowns always reflect the applied view.
 */
async function applyGitTarget(tab, branch, commit, refresh) {
  if (!tab || (!branch && !commit)) return
  const key = gitViewKey(tab)
  const path = tab.path
  const view = await ensureGitViewReady(key, path, refresh)
  if (!view.git) return
  if (commit) {
    if (branch && branch !== view.branch) await selectGitBranch(key, path, branch, refresh)
    if (view.commit !== commit) await selectGitCommit(key, path, commit, refresh)
  } else if (branch && branch !== view.branch) {
    await selectGitBranch(key, path, branch, refresh)
  }
}

/**
 * Per-path git state for CodeView / the code modal: loads meta once, exposes
 * branch/commit actions. The view object is module-cached (mutable) so a remount
 * keeps the user's selection; `bump` re-renders after async work / mutation.
 */
function useGitView(tab) {
  const path = tab.path
  const key = gitViewKey(tab)
  const [, bump] = React.useReducer((count) => count + 1, 0)
  const view = gitViewFor(key)
  React.useEffect(() => {
    void ensureGitViewReady(key, path, bump)
  }, [key, path])
  const actions = React.useMemo(
    () => ({
      refresh() {
        bump()
      },
      applyTarget(branch, commit) {
        void applyGitTarget(tab, branch, commit, bump)
      },
      selectBranch(branch) {
        if (!view.git || !branch || branch === view.branch) return
        void selectGitBranch(key, path, branch, bump)
      },
      selectCommit(commit) {
        const value = String(commit || '')
        if (value === (view.commit || '')) return
        void selectGitCommit(key, path, value, bump)
      },
      clearCommit() {
        if (!view.commit) return
        void selectGitCommit(key, path, '', bump)
      },
    }),
    // `tab` is recreated on every App render; the cached `view` and `key` decide.
    [key, path, view],
  )
  return { view, actions }
}

/** Branch + commit dropdowns and the 清除 button, shown inside .mdr-code-head. */
function GitBar(props) {
  const { view, actions } = props
  const branchOptions = view.branches.map((branch) => h('option', { key: branch, value: branch }, branch))
  const commitOptions = [h('option', { key: '__latest', value: '' }, `◎ ${view.branch || '当前分支'} 最新`)]
  let commitListed = false
  for (const commit of view.commits) {
    if (view.commit && commit.hash === view.commit) commitListed = true
    commitOptions.push(
      h(
        'option',
        { key: commit.hash, value: commit.hash },
        `${commit.short} ${commit.author} ${commit.date} ${String(commit.subject || '').slice(0, 30)}`,
      ),
    )
  }
  // A jump-adapted link may name a commit outside this branch's recent log: add
  // it so the select reflects the view that is actually rendered.
  if (view.commit && !commitListed) {
    commitOptions.push(
      h(
        'option',
        { key: '__jump', value: view.commit },
        `${view.commitMeta ? view.commitMeta.short : String(view.commit).slice(0, 7)} (跳转提交)`,
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
.mdr-code .mdr-code-back{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.mdr-code .mdr-code-back:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
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
.mdr-code .mdr-cl.mdr-git-ctx{background:rgba(139,148,158,.06)}
.mdr-code .mdr-cl.mdr-git-ctx .mdr-cl-no{color:#6e7681}
.mdr-code .mdr-code-head{flex-wrap:wrap;row-gap:4px}
.mdr-code .mdr-code-body.mdr-git-vscroll{padding:0}
.mdr-code .mdr-git-vwrap{position:relative;min-width:100%}
.mdr-code .mdr-git-vscroll .mdr-cl{position:absolute;left:0;height:${GIT_LINE_H}px;line-height:${GIT_LINE_H}px;min-height:0}
.mdr-code .mdr-git-vscroll .mdr-cl-no{position:static}
/* ==== VSCode Dark+ palette (kept from input/reference/index.html; the code view
   owns these rules so tabs and the modal always agree) ==== */
.mdr-code .hljs-keyword,.mdr-code .hljs-doctag,.mdr-code .hljs-template-tag,.mdr-code .hljs-tag,.mdr-code .hljs-name,.mdr-code .hljs-attr,.mdr-code .hljs-selector-tag,.mdr-code .hljs-meta,.mdr-code .hljs-section,.mdr-code .hljs-link,.mdr-code .hljs-variable.language_{color:#569cd6}
.mdr-code .hljs-string,.mdr-code .hljs-meta .hljs-string,.mdr-code .hljs-code,.mdr-code .hljs-formula{color:#ce9178}
.mdr-code .hljs-comment,.mdr-code .hljs-quote{color:#6a9955}
.mdr-code .hljs-number,.mdr-code .hljs-literal,.mdr-code .hljs-symbol,.mdr-code .hljs-bullet{color:#b5cea8}
.mdr-code .hljs-type,.mdr-code .hljs-title,.mdr-code .hljs-title.class_,.mdr-code .hljs-title.class_.inherited__,.mdr-code .hljs-built_in{color:#4ec9b0}
.mdr-code .hljs-title.function_,.mdr-code .hljs-title.function_.invoke__{color:#dcdcaa}
.mdr-code .hljs-variable,.mdr-code .hljs-property,.mdr-code .hljs-attribute,.mdr-code .hljs-params,.mdr-code .hljs-template-variable{color:#9cdcfe}
.mdr-code .hljs-selector-id,.mdr-code .hljs-selector-class,.mdr-code .hljs-selector-attr,.mdr-code .hljs-selector-pseudo{color:#d7ba7d}
.mdr-code .hljs-regexp{color:#d16969}
.mdr-code .hljs-operator,.mdr-code .hljs-punctuation,.mdr-code .hljs-subst{color:#d4d4d4}
.mdr-code .hljs-addition{color:#b5cea8;background-color:rgba(46,160,67,.15)}
.mdr-code .hljs-deletion{color:#f48771;background-color:rgba(248,81,73,.15)}
/* Java/Kotlin 补色：全大写常量/枚举值（枚举值也要有颜色且可点） */
.mdr-code .hljs-constant{color:#b5cea8}
/* 参数列表整段带 hljs-params：用复合选择器把补出来的类型/变量/关键字还原成各自颜色 */
.mdr-code .hljs-params.hljs-type{color:#4ec9b0}
.mdr-code .hljs-params.hljs-variable{color:#9cdcfe}
.mdr-code .hljs-params.hljs-keyword{color:#569cd6}
.mdr-code .hljs-params.hljs-constant{color:#b5cea8}
/* 跳转行持久高亮（黄色，直到下一次跳转 / 关闭；没有任何定时器移除） */
.mdr-code .mdr-cl.hit{background:rgba(255,214,102,.16);box-shadow:inset 3px 0 0 #ffd33d}
.mdr-code .mdr-cl.hit .mdr-cl-no{background:rgba(255,214,102,.22);color:#ffd33d}
.mdr-code .mdr-cl.mdr-git-add.hit,.mdr-code .mdr-cl.mdr-git-del.hit,.mdr-code .mdr-cl.mdr-git-ctx.hit{box-shadow:inset 3px 0 0 #ffd33d}
/* Ctrl+点击可跳转 token 的 hover 提示：仅 Java/Kotlin 视图挂 .jump-hover 时生效
   （与原版一致：下划线 + 轻微变亮 + pointer）。覆盖所有会产生跳转的 token class：
   function_（方法）/ hljs-type、class_（类型；泛型头与泛型实参也是 hljs-type）/
   hljs-variable（变量、字段、参数名）/ hljs-constant（枚举值、大写常量）+
   hljs-params 里的复合 class（参数列表整段是 hljs-params，签名里的类型/变量/常量
   都带这个前缀，复合选择器优先级更高才能拿到类型色/下划线）。删除行不给提示——
   它的行号是旧文件的行号，和当前渲染的新版本文本错位，跳过去必然错。 */
.mdr-code .mdr-code-body.jump-hover span.hljs-title.function_:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-variable:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-type:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-title.class_:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-constant:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-params.hljs-type:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-params.hljs-variable:hover,
.mdr-code .mdr-code-body.jump-hover span.hljs-params.hljs-constant:hover{text-decoration:underline;text-decoration-color:rgba(220,220,170,.6);cursor:pointer;filter:brightness(1.2)}
.mdr-code .mdr-code-body.jump-hover .mdr-cl.mdr-git-del span:hover{text-decoration:none;cursor:default;filter:none}
`
