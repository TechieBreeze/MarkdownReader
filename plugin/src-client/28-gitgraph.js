/**
 * Git 版本树 modal — owned by the panels slice.
 *
 * Contract (wired by 50-app.js): h(GitGraphModal, { path, onClose, onOpen })
 *   path: active tab path (or '') used to resolve the repository containing it
 *   onOpen: reserved for future file jumps; currently unused-safe
 * Host: GET /markdown-reader/api/git/repos, GET /markdown-reader/api/git/graph?path=&limit=
 *
 * 为什么手绘：独立版当初把 gitgraph.js 换掉了 —— 它渲染到 canvas，文字不可选中、
 * 暗色配色脏、devicePixelRatio≠1 时点击坐标偏移。这里沿用它最终的做法：
 * Host 只返回拓扑（每个提交的 parents / refs），Client 用 SVG 自己画轨道：
 *   · 行 = 时间（新的在上），列 = 轨道（lane），与 gitk / VS Code 的读法一致
 *   · 每条「子 → 父」边一条 path：同轨道直线，跨轨道用三次贝塞尔平滑换列
 *   · 分支头 / 当前分支画成彩色胶囊
 * 轨道分配是纯函数 gitGraphLayout(commits)，可以脱离 DOM 单独测试。
 */

/** 每行提交的高度（必须与 GitGraph CSS 里的 .mdr-gitgraph-row 一致）。 */
const GITGRAPH_ROW_H = 30
/** 一次最多取多少条提交（Host 契约上限 400，UI 取 200 已足够阅读）。 */
const GITGRAPH_LIMIT = 200
/** 轨道配色：按「轨道号」而不是分支名分配，临时分支再多也只有几条线。 */
const GITGRAPH_LANE_COLORS = ['#7d8590', '#4a9eff', '#3fb950', '#d29922', '#a371f7', '#f85149', '#39c5cf', '#db61a2']

function gitGraphLaneColor(lane) {
  const index = Number(lane) || 0
  return GITGRAPH_LANE_COLORS[((index % GITGRAPH_LANE_COLORS.length) + GITGRAPH_LANE_COLORS.length) % GITGRAPH_LANE_COLORS.length]
}

/** 与 15-git.js 的 hash 同色，避免两处 git 视图对同一个概念用两种颜色。 */
const GITGRAPH_HASH_COLOR = '#d7ba7d'

