/**
 * Code modal (弹窗) — the standalone reader's code popup, rebuilt for the plugin.
 *
 * Contract (wired by 50-app.js):
 *   h(CodeModal, {
 *     request,          // null | { path, line, branch?, commit? } — code file to show
 *     onClose,          // close the modal
 *     onOpenTab,        // (target) => void — open the current file+line+git view as a tab
 *     onOpen,           // open another file (Ctrl+click navigation) in a tab
 *   })
 *
 * Behaviour (ported from input/reference/index.html #modal-mask):
 *   - renders the file with the shared CodeBody (same line numbers/hljs colors as
 *     the code tab) and jumps to request.line with a PERSISTENT .mdr-cl.hit
 *     (no fade timer; moves on another jump, gone when the modal closes);
 *   - header has the path, the git bar (branch/commit view, shared useGitView but
 *     with its own view key) and the ← 返回 / 开成标签页 / ✕ buttons;
 *   - request.branch / request.commit (git-adapted link): that branch/commit view
 *     is applied inside the modal and 开成标签页 carries it to the new tab;
 *   - Ctrl/Cmd+click navigates IN PLACE with a back stack (single candidate auto
 *     navigates, several reuse DefinitionChooser, none keeps the view + a note);
 *   - Esc closes (listener while mounted), dark-mask click closes, card clicks do
 *     not; Esc with the definition chooser open closes only the chooser.
 */

const CMODAL_CSS = `
.mdr-cmodal-mask{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:12px}
.mdr-cmodal{position:relative;display:flex;flex-direction:column;width:min(1400px,96%);height:min(88vh,860px);max-height:100%;min-height:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 60px rgba(0,0,0,.5)}
.mdr-cmodal.mdr-code{height:min(88vh,860px)}
.mdr-cmodal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:4px;flex:0 0 auto;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.mdr-cmodal-path{flex:0 1 auto;min-width:70px;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:12.5px;color:#79c0ff}
.mdr-cmodal-badge{flex:0 0 auto;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.mdr-cmodal-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.mdr-cmodal-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mdr-cmodal-body{flex:1;min-height:0;display:flex;flex-direction:column}
.mdr-cmodal-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center}
.mdr-cmodal-note{flex:0 0 auto;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:rgba(226,192,141,.08);color:#e2c08d;font-size:12px;white-space:pre-wrap;word-break:break-all}
`

/** Read the current scroll offset of the modal's code viewport (for the back stack). */
function readModalScroll(card) {
  const body = card && card.querySelector ? card.querySelector('.mdr-code-body') : null
  return body ? body.scrollTop : 0
}

/**
 * Inner modal: mounted only while a request exists (the outer CodeModal returns
 * null otherwise), so every mount is a fresh session with an empty back stack.
 */
