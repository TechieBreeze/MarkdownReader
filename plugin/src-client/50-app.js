/** App shell, workspace-roots menu and the Harness slot registrations. */

function RootsMenu(props) {
  const { meta, onAdd, onRemove, onClose } = props
  const [value, setValue] = React.useState('')
  const roots = (meta && meta.roots) || []
  const submit = () => {
    const text = value.trim()
    if (!text) return
    onAdd(text)
    setValue('')
  }
  return h(
    'div',
    { className: 'mdr-roots' },
    h('div', { style: { display: 'flex', alignItems: 'center' } }, h('h3', { style: { flex: 1 } }, '工作区根'), h('span', { className: 'mdr-btn', onClick: onClose }, '✕')),
    roots.length === 0
      ? h('div', { className: 'mdr-tip' }, '还没有打开任何工作区，添加一个绝对路径。')
      : roots.map((root) =>
          h(
            'div',
            { className: 'mdr-root-row', key: root.path },
            h('span', { className: 'mdr-root-path', title: root.path }, root.path),
            h('button', { className: 'mdr-btn', onClick: () => onRemove(root.path) }, '移除'),
          ),
        ),
    h('input', {
      value,
      placeholder: '添加工作区绝对路径，回车确认',
      onChange: (event) => setValue(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter') submit()
      },
    }),
    h('div', { className: 'mdr-tip', style: { marginTop: 6 } }, '多个根时，路径以根目录名作前缀区分。'),
  )
}

