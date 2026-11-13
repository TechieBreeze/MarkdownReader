/** App shell: 项目 → 任务 workbench, tab kinds, nav history, Harness slots. */

const NavBackIcon = svgIcon(['M15 18l-6-6 6-6'])
const NavFwdIcon = svgIcon(['M9 18l6-6-6-6'])

/**
 * 项目管理 panel (topbar 项目 button, Alt+P). Every workspace root is a 项目;
 * `currentProject` = null is the 全部 view whose tree top level lists the roots.
 * Add/remove go through POST /api/roots { action: 'add' | 'remove', path }.
 */
function ProjectsPanel(props) {
  const { meta, current, onSwitch, onAdd, onRemove, onClose } = props
  const [value, setValue] = React.useState('')
  const roots = (meta && meta.roots) || []
  const single = !!(meta && meta.single)
  const submit = () => {
    const text = value.trim()
    if (!text) return
    onAdd(text)
    setValue('')
  }
  const switchButton = (name, active) =>
    h(
      'button',
      {
        className: 'mdr-btn' + (active ? ' on' : ''),
        disabled: active,
        onClick: (event) => {
          event.stopPropagation()
          if (!active) onSwitch(name)
        },
      },
      active ? '当前' : '切换',
    )
  return h(
    'div',
    { className: 'mdr-roots', style: { width: 430 } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      h('h3', { style: { margin: 0, flex: 1 } }, '项目管理'),
      h('span', { className: 'mdr-tip' }, '添加 / 切换 / 移除项目'),
      h('span', { className: 'mdr-btn', onClick: onClose }, '✕'),
    ),
    current
      ? h(
          'div',
          { className: 'mdr-root-row', style: { cursor: 'pointer' }, onClick: () => onSwitch('') },
          h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, '全部项目'),
          h('span', { className: 'mdr-root-path' }, '目录树顶层聚合显示所有项目'),
          switchButton('', false),
        )
      : null,
    roots.map((root) =>
      h(
        'div',
        {
          className: 'mdr-root-row',
          key: root.path,
          style: { cursor: current === root.name ? 'default' : 'pointer' },
          onClick: () => onSwitch(root.name),
        },
        h(
          'span',
          { style: { flex: '0 0 auto', fontWeight: current === root.name ? 600 : 400, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          root.name + (current === root.name ? ' ✓' : ''),
        ),
        h('span', { className: 'mdr-root-path', title: root.path }, root.path),
        switchButton(root.name, current === root.name),
        h(
          'button',
          {
            className: 'mdr-btn',
            title: '从工作区移除该项目（不删除磁盘文件；其标签页关闭）',
            disabled: single && roots.length <= 1,
            onClick: (event) => {
              event.stopPropagation()
              onRemove(root.path)
            },
          },
          '移除',
        ),
      ),
    ),
    h('input', {
      value,
      placeholder: '添加项目：输入根目录绝对路径，回车确认',
      onChange: (event) => setValue(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      },
    }),
    h(
      'div',
      { className: 'mdr-tip', style: { marginTop: 8, lineHeight: 1.6 } },
      roots.length > 1
        ? '目录树顶层跟随当前项目；「全部项目」模式下列表显示所有项目根。'
        : '当前为单项目模式；添加第二个项目后可在项目管理里切换 / 聚合浏览。',
    ),
  )
}

function EmptyState(props) {
  const { meta, currentProject } = props
  const roots = (meta && meta.roots) || []
  return h(
    'div',
    { className: 'mdr-empty' },
    h(Icons.doc, { size: 40 }),
    h('h2', null, 'Markdown Reader'),
    h('div', null, '左侧目录树选择文档，或在顶栏输入相对路径。'),
    h(
      'div',
      { className: 'mdr-tip' },
      roots.length
        ? currentProject
          ? `当前项目：${currentProject}`
          : `全部项目：${roots.map((root) => root.name).join(' · ')}`
        : '尚未打开项目',
    ),
  )
}

/** Git 图 icon (topbar button) — same glyph as the original standalone tool. */
function GitGraphIcon(props) {
  const size = (props && props.size) || 14
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block', flex: '0 0 auto' },
    },
    h('circle', { cx: 6, cy: 5, r: 3 }),
    h('circle', { cx: 18, cy: 19, r: 3 }),
    h('circle', { cx: 6, cy: 19, r: 3 }),
    h('path', { d: 'M6 8v8M9 5h4a5 5 0 0 1 5 5v6' }),
  )
}

/**
 * Collapse an accidentally doubled multi-root prefix: `X/X/rest` -> `X/rest`.
 *
 * Only in multi-root mode and only when `X` is an actual workspace root — a
 * single-root project legitimately may contain `<dir>/<dir>/…` and must not be
 * rewritten. The old locator prepended the current project to an already
 * prefixed path and persisted the dead `X/X/...` paths into the tree expansion
 * store; the Host now tolerates them but the client also self-heals here.
 */
function collapseDoubledVtopPrefix(rel, meta) {
  const text = String(rel == null ? '' : rel)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!meta || meta.single || !Array.isArray(meta.roots)) return text
  let segs = text.split('/').filter(Boolean)
  while (segs.length >= 2 && segs[0] === segs[1] && meta.roots.some((root) => root.name === segs[0])) {
    segs = segs.slice(1)
  }
  return segs.join('/')
}