const GITGRAPH_CSS = `
.mdr-gitgraph-panel{width:min(1200px,94vw);height:min(84vh,820px);max-height:84vh}
.mdr-gitgraph-head{flex-wrap:wrap;row-gap:6px}
.mdr-gitgraph-title{flex:0 0 auto}
.mdr-gitgraph-repo{min-width:150px;max-width:320px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.mdr-gitgraph-repo:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.mdr-gitgraph-repo:disabled{opacity:.55;cursor:default}
.mdr-gitgraph-stats{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.mdr-gitgraph-panel .mdr-btn:disabled{opacity:.45;cursor:default}
.mdr-gitgraph-body{display:flex;flex-direction:column;flex:1;min-height:0;padding:0}
.mdr-gitgraph-toolbar{display:flex;flex-direction:column;gap:6px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.mdr-gitgraph-repo-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px}
.mdr-gitgraph-repo-name{flex:0 0 auto;font-weight:600}
.mdr-gitgraph-repo-path{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mdr-gitgraph-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mdr-gitgraph-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;cursor:pointer;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.mdr-gitgraph-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mdr-gitgraph-chip.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.mdr-gitgraph-chip-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.mdr-gitgraph-scroll{position:relative;flex:1;min-height:0;overflow:auto;padding:4px 0 14px;background:var(--dsw-alias-bg-base)}
.mdr-gitgraph-canvas{position:relative;min-width:100%}
.mdr-gitgraph-svg{position:absolute;left:0;top:0;z-index:1;pointer-events:none;overflow:visible}
.mdr-gitgraph-rows{position:relative;z-index:2}
.mdr-gitgraph-row{display:flex;align-items:stretch;height:${GITGRAPH_ROW_H}px;line-height:${GITGRAPH_ROW_H}px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;border-bottom:1px solid rgba(127,127,127,.09)}
.mdr-gitgraph-row:last-child{border-bottom:none}
.mdr-gitgraph-gutter{flex:0 0 auto;pointer-events:none}
.mdr-gitgraph-text{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0 12px 0 4px;border-radius:5px}
.mdr-gitgraph-row:hover .mdr-gitgraph-text{background:var(--dsw-alias-bg-layer-2)}
.mdr-gitgraph-row.selected .mdr-gitgraph-text{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mdr-gitgraph-row.dim{opacity:.34}
.mdr-gitgraph-row.on .mdr-gitgraph-text{background:rgba(78,155,214,.12)}
.mdr-gitgraph-ref{display:inline-flex;align-items:center;flex:0 0 auto;padding:0 6px;border:1px solid;border-radius:999px;font-size:10.5px;line-height:16px;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-gitgraph-ref.head{font-weight:700}
.mdr-gitgraph-hash{flex:0 0 auto;font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:11.5px;color:${GITGRAPH_HASH_COLOR}}
.mdr-gitgraph-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-gitgraph-author{flex:0 0 112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mdr-gitgraph-date{flex:0 0 86px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mdr-gitgraph-dot{stroke:var(--dsw-alias-bg-base);stroke-width:1.5}
.mdr-gitgraph-dot.head{stroke:var(--dsw-alias-label-primary);stroke-width:2.2}
.mdr-gitgraph-dot.selected{stroke:var(--dsw-alias-brand-primary);stroke-width:2.6}
.mdr-gitgraph-dot.dim{opacity:.25}
.mdr-gitgraph-edge{fill:none;stroke-width:1.6;stroke-linecap:round;opacity:.5}
.mdr-gitgraph-edge.merge{stroke-width:2;opacity:.72}
.mdr-gitgraph-edge.dim{opacity:.16}
.mdr-gitgraph-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 16px;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center}
.mdr-gitgraph-state-err{color:var(--dsw-alias-state-error-primary)}
.mdr-gitgraph-state-hint{max-width:520px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.mdr-gitgraph-detail{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-height:190px;overflow:auto}
.mdr-gitgraph-detail-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;font-size:12px}
.mdr-gitgraph-detail-row{display:flex;align-items:baseline;gap:8px}
.mdr-gitgraph-detail-k{flex:0 0 48px;color:var(--dsw-alias-label-secondary)}
.mdr-gitgraph-detail-v{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-primary)}
.mdr-gitgraph-detail-hash{font-family:"Cascadia Code",Consolas,"Courier New",monospace;color:${GITGRAPH_HASH_COLOR}}
.mdr-gitgraph-parent{padding:0 6px;margin-right:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:#4a9eff;font:inherit;font-size:11.5px;line-height:17px;cursor:pointer}
.mdr-gitgraph-parent:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mdr-gitgraph-parent:disabled{opacity:.45;cursor:default;color:var(--dsw-alias-label-secondary)}
.mdr-gitgraph-detail-subject{margin-top:3px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;line-height:1.55}
.mdr-gitgraph-detail-actions{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.mdr-gitgraph-copied{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mdr-gitgraph-copied.err{color:var(--dsw-alias-state-error-primary)}
.mdr-gitgraph-foot{flex:0 0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:5px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mdr-gitgraph-legend{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.mdr-gitgraph-foot-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.mdr-gitgraph-foot-dia{width:8px;height:8px;flex:0 0 auto;background:var(--dsw-alias-label-secondary);transform:rotate(45deg)}
`

/** Small helper for error messages coming out of async code. */
function gitGraphErrorText(error) {
  if (!error) return ''
  const message = error && error.message != null ? error.message : error
  const text = String(message == null ? '' : message).trim()
  return text || '未知错误'
}

/** "2026-11-04 14:21" -> "11-04 14:21" (fallbacks to the raw value). */
function gitGraphShortDate(value) {
  const text = String(value == null ? '' : value)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text.slice(5)
  return text || '—'
}

/**
 * Assign a lane (column) to every commit, in list order (newest first).
 *
 * A "lane" is a slot that remembers which commit it is currently heading to.
 * Walking the list top-down:
 *   1. the commit takes the lane already waiting for it (else the first free lane);
 *   2. all other lanes waiting for the same commit converge into its dot;
 *   3. the first parent inherits the lane, extra parents (merge) get their own lane.
 * Lanes waiting for a parent outside the loaded window are released immediately:
 * no line can be drawn to a commit that was never returned by the Host.
 *
 * Pure function, no DOM/React access — unit-tested with fixtures.
 */
