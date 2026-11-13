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
 *   - Ctrl/Cmd+click jumps straight to the ONE definition resolved by /api/def
 *     (no candidate list): same file → in-place line jump, another file →
 *     in-place navigation that keeps the ← 返回 stack (same branch/commit view),
 *     and an interface hit shows the 「实现: XxxImpl」entry bar;
 *   - Esc closes (listener while mounted), dark-mask click closes, card clicks do
 *     not.
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
.mdr-cmodal-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.mdr-cmodal-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center}
.mdr-cmodal-note{flex:0 0 auto;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:rgba(226,192,141,.08);color:#e2c08d;font-size:12px;white-space:pre-wrap;word-break:break-all}
.mdr-cmodal-defbar{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:4px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.mdr-cmodal-defbar .mdr-cmodal-btn{color:var(--dsw-alias-brand-primary)}
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
  const { request, onClose, onOpenTab, onOpen, searchBar, searchOpen, onCloseSearch } = props
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
  const [defBar, setDefBar] = React.useState(null)
  const cardRef = React.useRef(null)
  const seqRef = React.useRef(0)
  const handledReqRef = React.useRef('')
  const pendingGitRef = React.useRef('')
  const pendingNavViewRef = React.useRef(null)
  const currentGitRef = React.useRef(null)
  const currentRef = React.useRef({ path: requestPath, line: requestLine })
  const maskDownRef = React.useRef(false)

  const loadFile = React.useCallback((path, line, gitView) => {
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
    const applyViewFile = (content, realPath) => {
      setView({
        path: realPath,
        line: targetLine,
        content: String(content == null ? '' : content),
        lang: langForPath(realPath) || langForPath(path),
        lineCount: 0,
        loading: false,
        error: '',
      })
    }
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
        // Jump targets can exist only in the branch/commit version (workspace
        // file removed/renamed): fall back to the git view file like the original
        // fetchJumpFiles did.
        const rev = gitView && (gitView.commit || gitView.branch)
        if (!rev) {
          const message = String((err && err.message) || err)
          setView({ path, line: targetLine, content: null, lang: langForPath(path), lineCount: 0, loading: false, error: message })
          return
        }
        fetchJson('/api/git/file', { path, commit: rev })
          .then((payload) => {
            if (seqRef.current !== seq) return
            applyViewFile(payload && payload.content, path)
          })
          .catch(() => {
            if (seqRef.current !== seq) return
            const message = String((err && err.message) || err)
            setView({ path, line: targetLine, content: null, lang: langForPath(path), lineCount: 0, loading: false, error: message })
          })
      })
  }, [])

  // Initial load + a new request that arrives while the modal is already open.
  React.useEffect(() => {
    if (handledReqRef.current === reqKey) return
    handledReqRef.current = reqKey
    setHistory([])
    setRestoreScroll(null)
    setNote('')
    setDefBar(null)
    pendingGitRef.current = ''
    // The git-adapted request view is applied once, when THIS request's file
    // text is in. In-place Ctrl+click navigation later must not re-apply it.
    pendingGitRef.current = requestBranch || requestCommit ? reqKey : ''
    loadFile(
      requestPath,
      requestLine,
      requestBranch || requestCommit ? { branch: requestBranch || '', commit: requestCommit || '' } : null,
    )
  }, [reqKey, requestPath, requestLine, requestBranch, requestCommit, loadFile])

  if (view) currentRef.current = { path: view.path, line: view.line }

  const navigateInPlace = React.useCallback(
    (path, line, gitView) => {
      const nextPath = String(path || '').replace(/\\/g, '/')
      const nextLine = Math.max(0, Number(line) || 0)
      if (!nextPath) return
      const current = currentRef.current
      if (nextPath === current.path && nextLine === current.line) return
      const snapshot = {
        path: current.path,
        line: current.line,
        scrollTop: readModalScroll(cardRef.current),
        // Remember which git version this position was showing: ← 返回 must restore
        // it too (and the file may only exist in that version).
        view: currentGitRef.current,
      }
      setHistory((prev) => [...prev, snapshot])
      setRestoreScroll(null)
      setNote('')
      // A cross-file jump inside a branch/commit view keeps that version for the
      // target file too (the original's modalOpenPath passes src.view).
      pendingNavViewRef.current =
        nextPath === current.path ? null : { path: nextPath, view: gitView || null }
      if (nextPath === current.path) {
        // Same file, another line: no refetch, just move the jump target.
        setView((prev) => (prev ? { ...prev, line: nextLine } : prev))
        return
      }
      loadFile(nextPath, nextLine, gitView)
    },
    [loadFile],
  )

  const goBack = React.useCallback(() => {
    if (!history.length) return
    const snapshot = history[history.length - 1]
    setHistory(history.slice(0, -1))
    setDefBar(null)
    setNote('')
    setRestoreScroll({ top: snapshot.scrollTop })
    if (snapshot.path === currentRef.current.path) {
      setView((prev) => (prev ? { ...prev, line: snapshot.line } : prev))
      return
    }
    // Restore the previous file with its git version too (may only exist there).
    pendingNavViewRef.current = snapshot.view ? { path: snapshot.path, view: snapshot.view } : null
    loadFile(snapshot.path, snapshot.line, snapshot.view)
  }, [history, loadFile])

  // Ctrl/Cmd+click inside the modal jumps straight to the resolved definition and
  // navigates IN PLACE (the ← 返回 stack keeps the previous position).
  const displayPath = view ? view.path : requestPath
  const displayContent = view && view.content != null ? view.content : null
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
  const workspaceContent = view && view.content != null ? view.content : ''
  const { rows, diffMode } = useCodeRows(gitView, workspaceContent)
  // Text + git version carried by a jump request: exactly what this modal renders
  // (commit version while viewing a commit's diff, branch version in a branch view,
  // workspace content otherwise).
  const defText =
    diffMode && Array.isArray(gitView.fileLines)
      ? gitView.fileLines.join('\n')
      : gitView.branchContent != null
        ? String(gitView.branchContent)
        : workspaceContent
  const defView =
    gitView.commit && diffMode
      ? { commit: gitView.commit }
      : gitView.branchContent != null
        ? { branch: gitView.branch }
        : null
  currentGitRef.current = defView
  const defSourceRef = React.useRef({})
  defSourceRef.current = {
    path: displayPath || '',
    text: defText,
    branch: defView && defView.branch ? defView.branch : '',
    commit: defView && defView.commit ? defView.commit : '',
    line: view ? view.line : 0,
  }
  React.useEffect(() => {
    const root = cardRef.current
    if (!root || !displayPath || displayContent == null) return undefined
    return setupDefinitionClick(
      root,
      () => defSourceRef.current,
      (result, source) => {
        const target = String(result.file || '').replace(/\\/g, '/')
        if (!target) return
        const line = Math.max(0, Number(result.line) || 0)
        const nextView = source.commit ? { commit: source.commit } : source.branch ? { branch: source.branch } : null
        // Interface hit → 「实现: XxxImpl」entry bar inside the popup.
        setDefBar(
          result.impl && result.impl.file
            ? {
                impl: { file: String(result.impl.file), line: Math.max(0, Number(result.impl.line) || 0) },
                label: String(result.impl.file).split('/').pop().replace(/\.java$/, '') || String(result.impl.file),
                view: nextView,
              }
            : null,
        )
        navigateInPlace(target, line, nextView)
      },
    )
  }, [displayPath, displayContent, navigateInPlace])

  // Apply the source view's branch/commit to a file reached by an in-place jump
  // (once its text is loaded). Keeps 「弹窗内跳转」 consistent with the original.
  React.useEffect(() => {
    const pending = pendingNavViewRef.current
    if (!pending || !view || view.loading || view.content == null) return
    if (String(view.path) !== pending.path) return
    pendingNavViewRef.current = null
    const target = pending.view
    if (target && (target.branch || target.commit)) gitActions.applyTarget(target.branch || null, target.commit || null)
  }, [view, gitActions])

  // Esc closes the modal — but the in-file search bar is a LAYER on top of it
  // (the standalone reader's rule: Esc closes the search first). The bar lives
  // inside the card now, so its own Escape must not take the whole popup down.
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (searchOpen && typeof onCloseSearch === 'function') {
        onCloseSearch()
        return
      }
      if (typeof onClose === 'function') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, searchOpen, onCloseSearch])

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
        // In-file search (Ctrl+F) while the popup is open: the modal registers
        // its own controller and the App prefers it over the tab behind it.
        searchKey: typeof MODAL_SEARCH_KEY === 'string' ? MODAL_SEARCH_KEY : '@modal',
      }),
      // The bar is rendered INSIDE the card so it is never covered by the mask
      // (the standalone reader re-positioned its widget into the modal).
      searchBar || null,
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
      defBar
        ? h(
            'div',
            { className: 'mdr-cmodal-defbar' },
            h('span', null, '实现:'),
            h(
              'button',
              {
                type: 'button',
                className: 'mdr-cmodal-btn',
                title: `跳转到实现：${defBar.impl.file}:${defBar.impl.line}`,
                onClick: () => navigateInPlace(defBar.impl.file, defBar.impl.line, defBar.view),
              },
              defBar.label,
            ),
          )
        : null,
      showInfo ? h(CodeGitInfo, { view: gitView }) : null,
      note ? h('div', { className: 'mdr-cmodal-note' }, note) : null,
      body,
      h('style', { dangerouslySetInnerHTML: { __html: GIT_CSS + CMODAL_CSS } }),
    ),
  )
}

function CodeModal(props) {
  const { request } = props || {}
  if (!request || !request.path) return null
  return h(CodeModalInner, props)
}