function App() {
  // 「上一次会话的项目选择」在首帧就决定任务集 / 展开态，避免先渲染 全部 再闪切。
  const initialProjectRef = React.useRef(loadProjectSelection())
  const initialWorkbenchRef = React.useRef(null)
  if (!initialWorkbenchRef.current) {
    const restored = restoreWorkbench(initialProjectRef.current)
    if (restored) initialWorkbenchRef.current = restored
    else {
      const task = newTaskRecord('默认')
      initialWorkbenchRef.current = { tasks: [task], activeTaskId: task.id }
    }
  }

  const [meta, setMeta] = React.useState(null)
  const [currentProject, setCurrentProject] = React.useState(initialProjectRef.current)
  const [workbench, setWorkbench] = React.useState(initialWorkbenchRef.current)
  const [dirs, setDirs] = React.useState(() => loadTreeDirs(initialProjectRef.current))
  const [expanded, setExpanded] = React.useState(() => new Set(loadTreeExpansion(initialProjectRef.current)))
  const [error, setError] = React.useState('')
  const [pathInput, setPathInput] = React.useState('')
  const [projectsOpen, setProjectsOpen] = React.useState(false)
  const [overlay, setOverlay] = React.useState(null)
  const [modalRequest, setModalRequest] = React.useState(null)
  const [syncOpen, setSyncOpen] = React.useState(false)
  const [gitOpen, setGitOpen] = React.useState(false)
  const [failedDirs, setFailedDirs] = React.useState({})
  const [vendorReady, setVendorReady] = React.useState(false)
  const [locateTarget, setLocateTarget] = React.useState('')
  const [nav, setNav] = React.useState({ stack: [], idx: -1 })

  const inflightDirsRef = React.useRef(new Set())
  const inflightTabsRef = React.useRef(new Set())
  const dirsRef = React.useRef(dirs)
  const expandedRef = React.useRef(expanded)
  const workbenchRef = React.useRef(workbench)
  const metaRef = React.useRef(meta)
  const currentProjectRef = React.useRef(currentProject)
  const contentRef = React.useRef(null)
  const navRef = React.useRef(nav)
  const panelsRef = React.useRef({ modal: false, sync: false, git: false, projects: false })
  const switchProjectRef = React.useRef(null)
  dirsRef.current = dirs
  expandedRef.current = expanded
  workbenchRef.current = workbench
  metaRef.current = meta
  currentProjectRef.current = currentProject
  navRef.current = nav
  panelsRef.current = {
    modal: !!modalRequest,
    sync: syncOpen,
    git: gitOpen,
    projects: projectsOpen,
  }

  /**
   * Forget an expanded directory that no longer exists.
   *
   * The expansion set is persisted per project, so a directory the user
   * deleted stayed in the stored set and was requested on EVERY open - each
   * request failing with "目录不存在" and showing an error. The path is dropped
   * from the in-memory set and from the stored set.
   */
  const pruneExpanded = React.useCallback((rel) => {
    const key = String(rel == null ? '' : rel)
    const current = expandedRef.current
    if (!current.has(key)) return
    const next = new Set(current)
    next.delete(key)
    expandedRef.current = next
    setExpanded(next)
    saveTreeExpansion(currentProjectRef.current, next)
  }, [])

  const activeTask = workbench.tasks.find((task) => task.id === workbench.activeTaskId) || workbench.tasks[0] || null
  const tabs = activeTask ? activeTask.tabs : []
  const activeId = activeTask ? activeTask.activeId : null
  const activeTab = tabs.find((tab) => tab.id === activeId) || null
  const multi = !!(meta && !meta.single)
  const rootNames = React.useMemo(() => (meta ? meta.roots.map((root) => root.name) : []), [meta])
  // 项目模式：目录树顶层 = 该项目根的下一层；全部模式（或单根）= 虚拟顶层 ''。
  const rootKey = currentProject && multi ? currentProject : ''
  const activeTabKey = activeTab
    ? `${activeTab.id}|${activeTab.content == null ? 'pending' : 'loaded'}|${activeTab.error || ''}`
    : ''

  /* ------------------------------------------------- 文件内搜索 (Ctrl+F) */

  /**
   * One bucket PER SCOPE: the code popup (弹窗) and the tabs (标签页) are
   * separate search sessions.
   *
   * They shared one state, so a search opened inside the popup FOLLOWED the
   * user into the tab when the popup closed (user report: 「弹窗内外搜索是分开
   * 的，当前在弹窗内打开搜索后关闭弹窗，搜索会跟到标签页内」). The standalone
   * reader was a single widget that re-resolved its scope on every search; in
   * the plugin the popup is an overlay ON TOP of a still-mounted tab, so the
   * two must not share a query, options, marks or the open state.
   */
  const emptyFsBucket = () => ({
    open: false,
    query: '',
    applied: '',
    info: { count: 0, index: -1, status: '' },
    options: { cs: false, word: false, re: false },
  })
  const [fsBuckets, setFsBuckets] = React.useState(() => ({ tab: emptyFsBucket(), modal: emptyFsBucket() }))
  // What is on screen decides which session Ctrl+F talks to.
  const fsScope = modalRequest ? 'modal' : 'tab'
  const fsBucketsRef = React.useRef(fsBuckets)
  fsBucketsRef.current = fsBuckets
  const fsScopeRef = React.useRef(fsScope)
  fsScopeRef.current = fsScope

  const patchFs = React.useCallback((scope, patch) => {
    setFsBuckets((prev) => ({ ...prev, [scope]: { ...prev[scope], ...patch } }))
  }, [])

  /** The controller of ONE scope: the popup's code body or the active tab's. */
  const fsControllerOf = React.useCallback(
    (scope) =>
      scope === 'modal'
        ? fileSearchController(typeof MODAL_SEARCH_KEY === 'string' ? MODAL_SEARCH_KEY : '@modal')
        : fileSearchController(activeTab ? activeTab.id : ''),
    [activeTab],
  )

  const runFileSearchIn = React.useCallback(
    (scope, query) => {
      const bucket = fsBucketsRef.current[scope]
      const controller = fsControllerOf(scope)
      if (!controller) {
        patchFs(scope, { applied: query, info: { count: 0, index: -1, status: '该视图不可搜索' } })
        return
      }
      const result = controller.search(query, bucket.options)
      patchFs(scope, {
        applied: query,
        info: {
          count: Number(result.count || 0),
          index: Number(result.index == null ? -1 : result.index),
          status: result.error || (result.count ? '' : '无匹配'),
        },
      })
    },
    [fsControllerOf, patchFs],
  )

  const gotoFileSearchIn = React.useCallback(
    (scope, delta) => {
      const bucket = fsBucketsRef.current[scope]
      const controller = fsControllerOf(scope)
      if (!controller) {
        patchFs(scope, { info: { count: 0, index: -1, status: '该视图不可搜索' } })
        return
      }
      // A changed query means "search", not "navigate".
      if (bucket.query !== bucket.applied) {
        runFileSearchIn(scope, bucket.query)
        return
      }
      const result = controller.goto(delta)
      patchFs(scope, {
        info: {
          count: Number(result.count || 0),
          index: Number(result.index == null ? -1 : result.index),
          status: result.error || (result.count ? '' : '无匹配'),
        },
      })
    },
    [fsControllerOf, patchFs, runFileSearchIn],
  )

  const closeFileSearchIn = React.useCallback(
    (scope) => {
      const controller = fsControllerOf(scope)
      if (controller) controller.clear()
      patchFs(scope, emptyFsBucket())
    },
    [fsControllerOf, patchFs],
  )

  const openFileSearch = React.useCallback(() => patchFs(fsScopeRef.current, { open: true }), [patchFs])

  const toggleFileSearchOptionIn = React.useCallback((scope, key) => {
    setFsBuckets((prev) => {
      const bucket = prev[scope]
      return { ...prev, [scope]: { ...bucket, options: { ...bucket.options, [key]: !bucket.options[key] } } }
    })
  }, [])

  // Closing the popup ends ITS session; the tab keeps its own, and the popup's
  // query can never migrate into it.
  React.useEffect(() => {
    if (modalRequest) return
    setFsBuckets((prev) =>
      prev.modal.open || prev.modal.query || prev.modal.applied ? { ...prev, modal: emptyFsBucket() } : prev,
    )
  }, [modalRequest])

  /** Save the active markdown tab scroll NOW, before the DOM switches away. */
  const saveActiveScroll = React.useCallback(() => {
    const scroller = contentRef.current
    if (!scroller) return
    const wb = workbenchRef.current
    const task = wb.tasks.find((item) => item.id === wb.activeTaskId)
    const tab = task && task.activeId ? task.tabs.find((item) => item.id === task.activeId) : null
    if (!tab || tab.kind !== 'md') return
    scrollStorage.set(mdScrollKey(task.id, tab.path), scroller.scrollTop)
    rememberTabScroll(tabScrollKey(task.id, tab.id), scroller.scrollTop)
  }, [])

  /** Patch one tab wherever it lives (tab ids are unique per kind:path). */
  const patchTab = React.useCallback((id, patch) => {
    setWorkbench((prev) => {
      let changed = false
      const tasks = prev.tasks.map((task) => {
        if (!task.tabs.some((tab) => tab.id === id)) return task
        const tabs = task.tabs.map((tab) => {
          if (tab.id !== id) return tab
          changed = true
          return { ...tab, ...patch }
        })
        return { ...task, tabs }
      })
      return changed ? { ...prev, tasks } : prev
    })
  }, [])

  const saveWorkbenchNow = React.useCallback(() => {
    saveWorkbench(currentProjectRef.current, workbenchRef.current)
  }, [])

  /* ------------------------------------------------------------ navigation */

  const pushNav = React.useCallback((entry) => {
    if (!entry || !entry.path) return
    setNav((prev) => {
      const current = prev.stack[prev.idx]
      if (current && current.path === entry.path && (current.line || 0) === (entry.line || 0)) return prev
      const stack = prev.stack.slice(0, prev.idx + 1)
      stack.push({
        path: entry.path,
        line: entry.line || 0,
        branch: entry.branch || '',
        commit: entry.commit || '',
        kind: entry.kind || '',
        taskId: entry.taskId || '',
      })
      if (stack.length > 200) stack.shift()
      return { stack, idx: stack.length - 1 }
    })
  }, [])

  /**
   * Re-open a history entry: switch to the task that owns the tab when possible,
   * (re)open the tab, apply the line / git version. Markdown scroll comes back
   * from the per-file scroll store (saveActiveScroll ran before we left).
   */
  const applyNavEntry = React.useCallback((entry) => {
    if (!entry || !entry.path) return
    // Definition jumps may open a non-code extension as a code tab; the entry
    // remembers the intended kind so Alt+← restores the same tab.
    const kind = entry.kind === 'code' || entry.kind === 'md' ? entry.kind : kindForPath(entry.path)
    const id = `${kind}:${entry.path}`
    const wb = workbenchRef.current
    const candidates = wb.tasks.filter((task) => task.tabs.some((tab) => tab.id === id))
    const targetTask =
      candidates.find((task) => task.id === entry.taskId) ||
      candidates.find((task) => task.id === wb.activeTaskId) ||
      candidates[0] ||
      wb.tasks.find((task) => task.id === wb.activeTaskId) ||
      wb.tasks[0]
    if (!targetTask) return
    setWorkbench((prev) => {
      const tasks = prev.tasks.map((task) => {
        if (task.id !== targetTask.id) return task
        const index = task.tabs.findIndex((tab) => tab.id === id)
        let tabs
        if (index >= 0) {
          tabs = task.tabs.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  line: entry.line || 0,
                  branch: entry.branch || tab.branch || '',
                  commit: entry.commit || tab.commit || '',
                  navFrom: true,
                }
              : tab,
          )
        } else {
          tabs = task.tabs.concat([
            {
              id,
              kind,
              path: entry.path,
              content: null,
              lang: kind === 'code' ? langForPath(entry.path) : kind === 'html' ? 'xml' : '',
              line: entry.line || 0,
              branch: entry.branch || '',
              commit: entry.commit || '',
              htmlMode: 'render',
              navFrom: true,
              error: '',
              scroll: recallTabScroll(tabScrollKey(targetTask.id, id)),
            },
          ])
        }
        return { ...task, tabs, activeId: id }
      })
      return { ...prev, tasks, activeTaskId: targetTask.id }
    })
    if (kind === 'md') {
      const top = recallTabScroll(tabScrollKey(targetTask.id, id))
      if (top > 0) {
        scrollStorage.set(mdScrollKey(targetTask.id, entry.path), top)
        const apply = () => {
          const scroller = contentRef.current
          if (scroller && Math.abs(scroller.scrollTop - top) > 2) scroller.scrollTop = top
        }
        setTimeout(apply, 0)
        setTimeout(apply, 180)
      }
    }
  }, [])

  const goNav = React.useCallback(
    (delta) => {
      const state = navRef.current
      const next = state.idx + delta
      if (next < 0 || next >= state.stack.length) return
      const entry = state.stack[next]
      saveActiveScroll()
      setNav({ stack: state.stack, idx: next })
      applyNavEntry(entry)
    },
    [saveActiveScroll, applyNavEntry],
  )

  /* --------------------------------------------------------------- loading */

  const loadDir = React.useCallback((rel) => {
    // Defensive: a stale persisted `X/X/...` expansion path must never be
    // requested as-is (see collapseDoubledVtopPrefix).
    const key = collapseDoubledVtopPrefix(String(rel == null ? '' : rel), metaRef.current)
    // 同一目录可能被「恢复展开态 / 展开点击 / 刷新」同时要求加载，inflight 去重。
    if (inflightDirsRef.current.has(key)) return Promise.resolve()
    inflightDirsRef.current.add(key)
    setFailedDirs((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    return fetchJson('/api/list', { path: key })
      .then((payload) => {
        const entries = Array.isArray(payload.entries) ? payload.entries : []
        setDirs((prev) => {
          const next = { ...prev, [key]: entries }
          // Keep the listings: they make the tree render instantly when the
          // panel is mounted again after a trip to the conversation.
          saveTreeDirs(currentProjectRef.current, next)
          return next
        })
      })
      .catch((err) => {
        setFailedDirs((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
        const message = String((err && err.message) || err)
        if (/目录不存在|not found|ENOENT/i.test(message)) {
          // The directory was deleted (the user removed a docs folder). A
          // persisted expansion path pointing at it must not produce an error
          // on EVERY open: drop the path silently and forget it.
          pruneExpanded(key)
          return
        }
        setError(message)
      })
      .finally(() => {
        inflightDirsRef.current.delete(key)
      })
  }, [])

  const loadTab = React.useCallback(
    (id, kind, rel) => {
      if (!id || inflightTabsRef.current.has(id)) return
      inflightTabsRef.current.add(id)
      const endpoint = kind === 'md' ? '/api/markdown' : '/api/code'
      fetchJson(endpoint, { path: rel })
        .then((payload) => {
          patchTab(id, {
            content: payload.content,
            lang: payload.lang || langForPath(rel) || (kind === 'html' ? 'xml' : ''),
            error: '',
          })
        })
        .catch((err) => {
          const message = String((err && err.message) || err)
          // A file the user deleted keeps its own error in the tab; the global
          // banner would repeat it on every open.
          if (!/不存在|not found|ENOENT/i.test(message)) setError(message)
          patchTab(id, { error: message })
        })
        .finally(() => {
          inflightTabsRef.current.delete(id)
        })
    },
    [patchTab],
  )

  /* --------------------------------------------------------- open / close */

  const openPath = React.useCallback(
    (rel, line, opts) => {
      const options = opts || {}
      const value = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .trim()
      if (!value) return
      // A definition jump always opens in the CODE view, even when the target is
      // .html/.vue/... (opts.kind overrides the extension-based tab kind).
      const kind = options.kind === 'code' || options.kind === 'md' ? options.kind : kindForPath(value)
      const id = `${kind}:${value}`
      const targetLine = line == null ? 0 : Math.max(0, Number(line) || 0)
      saveActiveScroll()
      setWorkbench((prev) => {
        const tasks = prev.tasks.map((task) => {
          if (task.id !== prev.activeTaskId) return task
          const index = task.tabs.findIndex((tab) => tab.id === id)
          if (index >= 0) {
            const tabs = task.tabs.map((tab) =>
              tab.id === id
                ? {
                    ...tab,
                    line: line == null ? tab.line : targetLine,
                    branch: options.branch || tab.branch || '',
                    commit: options.commit || tab.commit || '',
                    navFrom: options.jump ? true : !!tab.navFrom,
                    // undefined = leave the existing entry bar alone
                    ...(options.defBar !== undefined ? { defBar: options.defBar } : {}),
                  }
                : tab,
            )
            return { ...task, tabs, activeId: id }
          }
          const tab = {
            id,
            kind,
            path: value,
            content: null,
            lang: kind === 'code' ? langForPath(value) : kind === 'html' ? 'xml' : '',
            line: targetLine,
            branch: options.branch || '',
            commit: options.commit || '',
            htmlMode: 'render',
            navFrom: !!options.jump,
            defBar: options.defBar !== undefined ? options.defBar : null,
            error: '',
            scroll: 0,
          }
          // Open next to the tab that started the jump (reference behaviour),
          // not always at the far right.
          const anchorIndex = task.tabs.findIndex((tabItem) => tabItem.id === task.activeId)
          const tabs = task.tabs.slice()
          if (anchorIndex >= 0) tabs.splice(anchorIndex + 1, 0, tab)
          else tabs.push(tab)
          return { ...task, tabs, activeId: id }
        })
        return { ...prev, tasks }
      })
      // Definition jumps first record the clicked source position (the original's
      // ctrlJump pushNav(src.path, lineNo)) so ← 返回 / Alt+← return to the token.
      if (options.from && options.from.path) {
        pushNav({
          path: options.from.path,
          line: Math.max(0, Number(options.from.line) || 0),
          branch: options.from.branch || '',
          commit: options.from.commit || '',
          kind: 'code',
          taskId: workbenchRef.current.activeTaskId,
        })
      }
      pushNav({
        path: value,
        line: targetLine,
        branch: options.branch || '',
        commit: options.commit || '',
        kind,
        taskId: workbenchRef.current.activeTaskId,
      })
    },
    [saveActiveScroll, pushNav],
  )

  const activateTab = React.useCallback(
    (id) => {
      const wb = workbenchRef.current
      const task = wb.tasks.find((item) => item.id === wb.activeTaskId)
      if (!task || task.activeId === id || !task.tabs.some((tab) => tab.id === id)) return
      saveActiveScroll()
      setWorkbench((prev) => ({
        ...prev,
        tasks: prev.tasks.map((item) => (item.id === prev.activeTaskId ? { ...item, activeId: id } : item)),
      }))
    },
    [saveActiveScroll],
  )

  const closeTab = React.useCallback(
    (id) => {
      saveActiveScroll()
      inflightTabsRef.current.delete(id)
      const closingPath = id.slice(id.indexOf(':') + 1)
      setModalRequest((current) => (current && current.path === closingPath ? null : current))
      setWorkbench((prev) => {
        const owner = prev.tasks.find((task) => task.tabs.some((tab) => tab.id === id))
        if (!owner) return prev
        const tasks = prev.tasks.map((task) => {
          if (task.id !== owner.id) return task
          const index = task.tabs.findIndex((tab) => tab.id === id)
          const nextTabs = task.tabs.filter((tab) => tab.id !== id)
          let activeId = task.activeId
          if (activeId === id) activeId = nextTabs.length ? nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)].id : null
          return { ...task, tabs: nextTabs, activeId }
        })
        return { ...prev, tasks }
      })
    },
    [saveActiveScroll],
  )

  /* --------------------------------------------------------------- tasks */

  const switchTask = React.useCallback(
    (id) => {
      if (id === workbenchRef.current.activeTaskId) return
      if (!workbenchRef.current.tasks.some((task) => task.id === id)) return
      saveActiveScroll()
      setWorkbench((prev) => ({ ...prev, activeTaskId: id }))
    },
    [saveActiveScroll],
  )

  const newTask = React.useCallback(() => {
    saveActiveScroll()
    const task = newTaskRecord(`任务${taskSeq + 1}`)
    setWorkbench((prev) => ({ tasks: prev.tasks.concat([task]), activeTaskId: task.id }))
  }, [saveActiveScroll])

  const renameTask = React.useCallback((id, name) => {
    const value = String(name || '').trim()
    if (!value) return
    setWorkbench((prev) => ({
      ...prev,
      tasks: prev.tasks.map((task) => (task.id === id ? { ...task, name: value } : task)),
    }))
  }, [])

  const deleteTask = React.useCallback(
    (id) => {
      saveActiveScroll()
      setWorkbench((prev) => {
        if (!prev.tasks.some((task) => task.id === id)) return prev
        if (prev.tasks.length <= 1) {
          // Never leave the workbench without a task: the last × clears it.
          return {
            ...prev,
            tasks: prev.tasks.map((task) => (task.id === id ? { ...task, tabs: [], activeId: null } : task)),
          }
        }
        const index = prev.tasks.findIndex((task) => task.id === id)
        const tasks = prev.tasks.filter((task) => task.id !== id)
        const activeTaskId =
          prev.activeTaskId === id ? tasks[Math.min(Math.max(index, 0), tasks.length - 1)].id : prev.activeTaskId
        return { tasks, activeTaskId }
      })
    },
    [saveActiveScroll],
  )

  const reorderTasks = React.useCallback((dragId, targetId, before) => {
    if (!dragId || !targetId || dragId === targetId) return
    setWorkbench((prev) => {
      const from = prev.tasks.findIndex((task) => task.id === dragId)
      if (from < 0) return prev
      const tasks = prev.tasks.slice()
      const [moved] = tasks.splice(from, 1)
      const targetIndex = tasks.findIndex((task) => task.id === targetId)
      if (targetIndex < 0) return prev
      tasks.splice(before ? targetIndex : targetIndex + 1, 0, moved)
      return { ...prev, tasks }
    })
  }, [])

  /**
   * Drag a tab to another position INSIDE the active task.
   *
   * The same mechanism as the task chips (`reorderTasks`): the dragged id comes
   * from the tab bar, the target's left/right half decides whether the tab
   * lands before or after it.
   */
  const reorderTabs = React.useCallback((dragId, targetId, before) => {
    if (!dragId || !targetId || dragId === targetId) return
    setWorkbench((prev) => {
      const task = prev.tasks.find((item) => item.id === prev.activeTaskId)
      if (!task) return prev
      const from = task.tabs.findIndex((tab) => tab.id === dragId)
      if (from < 0) return prev
      const tabs = task.tabs.slice()
      const [moved] = tabs.splice(from, 1)
      const targetIndex = tabs.findIndex((tab) => tab.id === targetId)
      if (targetIndex < 0) return prev
      tabs.splice(before ? targetIndex : targetIndex + 1, 0, moved)
      return {
        ...prev,
        tasks: prev.tasks.map((item) => (item.id === task.id ? { ...item, tabs } : item)),
      }
    })
  }, [])

  /* ----------------------------------------------------------------- tree */

  const toggleDir = React.useCallback(
    (rel) => {
      const willOpen = !expandedRef.current.has(rel)
      const next = new Set(expandedRef.current)
      if (willOpen) next.add(rel)
      else next.delete(rel)
      setExpanded(next)
      expandedRef.current = next
      saveTreeExpansion(currentProjectRef.current, next)
      if (willOpen && !dirsRef.current[rel]) loadDir(rel)
    },
    [loadDir],
  )

  const refreshTree = React.useCallback(() => {
    const current = currentProjectRef.current
    const metaNow = metaRef.current
    const root = current && metaNow && !metaNow.single ? current : ''
    const active = expandedRef.current
    const paths = [root, ...[...active].filter((rel) => rel && rel !== root)]
    paths.forEach((rel) => loadDir(rel))
    setFailedDirs((prev) => (Object.keys(prev).length ? {} : prev))
    setDirs((prev) => {
      const next = { ...prev }
      for (const rel of Object.keys(next)) {
        if (rel !== root && !active.has(rel)) delete next[rel]
      }
      return next
    })
  }, [loadDir])

  /** Expand the file's ancestors (respecting project prefixes) and highlight it. */
  const locateInTree = React.useCallback(
    (filePath) => {
      const metaNow = metaRef.current
      // Self-heal a doubled prefix on the file path itself (old persisted tabs).
      const path = collapseDoubledVtopPrefix(String(filePath || ''), metaNow)
      if (!path) return
      const roots = metaNow ? metaNow.roots.map((root) => root.name) : []
      const multiNow = !!(metaNow && !metaNow.single)
      const segs = path.split('/').filter(Boolean)
      const current = currentProjectRef.current
      // Tree node paths are already vtop-prefixed in multi-root mode. A path
      // that already starts with a root name (e.g. 20260917-微服务/docs/...)
      // must be used AS-IS — prepending the current project again produced the
      // dead `20260917-微服务/20260917-微服务/docs/...` set.
      const alreadyPrefixed = multiNow && roots.includes(segs[0])
      const fullPaths = alreadyPrefixed
        ? [segs.join('/')]
        : multiNow
          ? (current ? [current] : roots).map((prefix) => `${prefix}/${segs.join('/')}`)
          : [segs.join('/')]
      const next = new Set(expandedRef.current)
      for (const full of fullPaths) {
        const parts = full.split('/')
        for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join('/'))
      }
      if (current && multiNow) next.add(current) // project-scoped tree root
      setExpanded(next)
      expandedRef.current = next
      saveTreeExpansion(current, next)
      for (const rel of next) {
        if (!dirsRef.current[rel]) loadDir(rel)
      }
      // 高亮目标也要用「树节点实际路径」：多根模式未带前缀时补当前项目。
      const locatePath = alreadyPrefixed || !multiNow ? path : current ? `${current}/${path}` : path
      setLocateTarget(locatePath)
      setTimeout(() => setLocateTarget(''), 2600)
    },
    [loadDir],
  )

  /* -------------------------------------------------------------- project */

  const switchProject = React.useCallback(
    (name) => {
      const next = name || null
      if (next === currentProjectRef.current) {
        setProjectsOpen(false)
        return
      }
      saveActiveScroll()
      saveWorkbench(currentProjectRef.current, workbenchRef.current)
      const restored = restoreWorkbench(next)
      let nextWorkbench
      if (restored) nextWorkbench = restored
      else {
        const task = newTaskRecord('默认')
        nextWorkbench = { tasks: [task], activeTaskId: task.id }
      }
      setProjectsOpen(false)
      setCurrentProject(next)
      currentProjectRef.current = next
      setProjectScope(next)
      saveProjectSelection(next)
      setWorkbench(nextWorkbench)
      workbenchRef.current = nextWorkbench
      const nextExpanded = new Set(
        loadTreeExpansion(next).map((rel) => collapseDoubledVtopPrefix(rel, metaRef.current)),
      )
      setExpanded(nextExpanded)
      expandedRef.current = nextExpanded
      // The cached listings of the new project make the tree render at once.
      const nextDirs = loadTreeDirs(next)
      setDirs(nextDirs)
      dirsRef.current = nextDirs
      setFailedDirs({})
      setLocateTarget('')
      setOverlay(null)
      setModalRequest(null)
    },
    [saveActiveScroll],
  )
  switchProjectRef.current = switchProject

  /** Close tabs belonging to a removed project (across every task). */
  const pruneProjectTabs = React.useCallback((name) => {
    if (!name) return
    const prefix = `${name}/`
    setWorkbench((prev) => {
      let changed = false
      const tasks = prev.tasks.map((task) => {
        if (!task.tabs.some((tab) => tab.path === name || tab.path.startsWith(prefix))) return task
        changed = true
        const nextTabs = task.tabs.filter((tab) => !(tab.path === name || tab.path.startsWith(prefix)))
        let activeId = task.activeId
        if (!nextTabs.some((tab) => tab.id === activeId)) activeId = nextTabs.length ? nextTabs[nextTabs.length - 1].id : null
        return { ...task, tabs: nextTabs, activeId }
      })
      return changed ? { ...prev, tasks } : prev
    })
  }, [])

  const changeRoots = React.useCallback(
    (action, pathValue) => {
      const previousRoots = (metaRef.current && metaRef.current.roots) || []
      const removed = action === 'remove' ? previousRoots.find((root) => root.path === pathValue) : null
      postJson('/api/roots', { action, path: pathValue })
        .then((payload) => {
          const roots = Array.isArray(payload.roots) ? payload.roots : []
          setMeta({ ok: true, roots, single: !!payload.single })
          setDirs({})
          dirsRef.current = {}
          setFailedDirs({})
          if (removed) {
            pruneProjectTabs(removed.name)
            const prefix = `${removed.name}/`
            const next = new Set([...expandedRef.current].filter((rel) => rel !== removed.name && !rel.startsWith(prefix)))
            setExpanded(next)
            expandedRef.current = next
            saveTreeExpansion(currentProjectRef.current, next)
          }
          const current = currentProjectRef.current
          if (current && !roots.some((root) => root.name === current)) {
            // 当前项目被移除（或根列表被整体重置）→ 回到「全部」
            if (switchProjectRef.current) switchProjectRef.current(null)
          }
        })
        .catch((err) => setError(String((err && err.message) || err)))
    },
    [pruneProjectTabs],
  )

  const refreshActive = React.useCallback(() => {
    const wb = workbenchRef.current
    const task = wb.tasks.find((item) => item.id === wb.activeTaskId)
    const tab = task && task.activeId ? task.tabs.find((item) => item.id === task.activeId) : null
    if (!tab || tab.kind === 'image') return
    patchTab(tab.id, { error: '' })
    loadTab(tab.id, tab.kind, tab.path)
  }, [patchTab, loadTab])

  /* -------------------------------------------------------------- effects */

  React.useEffect(() => {
    ensureVendor()
      .then(() => setVendorReady(true))
      .catch((err) => setError(String((err && err.message) || err)))
  }, [])

  React.useEffect(() => {
    if (!error) return undefined
    const timer = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(timer)
  }, [error])

  const closeModal = React.useCallback(() => setModalRequest(null), [])
  const closeSync = React.useCallback(() => setSyncOpen(false), [])
  const closeGit = React.useCallback(() => setGitOpen(false), [])

  React.useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      const tag = target && target.tagName ? String(target.tagName).toUpperCase() : ''
      const inField = tag === 'INPUT' || tag === 'TEXTAREA'
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOverlay('search')
        return
      }
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        // 文件内搜索（Ctrl+F）：浏览器自带的那个找不到插件面板里的内容。
        event.preventDefault()
        openFileSearch()
        return
      }
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setOverlay('files')
        return
      }
      if (event.altKey && !mod && !inField) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          goNav(-1)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          goNav(1)
        } else if (event.key.toLowerCase() === 'p') {
          event.preventDefault()
          setProjectsOpen((value) => !value)
        }
        return
      }
      if (event.key !== 'Escape') return
      // Esc 逐层关闭：代码弹窗 → 版本树 → 同步面板 → 项目管理 → 其它遮罩。
      const panels = panelsRef.current
      if (panels.modal) {
        // 代码弹窗自己也有 Esc 监听（定义候选列表打开时只关候选列表，并用
        // preventDefault 表明「已处理」）。App 的监听器注册更早、会先跑，所以
        // 延到微任务里再判断：弹窗已处理就什么都不做，否则由 App 关掉弹窗。
        const current = event
        Promise.resolve().then(() => {
          if (!current.defaultPrevented) closeModal()
        })
      } else if (panels.git) closeGit()
      else if (panels.sync) closeSync()
      else if (panels.projects) setProjectsOpen(false)
      else setOverlay((current) => (current ? null : current))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goNav, closeModal, closeSync, closeGit, openFileSearch])

  // 旧版本 locator 曾把「项目名/项目名/...」双前缀写进展开态持久化。多根模式下
  // 折叠一次并回写（只折叠「首两段相同且首段是真实项目名」的路径，单根模式不动）。
  React.useEffect(() => {
    if (!meta) return
    const previous = expandedRef.current
    const next = new Set()
    let changed = false
    for (const rel of previous) {
      const fixed = collapseDoubledVtopPrefix(rel, meta)
      if (fixed !== rel) changed = true
      if (fixed) next.add(fixed)
    }
    if (!changed) return
    setExpanded(next)
    expandedRef.current = next
    saveTreeExpansion(currentProjectRef.current, next)
  }, [meta, currentProject])

  // Panel switch unmounts/remounts Page: `dirs` starts empty while `expanded`
  // came from storage. Once meta (and the project-scoped root) is known, load
  // every expanded dir that has no data yet, not only the root.
  React.useEffect(() => {
    if (!meta) return
    const targets = new Set([rootKey])
    for (const rel of expandedRef.current) {
      const clean = collapseDoubledVtopPrefix(rel, meta)
      if (clean && !dirsRef.current[clean]) targets.add(clean)
    }
    for (const rel of targets) loadDir(rel)
  }, [meta, currentProject, rootKey, loadDir])

  // Persist the workbench of the current project, and the project selection /
  // search scope. Switching projects saves the old set explicitly first.
  React.useEffect(() => {
    saveWorkbench(currentProject, workbench)
  }, [currentProject, workbench])

  React.useEffect(() => {
    setProjectScope(currentProject)
    saveProjectSelection(currentProject)
  }, [currentProject])

  // Activation-time lazy load: md/code/html content is fetched when a tab
  // becomes active (image tabs need no text).
  React.useEffect(() => {
    if (!activeTab) return
    if (activeTab.kind === 'image' || activeTab.content != null || activeTab.error) return
    loadTab(activeTab.id, activeTab.kind, activeTab.path)
  }, [workbench.activeTaskId, activeTabKey, loadTab])

  React.useEffect(() => {
    const scroller = contentRef.current
    if (!scroller) return undefined
    const onScroll = () => {
      const wb = workbenchRef.current
      const task = wb.tasks.find((item) => item.id === wb.activeTaskId)
      const tab = task && task.activeId ? task.tabs.find((item) => item.id === task.activeId) : null
      if (!task || !tab || tab.kind !== 'md') return
      scrollStorage.set(mdScrollKey(task.id, tab.path), scroller.scrollTop)
      rememberTabScroll(tabScrollKey(task.id, tab.id), scroller.scrollTop)
    }
    const onBeforeUnload = () => {
      onScroll()
      saveWorkbenchNow()
      scrollStorage.flushNow()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [saveWorkbenchNow])

  /**
   * The reading position of a markdown tab, from wherever it is remembered.
   *
   * Two stores: the per-path map (written on every scroll) and the per-tab
   * memory (written when the tab is left and persisted with the workbench).
   * The per-tab one is the fallback for the case the user hit: after a trip to
   * the conversation the per-path map can be empty while the workbench still
   * knows where the tab was.
   */
  const scrollTargetFor = React.useCallback((taskId, tab) => {
    if (!tab || tab.kind !== 'md') return 0
    const byPath = scrollStorage.get(mdScrollKey(taskId, tab.path))
    const byTab =
      typeof recallTabScroll === 'function' && typeof tabScrollKey === 'function'
        ? recallTabScroll(tabScrollKey(taskId, tab.id))
        : 0
    return Math.max(byPath, byTab || 0)
  }, [])

  /**
   * Restore the reading position when the active TASK or TAB changes.
   *
   * The markdown view restores its own position when it MOUNTS - but the tab id
   * is `<kind>:<path>`, so the same document open in two tasks is the SAME key:
   * React reuses the view, nothing remounts, and the position of the task you
   * came back to was never applied ("切任务到别的任务，滚动位置就没了"). This
   * effect applies it explicitly, per task.
   */
  React.useEffect(() => {
    if (!activeTab || activeTab.kind !== 'md') return undefined
    const scroller = contentRef.current
    if (!scroller) return undefined
    const target = scrollTargetFor(workbench.activeTaskId, activeTab)
    if (target <= 0) return undefined
    const apply = () => {
      const el = contentRef.current
      if (el && Math.abs(el.scrollTop - target) > 2) el.scrollTop = target
    }
    apply()
    const timer = setTimeout(apply, 150)
    return () => clearTimeout(timer)
  }, [workbench.activeTaskId, activeTabKey, scrollTargetFor])

  /**
   * Save the reading position when the PANEL goes away.
   *
   * Switching to the conversation unmounts the plugin panel: the DOM (and the
   * scroll position in it) is gone, so the position has to be written out
   * before that happens - otherwise the tab comes back at the top.
   */
  React.useEffect(() => {
    return () => {
      saveActiveScroll()
      // The per-tab position also lives in the persisted workbench: save it
      // now, so the tab comes back where the user left it.
      saveWorkbenchNow()
      scrollStorage.flushNow()
    }
  }, [saveActiveScroll, saveWorkbenchNow])

  React.useEffect(() => {
    let cancelled = false
    fetchJson('/api/meta')
      .then((payload) => {
        if (cancelled) return
        setMeta(payload)
        const names = (payload.roots || []).map((root) => root.name)
        const project = currentProjectRef.current
        if (project && !names.includes(project) && switchProjectRef.current) switchProjectRef.current(null)
      })
      .catch((err) => {
        if (!cancelled) setError(String((err && err.message) || err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /* ------------------------------------------------------------- handlers */

  /**
   * Markdown link routing (attributes written by 10-markdown.js):
   *   data-path / data-kind / data-line / data-branch / data-commit.
   * code + plain click → modal; code + Ctrl/Cmd → tab; md/html/image → tab.
   * Resolved repository links keep their href: Shift+click / right-click stay
   * native so the remote repo page is still reachable.
   */
  const onContentClick = (event) => {
    const target = event.target
    const anchor = target && target.closest ? target.closest('a[data-path]') : null
    if (!anchor) return
    const rel = (anchor.dataset.path || '').trim()
    if (!rel) return
    if (event.shiftKey && anchor.hasAttribute('href')) return
    event.preventDefault()
    const kind = anchor.dataset.kind || kindForPath(rel)
    const line = anchor.dataset.line ? Number(anchor.dataset.line) : null
    const branch = anchor.dataset.branch || ''
    const commit = anchor.dataset.commit || ''
    const modifier = event.ctrlKey || event.metaKey
    if (kind === 'code') {
      if (modifier) openPath(rel, line, { branch, commit, jump: true })
      else setModalRequest({ path: rel, line: line == null ? null : line, branch, commit })
      return
    }
    openPath(rel, line, { branch, commit })
  }

  const projectLabel = currentProject || (meta && meta.roots.length > 1 ? '全部项目' : '项目')
  const projectsTitle = currentProject
    ? `当前项目 ${currentProject}（Alt+P 项目管理）`
    : meta && meta.roots.length > 1
      ? '全部项目（Alt+P 项目管理）'
      : '项目管理（Alt+P）'
  const treeLabel = currentProject
    ? currentProject
    : meta && meta.roots.length > 1
      ? `全部项目（${rootNames.length}）`
      : rootNames[0] || '项目'
  const treeTitle = meta ? meta.roots.map((root) => root.path).join('\n') : ''

  /**
   * The in-file search bar for ONE scope. Each scope renders its own element
   * from its own bucket, so the popup and the tabs are independent sessions
   * (opening the popup never borrows the tab's query, and closing it never
   * leaves the popup's query behind in the tab).
   */
  const fileSearchBarFor = (scope) => {
    const bucket = fsBuckets[scope]
    if (!bucket.open) return null
    return h(FileSearchWidget, {
      query: bucket.query,
      onQuery: (value) => patchFs(scope, { query: value }),
      count: bucket.info.count,
      index: bucket.info.index,
      status: bucket.info.status,
      options: bucket.options,
      onToggleOption: (key) => toggleFileSearchOptionIn(scope, key),
      onSearch: () => runFileSearchIn(scope, bucket.query),
      onNext: () => gotoFileSearchIn(scope, 1),
      onPrev: () => gotoFileSearchIn(scope, -1),
      onClose: () => closeFileSearchIn(scope),
      // 全局搜索面板 renders BELOW the popup, so it would be unreachable
      // from inside the modal: the button is only offered from the panel.
      onGlobal:
        scope === 'modal'
          ? null
          : () => {
              closeFileSearchIn(scope)
              setOverlay('search')
            },
    })
  }

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'mdr-topbar' },
      h('span', { className: 'mdr-brand' }, h(Icons.doc, { size: 16 }), 'Markdown Reader'),
      h(
        'button',
        {
          className: 'mdr-btn',
          disabled: nav.idx <= 0,
          title: '后退（Alt+←）',
          onClick: () => goNav(-1),
        },
        h(NavBackIcon, { size: 14 }),
      ),
      h(
        'button',
        {
          className: 'mdr-btn',
          disabled: nav.idx >= nav.stack.length - 1,
          title: '前进（Alt+→）',
          onClick: () => goNav(1),
        },
        h(NavFwdIcon, { size: 14 }),
      ),
      h('input', {
        className: 'mdr-path',
        value: pathInput,
        placeholder: '输入相对路径回车打开（如 docs/需求/x.md）',
        onChange: (event) => setPathInput(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          openPath(pathInput, null)
          setPathInput('')
        },
      }),
      h('span', { className: 'mdr-spacer' }),
      h(
        'button',
        {
          className: 'mdr-btn' + (projectsOpen ? ' on' : ''),
          onClick: () => setProjectsOpen((value) => !value),
          title: projectsTitle,
        },
        h(Icons.layers, { size: 14 }),
        projectLabel,
      ),
      h('button', { className: 'mdr-btn', onClick: () => setOverlay('json'), title: 'JSON 格式化工具' }, 'JSON'),
      h(
        'button',
        {
          className: 'mdr-btn' + (syncOpen ? ' on' : ''),
          onClick: () => {
            setSyncOpen(true)
            setGitOpen(false)
          },
          title: '检查更新',
        },
        h(Icons.refresh, { size: 14 }),
        '同步',
      ),
      h(
        'button',
        {
          className: 'mdr-btn' + (gitOpen ? ' on' : ''),
          onClick: () => {
            setGitOpen(true)
            setSyncOpen(false)
          },
          title: '版本树',
        },
        h(GitGraphIcon, { size: 14 }),
        'Git 图',
      ),
      h(
        'button',
        { className: 'mdr-btn', onClick: refreshActive, disabled: !activeTab, title: '重新读取当前文件' },
        h(Icons.refresh, { size: 14 }),
        '刷新',
      ),
    ),
    projectsOpen
      ? h(ProjectsPanel, {
          meta,
          current: currentProject,
          onSwitch: switchProject,
          onAdd: (value) => changeRoots('add', value),
          onRemove: (value) => changeRoots('remove', value),
          onClose: () => setProjectsOpen(false),
        })
      : null,
    h(WorkbenchBar, {
      tasks: workbench.tasks,
      activeTaskId: workbench.activeTaskId,
      onSwitch: switchTask,
      onNew: newTask,
      onRename: renameTask,
      onDelete: deleteTask,
      onReorder: reorderTasks,
    }),
    h(
      'div',
      { className: 'mdr-body' },
      h(
        'div',
        { className: 'mdr-tree' },
        h(
          'div',
          { className: 'mdr-tree-toolbar' },
          h('span', { className: 'mdr-tree-tip', title: treeTitle }, treeLabel),
          h('span', { className: 'mdr-spacer' }),
          h('button', { className: 'mdr-btn', onClick: refreshTree, title: '刷新目录树' }, h(Icons.refresh, { size: 13 })),
        ),
        h(Tree, {
          rootEntries: dirs[rootKey],
          rootPath: rootKey,
          expanded,
          dirs,
          failed: failedDirs,
          activePath: activeTab ? activeTab.path : '',
          locatedPath: locateTarget,
          onToggle: toggleDir,
          onOpen: (rel) => openPath(rel, null),
        }),
      ),
      h(
        'div',
        { className: 'mdr-right' },
        h(TabBar, {
          tabs,
          activeId,
          onActivate: activateTab,
          onClose: closeTab,
          onReorder: reorderTabs,
        }),
        h(
          'div',
          {
            className: 'mdr-content' + (activeTab && activeTab.kind === 'code' ? ' code' : ''),
            ref: contentRef,
            onClick: onContentClick,
          },
          activeTab == null
            ? h(EmptyState, { meta, currentProject })
            : activeTab.kind === 'md'
              ? vendorReady
                ? h(MarkdownView, { key: activeTab.id, tab: activeTab, multi, rootNames, taskId: workbench.activeTaskId })
                : h('div', { className: 'mdr-empty' }, '渲染库加载中…')
              : activeTab.kind === 'code'
                ? h(CodeView, {
                    key: activeTab.id,
                    tab: activeTab,
                    // The reading position belongs to the task (the tab id is
                    // shared between tasks).
                    taskId: workbench.activeTaskId,
                    // Definition jumps pass {kind:'code', branch, commit, defBar}
                    // so a .vue/.html target still opens as code and keeps the
                    // rendered git version + 「实现」 entry bar.
                    onOpen: (rel, line, opts) => openPath(rel, line, { ...(opts || {}), jump: true }),
                    onBack: () => goNav(-1),
                  })
                : activeTab.kind === 'html'
                  ? typeof HtmlTabView === 'function'
                    ? h(HtmlTabView, {
                        key: activeTab.id,
                        tab: activeTab,
                        onToggleMode: (mode) => patchTab(activeTab.id, { htmlMode: mode === 'source' ? 'source' : 'render' }),
                        onLocate: () => locateInTree(activeTab.path),
                      })
                    : h('div', { className: 'mdr-empty' }, 'HTML 视图未就绪')
                  : activeTab.kind === 'image'
                    ? typeof ImageView === 'function'
                      ? h(ImageView, {
                          key: activeTab.id,
                          tab: activeTab,
                          onLocate: () => locateInTree(activeTab.path),
                        })
                      : h('div', { className: 'mdr-empty' }, '图片视图未就绪')
                    : h('div', { className: 'mdr-empty' }, '不支持的文件类型'),
        ),
      ),
    ),
    // 文件内搜索条（Ctrl+F）：浮在内容区右上角，属于插件面板内部。
    // 代码弹窗打开时它被挂到弹窗卡片里（弹窗遮罩会盖住面板里的浮层）。
    !modalRequest ? fileSearchBarFor('tab') : null,
    error ? h('div', { className: 'mdr-err' }, error) : null,
    overlay === 'search'
      ? h(SearchPanel, { mode: 'search', onClose: () => setOverlay(null), onOpen: (rel, line) => openPath(rel, line, { jump: true }) })
      : null,
    overlay === 'files'
      ? h(SearchPanel, { mode: 'files', onClose: () => setOverlay(null), onOpen: (rel) => openPath(rel, null) })
      : null,
    overlay === 'json' ? h(JsonTool, { onClose: () => setOverlay(null) }) : null,
    // 代码弹窗（24-modal.js 分片实现；分片未落地前 typeof 守卫保证不炸）。
    typeof CodeModal === 'function' && modalRequest
      ? h(CodeModal, {
          request: modalRequest,
          onClose: closeModal,
          // 弹窗内部可能原地跳转过（返回栈），所以优先用弹窗回传的当前视图。
          onOpenTab: (target) => {
            const request = target && target.path ? target : modalRequest
            closeModal()
            if (request) openPath(request.path, request.line, { branch: request.branch, commit: request.commit, jump: true })
          },
          onOpen: (rel, line) => openPath(rel, line, { jump: true }),
          // File search while the popup is open: the bar lives in the card and
          // the popup's controller wins over the tab's (弹窗优先，其次标签页).
          // File search while the popup is open: the bar lives in the card and
          // the popup has its OWN session (弹窗内外搜索互相独立).
          searchBar: fileSearchBarFor('modal'),
          searchOpen: fsBuckets.modal.open,
          onCloseSearch: () => closeFileSearchIn('modal'),
        })
      : null,
    typeof SyncPanel === 'function' && syncOpen ? h(SyncPanel, { onClose: closeSync }) : null,
    typeof GitGraphModal === 'function' && gitOpen
      ? h(GitGraphModal, { path: activeTab ? activeTab.path : '', onClose: closeGit, onOpen: openPath })
      : null,
  )
}

function Page() {
  // The fence palette (hljs colours + the diff row colours) lives NEXT TO the
  // app stylesheet, inside the plugin's own root: a <style> in <head> only
  // reaches the document if the panel is rendered there, and the diff rows
  // must keep their colours wherever the harness mounts the panel.
  const fenceCss = typeof FENCE_CSS !== 'undefined' ? FENCE_CSS : ''
  const fileSearchCss = typeof FILE_SEARCH_CSS !== 'undefined' ? FILE_SEARCH_CSS : ''
  // The panel root is captured so overlays (context menu, toast) are mounted
  // INSIDE the panel: the Harness mounts it into its own DOM scope, and
  // anything appended to document.body loses the panel's stylesheet and lands
  // at the bottom of the Harness window.
  const rootRef = (element) => {
    if (typeof setPanelRoot === 'function') setPanelRoot(element)
  }
  const buildId = typeof BUILD_ID === 'undefined' ? '' : BUILD_ID
  return h(
    'div',
    { className: 'mdr-root', ref: rootRef },
    h('style', { dangerouslySetInnerHTML: { __html: APP_CSS } }),
    fenceCss ? h('style', { id: 'mdr-fence-css', dangerouslySetInnerHTML: { __html: fenceCss } }) : null,
    fileSearchCss
      ? h('style', { id: 'mdr-filesearch-css', dangerouslySetInnerHTML: { __html: fileSearchCss } })
      : null,
    buildId
      ? h(
          'div',
          {
            className: 'mdr-build',
            title:
              `Markdown Reader 客户端构建 ${buildId}。若这里显示的是旧构建号，说明窗口还在跑旧代码 —— 刷新窗口（Ctrl+R）即可。`,
          },
          `build ${buildId}`,
        )
      : null,
    h(App),
  )
}

function MarkdownReaderIcon(props) {
  const size = (props && props.size) || 20
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', { d: 'M6 3h8l4 4v14H6z' }),
    h('path', { d: 'M14 3v4h4' }),
    h('path', { d: 'M9 12h6' }),
    h('path', { d: 'M9 16h4' }),
  )
}

function registerSlots(ctx) {
  // Tell the Host which client build this browser loaded, and reload if the
  // Host serves a newer one (the Harness caches plugin clients immutably).
  try {
    syncClientBuild()
  } catch {
    /* ignore */
  }
  // Report the DOM scope the panel lives in, so "why does this overlay end up
  // at the bottom of the window" is answered by the app, not guessed.
  try {
    if (typeof cleanupStaleOverlays === 'function') cleanupStaleOverlays()
    if (typeof reportClientDom === 'function') reportClientDom()
    if (typeof startDomReport === 'function') startDomReport()
  } catch {
    /* ignore */
  }
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'markdown-reader', order: 20, label: 'Markdown Reader' },
      MarkdownReaderIcon,
    ),
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'markdown-reader' }, Page))
}