function CodeModalInner(props) {
  const { request, onClose, onOpenTab, onOpen } = props
  const requestPath = String((request && request.path) || '')
  const requestLine = Math.max(0, Number(request && request.line) || 0)
  // Git-adapted link: the modal applies the requested branch/commit view inside
  // the popup (its own git view key, so the tab underneath is untouched).
  const requestBranch = String((request && request.branch) || '')
  const requestCommit = String((request && request.commit) || '')
  const reqKey = `${requestPath}\u0000${requestLine}\u0000${requestBranch}\u0000${requestCommit}`

  const [view, setView] = React.useState(() => ({
    path: requestPath,
    line: requestLine,
    content: null,
    lang: langForPath(requestPath),
    lineCount: 0,
    loading: true,
    error: '',
  }))
  const [history, setHistory] = React.useState([])
  const [restoreScroll, setRestoreScroll] = React.useState(null)
  const [note, setNote] = React.useState('')
  const [chooser, setChooser] = React.useState(null)
  const cardRef = React.useRef(null)
  const seqRef = React.useRef(0)
  const handledReqRef = React.useRef('')
  const pendingGitRef = React.useRef('')
  const currentRef = React.useRef({ path: requestPath, line: requestLine })
  const chooserRef = React.useRef(null)
  chooserRef.current = chooser
  const maskDownRef = React.useRef(false)

  const loadFile = React.useCallback((path, line) => {
    const seq = (seqRef.current += 1)
    const targetLine = Math.max(0, Number(line) || 0)
    setView({
      path,
      line: targetLine,
      content: null,
      lang: langForPath(path),
      lineCount: 0,
      loading: true,
      error: '',
    })
    fetchJson('/api/code', { path })
      .then((payload) => {
        if (seqRef.current !== seq) return
        const realPath = payload && payload.path ? String(payload.path) : path
        setView({
          path: realPath,
          line: targetLine,
          content: String(payload && payload.content != null ? payload.content : ''),
          lang: langForPath(realPath) || (payload && payload.lang) || langForPath(path),
          lineCount: Number(payload && payload.lineCount) || 0,
          loading: false,
          error: '',
        })
      })
      .catch((err) => {
        if (seqRef.current !== seq) return
        const message = String((err && err.message) || err)
        setView({ path, line: targetLine, content: null, lang: langForPath(path), lineCount: 0, loading: false, error: message })
      })
  }, [])

  // Initial load + a new request that arrives while the modal is already open.
  React.useEffect(() => {
    if (handledReqRef.current === reqKey) return
    handledReqRef.current = reqKey
    setHistory([])
    setRestoreScroll(null)
    setNote('')
    setChooser(null)
    // The git-adapted request view is applied once, when THIS request's file
    // text is in. In-place Ctrl+click navigation later must not re-apply it.
    pendingGitRef.current = requestBranch || requestCommit ? reqKey : ''
    loadFile(requestPath, requestLine)
  }, [reqKey, requestPath, requestLine, requestBranch, requestCommit, loadFile])

  if (view) currentRef.current = { path: view.path, line: view.line }

  const navigateInPlace = React.useCallback(
    (path, line) => {
      const nextPath = String(path || '')
      const nextLine = Math.max(0, Number(line) || 0)
      if (!nextPath) return
      const current = currentRef.current
      if (nextPath === current.path && nextLine === current.line) return
      const snapshot = { path: current.path, line: current.line, scrollTop: readModalScroll(cardRef.current) }
      setHistory((prev) => [...prev, snapshot])
      setRestoreScroll(null)
      setNote('')
      setChooser(null)
      if (nextPath === current.path) {
        // Same file, another line: no refetch, just move the jump target.
        setView((prev) => (prev ? { ...prev, line: nextLine } : prev))
        return
      }
      loadFile(nextPath, nextLine)
    },
    [loadFile],
  )

  const goBack = React.useCallback(() => {
    if (!history.length) return
    const snapshot = history[history.length - 1]
    setHistory(history.slice(0, -1))
    setChooser(null)
    setNote('')
    setRestoreScroll({ top: snapshot.scrollTop })
    if (snapshot.path === currentRef.current.path) {
      setView((prev) => (prev ? { ...prev, line: snapshot.line } : prev))
      return
    }
    loadFile(snapshot.path, snapshot.line)
  }, [history, loadFile])

  // Ctrl/Cmd+click inside the modal navigates in place instead of opening a tab.
  const displayPath = view ? view.path : requestPath
  const displayContent = view && view.content != null ? view.content : null
  React.useEffect(() => {
    const root = cardRef.current
    if (!root || !displayPath || displayContent == null) return undefined
    const tab = { id: 'modal:' + displayPath, kind: 'code', path: displayPath, content: displayContent }
    const dispose = setupDefinitionClick(root, tab, (candidates, symbol, error) => {
      if (!candidates || !candidates.length) {
        setNote(error ? `未找到定义：${symbol} · ${error}` : `未找到定义：${symbol}`)
        return
      }
      if (candidates.length === 1) {
        const only = candidates[0]
        const current = currentRef.current
        if (only && only.path === current.path && (Number(only.line) || 0) === current.line) {
          setNote(`已在当前位置：${symbol}`)
          return
        }
        navigateInPlace(only.path, only.line)
        return
      }
      setChooser({ symbol, candidates, error: '' })
    })
    return dispose
  }, [displayPath, displayContent, navigateInPlace])

  // Esc closes the modal; with the definition chooser open it closes the chooser
  // only (stop immediate propagation keeps the App's global Esc handler out).
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (chooserRef.current) {
        setChooser(null)
        return
      }
      if (typeof onClose === 'function') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const gitTab = React.useMemo(
    () => ({
      id: 'modal:' + displayPath,
      kind: 'code',
      path: displayPath,
      content: displayContent,
      // The modal keeps its own branch/commit view: it must not mutate the
      // selection of the code tab showing the same file underneath.
      gitKey: 'modal:' + displayPath,
    }),
    [displayPath, displayContent],
  )
  const { view: gitView, actions: gitActions } = useGitView(gitTab)

  // Apply the git-adapted request view (branch/commit) once the file text is in.
  // In-place Ctrl+click navigation loads another file: the opener's branch/commit
  // is deliberately NOT carried over (matches the original's in-place navigation).
  React.useEffect(() => {
    if (!requestBranch && !requestCommit) return
    if (pendingGitRef.current !== reqKey) return
    if (!view || view.loading || view.content == null) return
    pendingGitRef.current = ''
    gitActions.applyTarget(requestBranch || null, requestCommit || null)
  }, [reqKey, requestBranch, requestCommit, view, gitActions])

  const workspaceContent = view && view.content != null ? view.content : ''
  const { rows, diffMode } = useCodeRows(gitView, workspaceContent)
  const lang = (view && view.lang) || langForPath(displayPath)
  const viewKey = `modal|${displayPath}|${gitView.branch}|${gitView.commit || ''}|${diffMode ? 'diff' : 'base'}|${
    gitView.branchContent == null ? 'ws' : 'branch'
  }`
  const showInfo = !!gitView.commit || !!gitView.hint || !!gitView.loading
  const openAsTab = () => {
    if (!view || !view.path) return
    if (typeof onOpenTab === 'function') {
      // Carry the branch/commit view that is actually rendered so the new tab
      // shows the same version of the file.
      const target = { path: view.path, line: view.line }
      if (gitView.git) {
        if (gitView.commit) target.commit = gitView.commit
        if (gitView.branchContent != null) target.branch = gitView.branch
      }
      onOpenTab(target)
    }
    if (typeof onClose === 'function') onClose()
  }
  const openFallbackTab = () => {
    if (!view || typeof onOpen !== 'function') return
    onOpen(view.path, view.line)
    if (typeof onClose === 'function') onClose()
  }

  const headChildren = [
    h(Icons.code, { key: 'icon', size: 14 }),
    h('span', { key: 'path', className: 'mdr-cmodal-path', title: displayPath }, displayPath),
    view && view.line > 0
      ? h('span', { key: 'line', className: 'mdr-cmodal-badge' }, `跳转行 ${view.line}`)
      : null,
    view && view.lineCount > 0 ? h('span', { key: 'size', className: 'mdr-cmodal-badge' }, `${view.lineCount} 行`) : null,
    gitView.git ? h(GitBar, { key: 'git', view: gitView, actions: gitActions }) : null,
    h('span', { key: 'spacer', className: 'mdr-spacer' }),
    history.length
      ? h(
          'button',
          { key: 'back', type: 'button', className: 'mdr-cmodal-btn', title: '返回上一次跳转位置', onClick: goBack },
          '← 返回',
        )
      : null,
    h(
      'button',
      { key: 'tab', type: 'button', className: 'mdr-cmodal-btn', title: '把这一个文件按当前行开成标签页', onClick: openAsTab },
      '开成标签页',
    ),
    h('button', { key: 'close', type: 'button', className: 'mdr-cmodal-btn', title: '关闭 (Esc)', onClick: onClose }, '✕'),
  ]

  let body = null
  if (view && view.loading) {
    body = h('div', { className: 'mdr-cmodal-state' }, '加载中…')
  } else if (!view || view.error) {
    body = h(
      'div',
      { className: 'mdr-cmodal-state' },
      h('div', { className: 'mdr-cmodal-note', style: { border: 'none', background: 'transparent', padding: 0 } }, `打开失败：${(view && view.error) || '未知错误'}`),
      h('button', { type: 'button', className: 'mdr-cmodal-btn', onClick: openFallbackTab }, '在标签页打开'),
    )
  } else {
    body = h(
      'div',
      { className: 'mdr-cmodal-body' },
      h(CodeBody, {
        rows,
        lang,
        diffMode,
        targetLine: view.line || 0,
        viewKey,
        restoreScroll,
        jumpHover: isJavaKtLang(lang),
      }),
    )
  }

  return h(
    'div',
    {
      className: 'mdr-cmodal-mask',
      onMouseDown: (event) => {
        maskDownRef.current = event.target === event.currentTarget
      },
      onClick: (event) => {
        if (event.target !== event.currentTarget) return
        if (!maskDownRef.current) return
        if (typeof onClose === 'function') onClose()
      },
    },
    h(
      'div',
      {
        className: 'mdr-cmodal mdr-code',
        ref: cardRef,
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { className: 'mdr-cmodal-head' }, headChildren),
      showInfo ? h(CodeGitInfo, { view: gitView }) : null,
      note ? h('div', { className: 'mdr-cmodal-note' }, note) : null,
      body,
      chooser
        ? h(DefinitionChooser, {
            state: chooser,
            onPick: (candidate) => navigateInPlace(candidate.path, candidate.line),
            onClose: () => setChooser(null),
          })
        : null,
      h('style', { dangerouslySetInnerHTML: { __html: GIT_CSS + CMODAL_CSS } }),
    ),
  )
}

function CodeModal(props) {
  const { request } = props || {}
  if (!request || !request.path) return null
  return h(CodeModalInner, props)
}