function gitGraphLayout(commits) {
  const list = Array.isArray(commits) ? commits.filter((commit) => commit && typeof commit.hash === 'string') : []
  const byHash = new Map()
  for (const commit of list) if (!byHash.has(commit.hash)) byHash.set(commit.hash, commit)
  const lanes = []
  const rows = []
  const edges = []
  const rowOf = new Map()
  const laneOf = new Map()
  let laneCount = 0

  const takeLane = () => {
    const free = lanes.indexOf(null)
    if (free >= 0) return free
    lanes.push(null)
    return lanes.length - 1
  }

  for (let row = 0; row < list.length; row += 1) {
    const commit = list[row]
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) lane = takeLane()
    // Every lane that was waiting for this commit ends here (converging lines).
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] === commit.hash) lanes[index] = null
    }
    rowOf.set(commit.hash, row)
    laneOf.set(commit.hash, lane)
    rows.push({ hash: commit.hash, lane, row })
    if (lane >= laneCount) laneCount = lane + 1

    const parents = Array.isArray(commit.parents) ? commit.parents.filter((parent) => typeof parent === 'string' && parent) : []
    if (!parents.length) continue
    // First parent keeps this lane; missing parent releases it (nothing to draw).
    lanes[lane] = byHash.has(parents[0]) ? parents[0] : null
    for (let index = 1; index < parents.length; index += 1) {
      const parent = parents[index]
      if (!byHash.has(parent)) continue
      if (lanes.indexOf(parent) >= 0) continue // already tracked: the lines converge later
      const slot = takeLane()
      lanes[slot] = parent
    }
  }

  // Edges need all lanes resolved first: record one per existing child→parent pair.
  for (const rowInfo of rows) {
    const commit = byHash.get(rowInfo.hash)
    const parents = Array.isArray(commit.parents) ? commit.parents.filter((parent) => typeof parent === 'string' && parent) : []
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index]
      const parentRow = rowOf.get(parent)
      if (parentRow == null || parentRow <= rowInfo.row) continue // parent outside the loaded window
      edges.push({
        hash: commit.hash,
        parent,
        lane: rowInfo.lane,
        parentLane: laneOf.get(parent),
        row: rowInfo.row,
        parentRow,
        merge: index > 0,
      })
    }
  }

  return { rows, byHash, rowOf, laneOf, laneCount: Math.max(1, laneCount), edges }
}

/** Every commit reachable from `headHash` (its ancestors), bounded to the loaded list. */
function gitGraphReachable(commits, headHash) {
  const list = Array.isArray(commits) ? commits : []
  const byHash = new Map()
  for (const commit of list) if (commit && typeof commit.hash === 'string' && !byHash.has(commit.hash)) byHash.set(commit.hash, commit)
  const seen = new Set()
  if (!headHash || !byHash.has(headHash)) return seen
  const stack = [headHash]
  while (stack.length) {
    const hash = stack.pop()
    if (seen.has(hash)) continue
    const commit = byHash.get(hash)
    if (!commit) continue
    seen.add(hash)
    const parents = Array.isArray(commit.parents) ? commit.parents : []
    for (const parent of parents) if (typeof parent === 'string' && byHash.has(parent)) stack.push(parent)
  }
  return seen
}

/**
 * Branch refs come from `for-each-ref --format=%(objectname:short)` (7-char
 * abbrev), while commits carry full hashes. Map the abbrev back to a loaded
 * full hash so branch chips / HEAD detection line up with the commit rows.
 */
function gitGraphResolveHead(commits, hash) {
  const value = String(hash == null ? '' : hash)
  if (!value) return ''
  const list = Array.isArray(commits) ? commits : []
  for (const commit of list) if (commit && commit.hash === value) return value
  for (const commit of list) {
    if (!commit || typeof commit.hash !== 'string') continue
    if (commit.short === value || commit.hash.startsWith(value)) return commit.hash
  }
  return ''
}

/**
 * Resolve the initial graph query from the repo inventory + the active tab path.
 * Returns { query, repoPath }: query is what to pass to /api/git/graph, repoPath
 * is the repo-picker value ('' = let the Host resolve it from the file path).
 */
function gitGraphResolveRepo(repos, activePath) {
  const list = Array.isArray(repos) ? repos.filter((repo) => repo && (repo.path || repo.repo)) : []
  const candidate = String(activePath || '').trim()
  if (candidate) {
    // Longest matching repo root wins: inventories can list nested repos and a
    // file must resolve to the innermost one.
    let best = ''
    for (const repo of list) {
      const root = repo.path || repo.repo
      if ((candidate === root || candidate.startsWith(`${root}/`)) && root.length > best.length) best = root
    }
    if (best) return { query: best, repoPath: best }
    // Path outside the inventory (or repos failed to load): the Host can still
    // walk up to the containing git root, so query it directly.
    return { query: candidate, repoPath: '' }
  }
  if (list.length) {
    const first = list[0].path || list[0].repo
    return { query: first, repoPath: first }
  }
  return { query: '', repoPath: '' }
}

