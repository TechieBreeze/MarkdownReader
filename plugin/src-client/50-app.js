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
  const [dirs, setDirs] = React.useState({})
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

  /** Save the active markdown tab scroll NOW, before the DOM switches away. */
  const saveActiveScroll = React.useCallback(() => {
    const scroller = contentRef.current
    if (!scroller) return
    const wb = workbenchRef.current
    const task = wb.tasks.find((item) => item.id === wb.activeTaskId)
    const tab = task && task.activeId ? task.tabs.find((item) => item.id === task.activeId) : null
    if (!tab || tab.kind !== 'md') return
    scrollStorage.set(`md:${tab.path}`, scroller.scrollTop)
    rememberTabScroll(tab.id, scroller.scrollTop)
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
    const kind = kindForPath(entry.path)
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
              scroll: recallTabScroll(id),
            },
          ])
        }
        return { ...task, tabs, activeId: id }
      })
      return { ...prev, tasks, activeTaskId: targetTask.id }
    })
    if (kind === 'md') {
      const top = recallTabScroll(id)
      if (top > 0) {
        scrollStorage.set(`md:${entry.path}`, top)
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
    const key = String(rel == null ? '' : rel)
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
        setDirs((prev) => ({ ...prev, [key]: entries }))
      })
      .catch((err) => {
        setFailedDirs((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
        setError(String((err && err.message) || err))
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
          setError(message)
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
      const kind = kindForPath(value)
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
      pushNav({
        path: value,
        line: targetLine,
        branch: options.branch || '',
        commit: options.commit || '',
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
      const path = String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
      if (!path) return
      const metaNow = metaRef.current
      const roots = metaNow ? metaNow.roots.map((root) => root.name) : []
      const multiNow = !!(metaNow && !metaNow.single)
      const segs = path.split('/').filter(Boolean)
      const current = currentProjectRef.current
      const root = current && multiNow ? current : ''
      const prefixes = multiNow
        ? roots.includes(segs[0])
          ? [segs[0]]
          : current
            ? [current]
            : roots
        : ['']
      const next = new Set(expandedRef.current)
      if (root) next.add(root)
      for (const prefix of prefixes) {
        const full = prefix ? `${prefix}/${segs.join('/')}` : segs.join('/')
        const parts = full.split('/')
        for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join('/'))
      }
      setExpanded(next)
      expandedRef.current = next
      saveTreeExpansion(current, next)
      for (const rel of next) {
        if (!dirsRef.current[rel]) loadDir(rel)
      }
      setLocateTarget(path)
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
      const nextExpanded = new Set(loadTreeExpansion(next))
      setExpanded(nextExpanded)
      expandedRef.current = nextExpanded
      setDirs({})
      dirsRef.current = {}
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
  }, [goNav, closeModal, closeSync, closeGit])

  // Panel switch unmounts/remounts Page: `dirs` starts empty while `expanded`
  // came from storage. Once meta (and the project-scoped root) is known, load
  // every expanded dir that has no data yet, not only the root.
  React.useEffect(() => {
    if (!meta) return
    const targets = new Set([rootKey])
    for (const rel of expandedRef.current) {
      if (rel && !dirsRef.current[rel]) targets.add(rel)
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
      if (!tab || tab.kind !== 'md') return
      scrollStorage.set(`md:${tab.path}`, scroller.scrollTop)
      rememberTabScroll(tab.id, scroller.scrollTop)
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
        h(TabBar, { tabs, activeId, onActivate: activateTab, onClose: closeTab }),
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
                ? h(MarkdownView, { key: activeTab.id, tab: activeTab, multi, rootNames })
                : h('div', { className: 'mdr-empty' }, '渲染库加载中…')
              : activeTab.kind === 'code'
                ? h(CodeView, {
                    key: activeTab.id,
                    tab: activeTab,
                    onOpen: (rel, line) => openPath(rel, line, { jump: true }),
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
        })
      : null,
    typeof SyncPanel === 'function' && syncOpen ? h(SyncPanel, { onClose: closeSync }) : null,
    typeof GitGraphModal === 'function' && gitOpen
      ? h(GitGraphModal, { path: activeTab ? activeTab.path : '', onClose: closeGit, onOpen: openPath })
      : null,
  )
}

function Page() {
  return h('div', { className: 'mdr-root' }, h('style', { dangerouslySetInnerHTML: { __html: APP_CSS } }), h(App))
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
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'markdown-reader', order: 20, label: 'Markdown Reader' },
      MarkdownReaderIcon,
    ),
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'markdown-reader' }, Page))
}