function EmptyState(props) {
  const { meta } = props
  return h(
    'div',
    { className: 'mdr-empty' },
    h(Icons.doc, { size: 40 }),
    h('h2', null, 'Markdown Reader'),
    h('div', null, '左侧目录树选择文档，或在顶栏输入相对路径。'),
    h('div', { className: 'mdr-tip' }, meta && meta.roots.length ? `工作区：${meta.roots.map((root) => root.name).join(' · ')}` : '尚未打开工作区'),
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
  const [meta, setMeta] = React.useState(null)
  const [dirs, setDirs] = React.useState({})
  const [expanded, setExpanded] = React.useState(() => new Set(treeStorage.load()))
  const restoredRef = React.useRef(tabsStorage.load())
  const [tabs, setTabs] = React.useState(() =>
    restoredRef.current
      ? restoredRef.current.tabs.map((tab) => ({
          ...tab,
          content: null,
          lang: tab.kind === 'code' ? langForPath(tab.path) : '',
          error: '',
        }))
      : [],
  )
  const [activeId, setActiveId] = React.useState(() => (restoredRef.current ? restoredRef.current.activeId : null))
  const [error, setError] = React.useState('')
  const [pathInput, setPathInput] = React.useState('')
  const [rootsOpen, setRootsOpen] = React.useState(false)
  const [overlay, setOverlay] = React.useState(null)
  const [modalRequest, setModalRequest] = React.useState(null)
  const [syncOpen, setSyncOpen] = React.useState(false)
  const [gitOpen, setGitOpen] = React.useState(false)
  const [failedDirs, setFailedDirs] = React.useState({})
  const [vendorReady, setVendorReady] = React.useState(false)
  const loadedRef = React.useRef(new Set())
  const inflightDirsRef = React.useRef(new Set())
  const dirsRef = React.useRef(dirs)
  const expandedRef = React.useRef(expanded)
  const tabsRef = React.useRef(tabs)
  const panelsRef = React.useRef({ modal: false, sync: false, git: false, roots: false })
  dirsRef.current = dirs
  expandedRef.current = expanded
  tabsRef.current = tabs
  panelsRef.current = { modal: !!modalRequest, sync: syncOpen, git: gitOpen, roots: rootsOpen }

  // 稳定引用：子分片把这些回调放进 effect 依赖（如代码弹窗的 Esc 监听），
  // 每次渲染都换新函数会让它们反复解绑/重绑。
  const closeModal = React.useCallback(() => setModalRequest(null), [])
  const closeSync = React.useCallback(() => setSyncOpen(false), [])
  const closeGit = React.useCallback(() => setGitOpen(false), [])

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

  React.useEffect(() => {
    const onKeyDown = (event) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOverlay('search')
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setOverlay('files')
      } else if (event.key === 'Escape') {
        // Esc 逐层关闭：代码弹窗 → 版本树 → 同步面板 → 工作区菜单 → 其它遮罩。
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
        else if (panels.roots) setRootsOpen(false)
        else setOverlay((current) => (current ? null : current))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
        // 标记失败，目录树显示「加载失败，点刷新重试」而不是永远「加载中…」。
        setFailedDirs((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
        setError(String((err && err.message) || err))
      })
      .finally(() => {
        inflightDirsRef.current.delete(key)
      })
  }, [])

  React.useEffect(() => {
    let cancelled = false
    fetchJson('/api/meta')
      .then((payload) => {
        if (!cancelled) setMeta(payload)
      })
      .catch((err) => {
        if (!cancelled) setError(String((err && err.message) || err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 面板切换会让 Page 卸载重挂：`dirs` 从空开始，但 `expanded` 从 localStorage 恢复。
  // meta（含根列表）到位后，把「已展开但还没有数据」的目录按绝对相对路径逐个加载：
  // 不能只加载根 ''，否则恢复出来的展开目录会永远停在「加载中…」。
  // 依赖只看 meta：loadDir 内部会 setDirs，若把 dirs 放进依赖会反复触发加载。
  React.useEffect(() => {
    if (!meta) return
    const targets = new Set([''])
    for (const rel of expandedRef.current) {
      if (rel && !dirsRef.current[rel]) targets.add(rel)
    }
    for (const rel of targets) loadDir(rel)
  }, [meta, loadDir])

  const loadTab = React.useCallback((id, kind, rel) => {
    fetchJson(kind === 'md' ? '/api/markdown' : '/api/code', { path: rel })
      .then((payload) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === id ? { ...tab, content: payload.content, lang: payload.lang || tab.lang, error: '' } : tab,
          ),
        )
      })
      .catch((err) => {
        const message = String((err && err.message) || err)
        setError(message)
        setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, error: message } : tab)))
      })
  }, [])

  React.useEffect(() => {
    if (!activeId) return
    const tab = tabs.find((item) => item.id === activeId)
    if (!tab || tab.content != null || loadedRef.current.has(tab.id)) return
    loadedRef.current.add(tab.id)
    loadTab(tab.id, tab.kind, tab.path)
  }, [activeId, tabs, loadTab])

  React.useEffect(() => {
    tabsStorage.save(tabs, activeId)
  }, [tabs, activeId])

  const openPath = React.useCallback(
    (rel, line) => {
      const value = String(rel || '').trim()
      if (!value) return
      const kind = isMdFile(value) ? 'md' : isCodeFile(value) ? 'code' : ''
      if (!kind) {
        setError(`暂不支持的文件类型：${value}`)
        return
      }
      const id = `${kind}:${value}`
      const first = !loadedRef.current.has(id)
      if (first) loadedRef.current.add(id)
      setTabs((prev) => {
        if (prev.some((tab) => tab.id === id)) {
          return prev.map((tab) => (tab.id === id && line != null ? { ...tab, line } : tab))
        }
        return [...prev, { id, kind, path: value, content: null, lang: kind === 'code' ? langForPath(value) : '', line: line || 0, error: '' }]
      })
      setActiveId(id)
      if (first) loadTab(id, kind, value)
    },
    [loadTab],
  )

  const closeTab = React.useCallback(
    (id) => {
      loadedRef.current.delete(id)
      const closing = tabsRef.current.find((tab) => tab.id === id) || null
      setTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === id)
        const next = prev.filter((tab) => tab.id !== id)
        if (index >= 0) {
          setActiveId((current) => {
            if (current !== id) return current
            if (!next.length) return null
            return next[Math.min(index, next.length - 1)].id
          })
        }
        return next
      })
      // 关掉标签页后不要在弹窗里留一个指向已关闭文件（可能已被移除/改路径）的陈旧请求。
      if (closing) {
        setModalRequest((current) => (current && current.path === closing.path ? null : current))
      }
    },
    [],
  )

  const toggleDir = React.useCallback(
    (rel) => {
      const willOpen = !expanded.has(rel)
      const next = new Set(expanded)
      if (willOpen) next.add(rel)
      else next.delete(rel)
      setExpanded(next)
      treeStorage.save(next)
      if (willOpen && !dirs[rel]) loadDir(rel)
    },
    [expanded, dirs, loadDir],
  )

  const refreshTree = React.useCallback(() => {
    // 已展开的目录全部重载（含之前加载失败、`dirs` 里还没有的），再清掉已折叠目录的缓存。
    const paths = ['', ...[...expanded].filter((rel) => rel !== '')]
    paths.forEach((rel) => loadDir(rel))
    setFailedDirs((prev) => (Object.keys(prev).length ? {} : prev))
    setDirs((prev) => {
      const next = { ...prev }
      for (const rel of Object.keys(next)) {
        if (rel !== '' && !expanded.has(rel)) delete next[rel]
      }
      return next
    })
  }, [expanded, loadDir])

  const refreshActive = React.useCallback(() => {
    const tab = tabs.find((item) => item.id === activeId)
    if (tab) loadTab(tab.id, tab.kind, tab.path)
  }, [tabs, activeId, loadTab])

  const changeRoots = React.useCallback((action, pathValue) => {
    postJson('/api/roots', { action, path: pathValue })
      .then((payload) => {
        setMeta({ ok: true, roots: payload.roots, single: payload.single })
        setDirs({})
        setExpanded(new Set())
        setFailedDirs({})
        treeStorage.save(new Set())
        // 根列表变了 → meta 变化会触发上面的恢复 effect，由它统一加载根目录。
      })
      .catch((err) => setError(String((err && err.message) || err)))
  }, [])

  const activeTab = tabs.find((tab) => tab.id === activeId) || null
  const multi = !!(meta && !meta.single)
  const rootNames = React.useMemo(() => (meta ? meta.roots.map((root) => root.name) : []), [meta])

  const onContentClick = (event) => {
    const target = event.target
    const anchor = target && target.closest ? target.closest('a[data-path]') : null
    if (!anchor) return
    event.preventDefault()
    const rel = anchor.dataset.path
    if (!rel) return
    const line = anchor.dataset.line ? Number(anchor.dataset.line) : null
    // 文档里的代码链接：普通点击 → 代码弹窗；Ctrl/Cmd+点击 → 开为标签页。
    // 注意 isCodeFile 也包含 .md，所以 md 链接必须先按 isMdFile 放行，仍开标签页。
    // md 链接 / 树点击 / 快速打开 / 搜索仍由 openPath 开标签页。
    if (event.ctrlKey || event.metaKey || isMdFile(rel) || !isCodeFile(rel)) {
      openPath(rel, line)
      return
    }
    setModalRequest({ path: rel, line: line == null ? null : line })
  }

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'mdr-topbar' },
      h('span', { className: 'mdr-brand' }, h(Icons.doc, { size: 16 }), 'Markdown Reader'),
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
        { className: 'mdr-btn' + (rootsOpen ? ' on' : ''), onClick: () => setRootsOpen((value) => !value), title: '工作区根' },
        h(Icons.layers, { size: 14 }),
        '工作区',
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
      h('button', { className: 'mdr-btn', onClick: refreshActive, disabled: !activeTab, title: '重新读取当前文件' }, h(Icons.refresh, { size: 14 }), '刷新'),
    ),
    rootsOpen ? h(RootsMenu, { meta, onAdd: (value) => changeRoots('add', value), onRemove: (value) => changeRoots('remove', value), onClose: () => setRootsOpen(false) }) : null,
    h(
      'div',
      { className: 'mdr-body' },
      h(
        'div',
        { className: 'mdr-tree' },
        h(
          'div',
          { className: 'mdr-tree-toolbar' },
          h('span', { className: 'mdr-tree-tip', title: meta ? meta.roots.map((root) => root.path).join('\n') : '' }, meta ? meta.roots.map((root) => root.name).join(' · ') : '工作区'),
          h('span', { className: 'mdr-spacer' }),
          h('button', { className: 'mdr-btn', onClick: refreshTree, title: '刷新目录树' }, h(Icons.refresh, { size: 13 })),
        ),
        h(Tree, {
          rootEntries: dirs[''],
          expanded,
          dirs,
          failed: failedDirs,
          activePath: activeTab ? activeTab.path : '',
          onToggle: toggleDir,
          onOpen: (rel) => openPath(rel, null),
        }),
      ),
      h(
        'div',
        { className: 'mdr-right' },
        h(TabBar, { tabs, activeId, onActivate: setActiveId, onClose: closeTab }),
        h(
          'div',
          { className: 'mdr-content' + (activeTab && activeTab.kind === 'code' ? ' code' : ''), onClick: onContentClick },
          activeTab == null
            ? h(EmptyState, { meta })
            : activeTab.kind === 'md'
              ? vendorReady
                ? h(MarkdownView, { key: activeTab.id, tab: activeTab, multi, rootNames })
                : h('div', { className: 'mdr-empty' }, '渲染库加载中…')
              : h(CodeView, { key: activeTab.id, tab: activeTab, onOpen: openPath }),
        ),
      ),
    ),
    error ? h('div', { className: 'mdr-err' }, error) : null,
    overlay === 'search' ? h(SearchPanel, { mode: 'search', onClose: () => setOverlay(null), onOpen: openPath }) : null,
    overlay === 'files' ? h(SearchPanel, { mode: 'files', onClose: () => setOverlay(null), onOpen: openPath }) : null,
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
            if (request) openPath(request.path, request.line)
          },
          onOpen: openPath,
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