/** Copy helper with the execCommand fallback (navigator.clipboard needs a secure context). */
function gitGraphFallbackCopy(text) {
  try {
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function' || !document.body) return false
    const area = document.createElement('textarea')
    area.value = String(text == null ? '' : text)
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, area.value.length)
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(area)
    return !!copied
  } catch {
    return false
  }
}

function gitGraphCopyText(text) {
  const value = String(text == null ? '' : text)
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return Promise.resolve(navigator.clipboard.writeText(value))
        .then(() => true)
        .catch(() => gitGraphFallbackCopy(value))
    }
  } catch {
    // fall through to the DOM fallback
  }
  return Promise.resolve(gitGraphFallbackCopy(value))
}

function GitGraphModal(props) {
  const { path } = props || {}
  const [repos, setRepos] = React.useState(null)
  const [reposStatus, setReposStatus] = React.useState('loading') // loading | ready | error
  const [reposError, setReposError] = React.useState('')
  const [repoPath, setRepoPath] = React.useState('')
  const [graph, setGraph] = React.useState(null)
  const [graphStatus, setGraphStatus] = React.useState('idle') // idle | loading | ready | error | empty
  const [error, setError] = React.useState('')
  const [selectedHash, setSelectedHash] = React.useState('')
  const [filterBranch, setFilterBranch] = React.useState('')
  const [copyState, setCopyState] = React.useState('') // '' | done | fail
  const [bootNonce, setBootNonce] = React.useState(0)
  const loadSeq = React.useRef(0)
  const copyTimerRef = React.useRef(null)
  const scrollRef = React.useRef(null)

  const close = () => {
    if (typeof props.onClose === 'function') props.onClose()
  }

  const loadGraph = React.useCallback((queryPath) => {
    const seq = (loadSeq.current += 1)
    setGraphStatus('loading')
    setError('')
    setSelectedHash('')
    fetchJson('/api/git/graph', { path: queryPath, limit: GITGRAPH_LIMIT })
      .then((payload) => {
        if (seq !== loadSeq.current) return
        const branches = Array.isArray(payload.branches) ? payload.branches : []
        const commits = Array.isArray(payload.commits) ? payload.commits : []
        setGraph({
          repo: String(payload.repo || ''),
          name: String(payload.name || ''),
          current: String(payload.current || ''),
          branches,
          commits,
        })
        setGraphStatus('ready')
        setFilterBranch('')
        const repoRel = String(payload.repo || '')
        if (repoRel) {
          setRepoPath(repoRel)
          setRepos((previous) => {
            const list = Array.isArray(previous) ? previous : []
            if (list.some((repo) => (repo.path || repo.repo) === repoRel)) return list
            return [...list, { repo: repoRel, name: String(payload.name || repoRel.split('/').pop() || repoRel), path: repoRel }]
          })
        }
      })
      .catch((err) => {
        if (seq !== loadSeq.current) return
        setGraphStatus('error')
        setError(`版本树加载失败：${gitGraphErrorText(err)}`)
      })
  }, [])

  // Boot: inventory first (for the repo picker), then the graph for the active
  // tab's repo (or the first repo when no tab path is available).
  React.useEffect(() => {
    let alive = true
    loadSeq.current += 1
    setReposStatus('loading')
    setReposError('')
    setGraphStatus('idle')
    setGraph(null)
    setSelectedHash('')
    setFilterBranch('')
    fetchJson('/api/git/repos')
      .then((payload) => {
        if (!alive) return
        const list = Array.isArray(payload.repos) ? payload.repos.filter((repo) => repo && (repo.path || repo.repo)) : []
        setRepos(list)
        setReposStatus('ready')
        const initial = gitGraphResolveRepo(list, path)
        if (!initial.query) {
          setGraphStatus('empty')
          return
        }
        setRepoPath(initial.repoPath)
        loadGraph(initial.query)
      })
      .catch((err) => {
        if (!alive) return
        const message = gitGraphErrorText(err)
        setReposStatus('error')
        setReposError(`仓库列表加载失败：${message}`)
        const initial = gitGraphResolveRepo([], path)
        if (initial.query) {
          setRepoPath('')
          loadGraph(initial.query)
        } else {
          setGraphStatus('error')
          setError(`仓库列表加载失败：${message}`)
        }
      })
    return () => {
      alive = false
      loadSeq.current += 1
    }
  }, [path, loadGraph, bootNonce])

  React.useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    [],
  )

  // Keep the selected commit visible (parent jumps / first click in a long list).
  React.useEffect(() => {
    if (!selectedHash) return undefined
    const scroller = scrollRef.current
    if (!scroller || typeof scroller.querySelector !== 'function') return undefined
    const node = scroller.querySelector(`.mdr-gitgraph-row[data-hash="${selectedHash}"]`)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    return undefined
  }, [selectedHash])

  const commits = graph && Array.isArray(graph.commits) ? graph.commits : []
  const branches = graph && Array.isArray(graph.branches) ? graph.branches : []
  const layout = React.useMemo(() => gitGraphLayout(commits), [commits])
  const highlight = React.useMemo(() => {
    if (!filterBranch || !graph) return null
    const branch = branches.find((item) => item && item.name === filterBranch)
    const head = branch ? gitGraphResolveHead(commits, branch.hash) : ''
    if (!head || !layout.rowOf.has(head)) return null
    return gitGraphReachable(commits, head)
  }, [filterBranch, graph, branches, commits, layout])
  const filterActive = !!(highlight && highlight.size)

  const selectCommit = (hash) => {
    setSelectedHash(String(hash || ''))
    setCopyState('')
  }

  const copyHash = (hash) => {
    gitGraphCopyText(hash)
      .then((ok) => {
        setCopyState(ok ? 'done' : 'fail')
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          copyTimerRef.current = null
          setCopyState('')
        }, 1800)
      })
      .catch(() => {
        setCopyState('fail')
      })
  }

  // ---- geometry: lane columns in a left gutter, one HTML row per commit ----
  const laneCount = layout.laneCount
  const laneWidth = laneCount <= 6 ? 20 : laneCount <= 12 ? 16 : 12
  const gutter = 28 + (laneCount - 1) * laneWidth
  const graphHeight = Math.max(GITGRAPH_ROW_H, layout.rows.length * GITGRAPH_ROW_H)
  const xOf = (lane) => 14 + (Number(lane) || 0) * laneWidth
  const yOf = (row) => (Number(row) || 0) * GITGRAPH_ROW_H + GITGRAPH_ROW_H / 2

  const svgChildren = []
  for (const edge of layout.edges) {
    const color = gitGraphLaneColor(edge.lane)
    const x1 = xOf(edge.lane)
    const y1 = yOf(edge.row)
    const x2 = xOf(edge.parentLane)
    const y2 = yOf(edge.parentRow)
    const dimmed = filterActive && !highlight.has(edge.hash)
    const className = 'mdr-gitgraph-edge' + (edge.merge ? ' merge' : '') + (dimmed ? ' dim' : '')
    const key = `edge-${edge.hash}-${edge.parent}`
    if (x1 === x2) {
      svgChildren.push(h('path', { key, className, d: `M${x1} ${y1}L${x2} ${y2}`, stroke: color }))
    } else {
      const middle = (y1 + y2) / 2
      svgChildren.push(
        h('path', { key, className, d: `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`, stroke: color }),
      )
    }
  }
  for (const rowInfo of layout.rows) {
    const commit = layout.byHash.get(rowInfo.hash)
    if (!commit) continue
    const color = gitGraphLaneColor(rowInfo.lane)
    const parents = Array.isArray(commit.parents) ? commit.parents : []
    const refs = Array.isArray(commit.refs) ? commit.refs : []
    const isMerge = parents.length > 1
    const isHead = !!graph && graph.current !== '' && refs.includes(graph.current)
    const isSelected = rowInfo.hash === selectedHash
    const dimmed = filterActive && !highlight.has(rowInfo.hash)
    const className =
      'mdr-gitgraph-dot' + (isHead ? ' head' : '') + (isSelected ? ' selected' : '') + (dimmed ? ' dim' : '')
    const cx = xOf(rowInfo.lane)
    const cy = yOf(rowInfo.row)
    const key = `dot-${rowInfo.hash}`
    if (isMerge) {
      svgChildren.push(
        h('rect', {
          key,
          className,
          x: cx - 4.5,
          y: cy - 4.5,
          width: 9,
          height: 9,
          transform: `rotate(45 ${cx} ${cy})`,
          fill: color,
        }),
      )
    } else {
      svgChildren.push(h('circle', { key, className, cx, cy, r: isHead ? 5.5 : 4, fill: color }))
    }
  }

  const rowNodes = layout.rows.map((rowInfo) => {
    const commit = layout.byHash.get(rowInfo.hash)
    if (!commit) return null
    const refs = Array.isArray(commit.refs) ? commit.refs : []
    const laneColor = gitGraphLaneColor(rowInfo.lane)
    const highlighted = filterActive && highlight.has(rowInfo.hash)
    const dimmed = filterActive && !highlight.has(rowInfo.hash)
    const rowClass =
      'mdr-gitgraph-row' + (rowInfo.hash === selectedHash ? ' selected' : '') + (highlighted ? ' on' : '') + (dimmed ? ' dim' : '')
    const refNodes = refs.slice(0, 3).map((ref, index) => {
      const isCurrent = !!graph && ref === graph.current
      const color = isCurrent ? '#3fb950' : laneColor
      return h(
        'span',
        {
          key: `ref-${ref}-${index}`,
          className: 'mdr-gitgraph-ref' + (isCurrent ? ' head' : ''),
          style: { color, borderColor: `${color}66`, background: `${color}1a` },
          title: isCurrent ? `${ref}（当前分支 / HEAD）` : `分支 ${ref}`,
        },
        ref,
      )
    })
    if (refs.length > 3) {
      refNodes.push(
        h(
          'span',
          {
            key: 'ref-more',
            className: 'mdr-gitgraph-ref',
            style: { color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l1)', background: 'transparent' },
            title: refs.join('、'),
          },
          `+${refs.length - 3}`,
        ),
      )
    }
    return h(
      'div',
      {
        key: `${rowInfo.hash}-${rowInfo.row}`,
        className: rowClass,
        'data-hash': rowInfo.hash,
        title: `${commit.short || rowInfo.hash}  ${String(commit.subject || '')}\n${commit.author || ''} · ${commit.date || ''}`,
        onClick: (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          selectCommit(rowInfo.hash)
        },
      },
      h('span', { className: 'mdr-gitgraph-gutter', style: { width: gutter } }),
      h(
        'div',
        { className: 'mdr-gitgraph-text' },
        refNodes,
        h('span', { className: 'mdr-gitgraph-hash', title: String(commit.hash || '') }, commit.short || String(commit.hash || '').slice(0, 7)),
        h('span', { className: 'mdr-gitgraph-subject', title: String(commit.subject || '') }, commit.subject || '(无提交说明)'),
        h('span', { className: 'mdr-gitgraph-author', title: `作者 ${commit.author || '—'}` }, commit.author || '—'),
        h('span', { className: 'mdr-gitgraph-date', title: String(commit.date || '') }, gitGraphShortDate(commit.date)),
      ),
    )
  })

  const onCanvasClick = (event) => {
    const element = event && event.currentTarget
    if (!element || typeof element.getBoundingClientRect !== 'function') return
    const rect = element.getBoundingClientRect()
    const row = Math.floor((Number(event.clientY) - rect.top) / GITGRAPH_ROW_H)
    const rowInfo = layout.rows[row]
    if (rowInfo) selectCommit(rowInfo.hash)
  }

  const selectRepo = (value) => {
    const next = String(value || '')
    if (!next || next === repoPath) return
    setRepoPath(next)
    setFilterBranch('')
    setSelectedHash('')
    loadGraph(next)
  }

  const refresh = () => {
    if (repoPath) loadGraph(repoPath)
    else if (path) loadGraph(path)
    else setBootNonce((value) => value + 1)
  }

  const selectedCommit = selectedHash && layout.byHash.has(selectedHash) ? layout.byHash.get(selectedHash) : null

  // ---- repo picker ----
  const repoSources = Array.isArray(repos) ? repos : []
  const repoOptionNodes = []
  if (!repoSources.length) {
    repoOptionNodes.push(
      h('option', { key: '__none', value: '' }, reposStatus === 'loading' ? '加载中…' : '（无仓库）'),
    )
  } else {
    for (const repo of repoSources) {
      const value = String(repo.path || repo.repo || '')
      if (!value) continue
      repoOptionNodes.push(h('option', { key: value, value }, String(repo.name || value.split('/').pop() || value)))
    }
    if (repoPath && !repoSources.some((repo) => (repo.path || repo.repo) === repoPath)) {
      repoOptionNodes.push(h('option', { key: '__current', value: repoPath }, repoPath.split('/').pop() || repoPath))
    }
  }

  // ---- branch chips ----
  const chipNodes = [
    h(
      'button',
      {
        type: 'button',
        key: '__all',
        className: 'mdr-gitgraph-chip' + (filterBranch === '' ? ' on' : ''),
        onClick: () => setFilterBranch(''),
        title: '显示全部提交',
      },
      '全部提交',
    ),
  ]
  branches.forEach((branch, index) => {
    if (!branch || !branch.name) return
    const headHash = gitGraphResolveHead(commits, branch.hash)
    const headRow = headHash && layout.rowOf.has(headHash) ? layout.rowOf.get(headHash) : -1
    const color = gitGraphLaneColor(headRow >= 0 ? layout.rows[headRow].lane : index)
    const active = filterBranch === branch.name
    chipNodes.push(
      h(
        'button',
        {
          type: 'button',
          key: branch.name,
          className: 'mdr-gitgraph-chip' + (active ? ' on' : ''),
          style: active ? { borderColor: color } : undefined,
          onClick: () => setFilterBranch(active ? '' : branch.name),
          title: `${branch.name} · ${branch.hash || ''}（点击高亮该分支可达的提交，再点取消）`,
        },
        h('span', { className: 'mdr-gitgraph-chip-dot', style: { background: color } }),
        branch.name,
      ),
    )
  })

  // ---- body state ----
  let bodyNode = null
  if (graphStatus === 'loading' || (reposStatus === 'loading' && graphStatus === 'idle' && !error)) {
    bodyNode = h('div', { className: 'mdr-gitgraph-state' }, '正在读取版本图…')
  } else if (graphStatus === 'error') {
    bodyNode = h(
      'div',
      { className: 'mdr-gitgraph-state mdr-gitgraph-state-err' },
      h('div', null, error || '版本树加载失败'),
      h('button', { type: 'button', className: 'mdr-btn', onClick: refresh }, '重试'),
    )
  } else if (graphStatus === 'empty') {
    bodyNode = h(
      'div',
      { className: 'mdr-gitgraph-state' },
      h('div', null, '没有找到 git 仓库'),
      h(
        'div',
        { className: 'mdr-gitgraph-state-hint' },
        reposError || '当前工作区根下没有 git 仓库；可先用顶栏「工作区」菜单打开包含仓库的目录。',
      ),
    )
  } else if (graphStatus === 'ready' && !layout.rows.length) {
    bodyNode = h(
      'div',
      { className: 'mdr-gitgraph-state' },
      h('div', null, '该仓库没有提交记录'),
      graph && graph.repo ? h('div', { className: 'mdr-gitgraph-state-hint' }, graph.repo) : null,
    )
  } else if (graphStatus === 'ready') {
    bodyNode = h(
      'div',
      { className: 'mdr-gitgraph-canvas', style: { height: graphHeight }, onClick: onCanvasClick },
      h(
        'svg',
        {
          className: 'mdr-gitgraph-svg',
          width: gutter,
          height: graphHeight,
          viewBox: `0 0 ${gutter} ${graphHeight}`,
          'aria-hidden': true,
        },
        svgChildren,
      ),
      h('div', { className: 'mdr-gitgraph-rows' }, rowNodes),
    )
  } else {
    bodyNode = h('div', { className: 'mdr-gitgraph-state' }, '正在准备版本图…')
  }

  const detailNode = selectedCommit
    ? h(
        'div',
        { className: 'mdr-gitgraph-detail' },
        h(
          'div',
          { className: 'mdr-gitgraph-detail-main' },
          h(
            'div',
            { className: 'mdr-gitgraph-detail-row' },
            h('span', { className: 'mdr-gitgraph-detail-k' }, '提交'),
            h('span', { className: 'mdr-gitgraph-detail-v mdr-gitgraph-detail-hash' }, String(selectedCommit.hash || '')),
          ),
          h(
            'div',
            { className: 'mdr-gitgraph-detail-row' },
            h('span', { className: 'mdr-gitgraph-detail-k' }, '作者'),
            h('span', { className: 'mdr-gitgraph-detail-v' }, selectedCommit.author || '—'),
          ),
          h(
            'div',
            { className: 'mdr-gitgraph-detail-row' },
            h('span', { className: 'mdr-gitgraph-detail-k' }, '日期'),
            h('span', { className: 'mdr-gitgraph-detail-v' }, selectedCommit.date || '—'),
          ),
          h(
            'div',
            { className: 'mdr-gitgraph-detail-row' },
            h('span', { className: 'mdr-gitgraph-detail-k' }, '父提交'),
            h(
              'span',
              { className: 'mdr-gitgraph-detail-v' },
              Array.isArray(selectedCommit.parents) && selectedCommit.parents.length
                ? selectedCommit.parents.map((parent) => {
                    const loaded = layout.rowOf.has(parent)
                    return h(
                      'button',
                      {
                        key: parent,
                        type: 'button',
                        className: 'mdr-gitgraph-parent',
                        disabled: !loaded,
                        title: loaded ? `跳转到父提交 ${parent}` : `父提交 ${parent} 不在当前加载的 ${GITGRAPH_LIMIT} 条提交内`,
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          if (loaded) selectCommit(parent)
                        },
                      },
                      String(parent).slice(0, 7),
                    )
                  })
                : '（根提交）',
            ),
          ),
          h(
            'div',
            { className: 'mdr-gitgraph-detail-row' },
            h('span', { className: 'mdr-gitgraph-detail-k' }, '分支'),
            h(
              'span',
              { className: 'mdr-gitgraph-detail-v' },
              Array.isArray(selectedCommit.refs) && selectedCommit.refs.length ? selectedCommit.refs.join('、') : '—',
            ),
          ),
          h('div', { className: 'mdr-gitgraph-detail-subject' }, selectedCommit.subject || '(无提交说明)'),
        ),
        h(
          'div',
          { className: 'mdr-gitgraph-detail-actions' },
          copyState
            ? h(
                'span',
                { className: 'mdr-gitgraph-copied' + (copyState === 'fail' ? ' err' : '') },
                copyState === 'done' ? '已复制 hash' : '复制失败，请手动选择',
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'mdr-btn',
              onClick: () => copyHash(selectedCommit.hash),
              title: '复制完整提交 hash 到剪贴板',
            },
            '复制 hash',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mdr-btn',
              onClick: () => {
                selectCommit('')
              },
              title: '关闭提交详情',
              'aria-label': '关闭提交详情',
            },
            h(Icons.close, { size: 12 }),
          ),
        ),
      )
    : null

  const statsText = graph ? `${layout.rows.length} 提交 · ${branches.length} 分支` : ''
  const filterHint = filterActive
    ? `已高亮 ${highlight.size} 个提交`
    : filterBranch
      ? '该分支头不在当前加载的提交范围内'
      : '点击提交查看详情 · 可复制 hash'

  return h(
    'div',
    {
      className: 'mdr-overlay',
      onClick: close,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Git 版本树',
    },
    h(
      'div',
      { className: 'mdr-panel mdr-gitgraph-panel', onClick: (event) => event.stopPropagation() },
      h('style', { dangerouslySetInnerHTML: { __html: GITGRAPH_CSS } }),
      h(
        'div',
        { className: 'mdr-panel-head mdr-gitgraph-head' },
        h('span', { className: 'mdr-gitgraph-title' }, 'Git 版本树'),
        h(
          'select',
          {
            className: 'mdr-gitgraph-repo',
            value: repoPath,
            disabled: reposStatus === 'loading' || repoSources.length <= 1,
            onChange: (event) => selectRepo(event.target.value),
            title: '切换仓库（只列出工作区根下的 git 仓库）',
            'aria-label': '选择仓库',
          },
          repoOptionNodes,
        ),
        h('span', { className: 'mdr-spacer' }),
        h('span', { className: 'mdr-gitgraph-stats' }, statsText),
        h(
          'button',
          { type: 'button', className: 'mdr-btn', onClick: refresh, title: '重新读取版本图', disabled: graphStatus === 'loading' },
          h(Icons.refresh, { size: 13 }),
        ),
        h(
          'button',
          { type: 'button', className: 'mdr-btn', onClick: close, title: '关闭（Esc）', 'aria-label': '关闭' },
          h(Icons.close, { size: 12 }),
        ),
      ),
      h(
        'div',
        { className: 'mdr-gitgraph-body' },
        graph
          ? h(
              'div',
              { className: 'mdr-gitgraph-toolbar' },
              h(
                'div',
                { className: 'mdr-gitgraph-repo-line' },
                h('span', { className: 'mdr-gitgraph-repo-name' }, graph.name || graph.repo || '仓库'),
                h('span', { className: 'mdr-gitgraph-repo-path', title: graph.repo || '' }, graph.repo || ''),
                h('span', { className: 'mdr-spacer' }),
                h(
                  'span',
                  { className: 'mdr-gitgraph-stats' },
                  graph.current ? `当前分支 ${graph.current}` : '未在分支上（detached HEAD）',
                ),
              ),
              h('div', { className: 'mdr-gitgraph-chips' }, chipNodes),
            )
          : null,
        h('div', { className: 'mdr-gitgraph-scroll', ref: scrollRef }, bodyNode),
        detailNode,
        graph
          ? h(
              'div',
              { className: 'mdr-gitgraph-foot' },
              h(
                'span',
                { className: 'mdr-gitgraph-legend' },
                h('span', { className: 'mdr-gitgraph-foot-dot', style: { background: gitGraphLaneColor(0) } }),
                '普通提交',
              ),
              h('span', { className: 'mdr-gitgraph-legend' }, h('span', { className: 'mdr-gitgraph-foot-dia' }), '合并提交'),
              h('span', { className: 'mdr-gitgraph-legend' }, '直线 / 曲线 = 分支汇入'),
              h('span', { className: 'mdr-spacer' }),
              h('span', { title: filterActive ? '再次点击该分支 chip 取消高亮' : '' }, filterHint),
            )
          : null,
      ),
    ),
  )
}
