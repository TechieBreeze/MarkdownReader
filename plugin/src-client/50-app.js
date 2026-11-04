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

function App() {
  const [meta, setMeta] = React.useState(null)
  const [dirs, setDirs] = React.useState({})
  const [expanded, setExpanded] = React.useState(() => new Set(treeStorage.load()))
  const [tabs, setTabs] = React.useState([])
  const [activeId, setActiveId] = React.useState(null)
  const [error, setError] = React.useState('')
  const [pathInput, setPathInput] = React.useState('')
  const [rootsOpen, setRootsOpen] = React.useState(false)
  const [overlay, setOverlay] = React.useState(null)
  const [vendorReady, setVendorReady] = React.useState(false)
  const loadedRef = React.useRef(new Set())

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
        setOverlay((current) => (current ? null : current))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const loadDir = React.useCallback((rel) => {
    return fetchJson('/api/list', { path: rel })
      .then((payload) => {
        setDirs((prev) => ({ ...prev, [rel]: payload.entries }))
      })
      .catch((err) => setError(String((err && err.message) || err)))
  }, [])

  React.useEffect(() => {
    fetchJson('/api/meta')
      .then((payload) => {
        setMeta(payload)
        loadDir('')
      })
      .catch((err) => setError(String((err && err.message) || err)))
  }, [loadDir])

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

  const closeTab = React.useCallback((id) => {
    loadedRef.current.delete(id)
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== id)
      setActiveId((current) => (current === id ? (next.length ? next[next.length - 1].id : null) : current))
      return next
    })
  }, [])

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
    const paths = ['', ...[...expanded].filter((rel) => dirs[rel])]
    paths.forEach((rel) => loadDir(rel))
    setDirs((prev) => {
      const next = { ...prev }
      for (const rel of Object.keys(next)) {
        if (!expanded.has(rel) && rel !== '') delete next[rel]
      }
      return next
    })
  }, [expanded, dirs, loadDir])

  const refreshActive = React.useCallback(() => {
    const tab = tabs.find((item) => item.id === activeId)
    if (tab) loadTab(tab.id, tab.kind, tab.path)
  }, [tabs, activeId, loadTab])

  const changeRoots = React.useCallback(
    (action, pathValue) => {
      postJson('/api/roots', { action, path: pathValue })
        .then((payload) => {
          setMeta({ ok: true, roots: payload.roots, single: payload.single })
          setDirs({})
          setExpanded(new Set())
          treeStorage.save(new Set())
          loadDir('')
        })
        .catch((err) => setError(String((err && err.message) || err)))
    },
    [loadDir],
  )

  const activeTab = tabs.find((tab) => tab.id === activeId) || null
  const multi = !!(meta && !meta.single)

  const onContentClick = (event) => {
    const target = event.target
    const anchor = target && target.closest ? target.closest('a[data-path]') : null
    if (!anchor) return
    event.preventDefault()
    openPath(anchor.dataset.path, anchor.dataset.line ? Number(anchor.dataset.line) : null)
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
      h('button', { className: 'mdr-btn', onClick: () => setOverlay('search'), title: '项目内搜索 (Ctrl+Shift+F)' }, h(Icons.search, { size: 14 })),
      h('button', { className: 'mdr-btn', onClick: () => setOverlay('files'), title: '快速打开 (Ctrl+P)' }, '打开'),
      h('button', { className: 'mdr-btn', onClick: () => setOverlay('json'), title: 'JSON 格式化工具' }, 'JSON'),
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
                ? h(MarkdownView, { key: activeTab.id, tab: activeTab, multi })
                : h('div', { className: 'mdr-empty' }, '渲染库加载中…')
              : h(CodeView, { key: activeTab.id, tab: activeTab }),
        ),
      ),
    ),
    error ? h('div', { className: 'mdr-err' }, error) : null,
    overlay === 'search' ? h(SearchPanel, { mode: 'search', onClose: () => setOverlay(null), onOpen: openPath }) : null,
    overlay === 'files' ? h(SearchPanel, { mode: 'files', onClose: () => setOverlay(null), onOpen: openPath }) : null,
    overlay === 'json' ? h(JsonTool, { onClose: () => setOverlay(null) }) : null,
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
