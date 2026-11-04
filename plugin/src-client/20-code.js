/** Code tab: VSCode-Dark+-style line-numbered viewer with hljs colors. */

const LANG_MAP = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'xml',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.properties': 'ini',
  '.toml': 'ini',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bat': 'dos',
  '.ps1': 'powershell',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.gradle': 'groovy',
  '.md': 'markdown',
}

function langForPath(rel) {
  return LANG_MAP[extOf(rel)] || ''
}

function highlightLineHtml(text, lang) {
  try {
    const value = window.hljs.highlight(text, { language: lang || 'plaintext', ignoreIllegals: true }).value
    return value === '' ? ' ' : value
  } catch {
    return escapeHtml(text) || ' '
  }
}

/** One row's HTML. diffMode adds the +/-/space gutter sign and diff row classes. */
function gitRowHtml(row, index, lang, diffMode, hitLine, codeHtml, top) {
  const classes = ['mdr-cl']
  if (row.kind === 'add') classes.push('mdr-git-add')
  else if (row.kind === 'del') classes.push('mdr-git-del')
  if (hitLine && row.no === hitLine) classes.push('hit')
  const sign = diffMode ? (row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  ') : ''
  const style = top == null ? '' : ` style="top:${top}px"`
  const no = row.no == null ? '' : row.no
  return `<div class="${classes.join(' ')}" data-line="${no}"${style}><span class="mdr-cl-no">${no}</span><span class="mdr-cl-code">${sign}${codeHtml}</span></div>`
}

/**
 * Rows viewport. Files over GIT_V_THRESHOLD rows keep full highlighting but only
 * paint the viewport +/- GIT_BUFFER rows (20px absolute rows inside a spacer).
 */
function CodeBody(props) {
  const { rows, lang, diffMode, targetLine, viewKey } = props
  const total = rows.length
  const virtual = total > GIT_V_THRESHOLD
  const scrollerRef = React.useRef(null)
  const [win, setWin] = React.useState(() => ({ first: 0, last: Math.min(total, 160) }))
  const [hitLine, setHitLine] = React.useState(0)
  const rafRef = React.useRef(0)
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const hlRef = React.useRef(null)
  if (!hlRef.current || hlRef.current.rows !== rows || hlRef.current.lang !== lang) {
    hlRef.current = { rows, lang, map: new Map() }
  }
  const codeHtmlAt = (index) => {
    const cache = hlRef.current
    if (!cache.map.has(index)) {
      const row = rows[index]
      cache.map.set(index, highlightLineHtml(row && row.text != null ? String(row.text) : '', lang))
    }
    return cache.map.get(index)
  }

  const paintWindow = () => {
    const el = scrollerRef.current
    if (!el) return
    const list = rowsRef.current
    if (list.length <= GIT_V_THRESHOLD) return
    const scrollTop = el.scrollTop
    const first = Math.max(0, Math.floor(scrollTop / GIT_LINE_H) - GIT_BUFFER)
    const last = Math.min(list.length, Math.ceil((scrollTop + el.clientHeight) / GIT_LINE_H) + GIT_BUFFER)
    setWin((prev) => (prev.first === first && prev.last === last ? prev : { first, last }))
  }

  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return undefined
    setHitLine(0)
    // Base view: honor tab.line (transient .mdr-cl.hit at the target line). Diff
    // view: start at the top; deleted rows have no meaningful workspace line no.
    let rowIndex = -1
    if (!diffMode && targetLine > 0) {
      rowIndex = rows.findIndex((row) => row.no === targetLine)
      if (rowIndex < 0) rowIndex = Math.min(targetLine - 1, Math.max(0, total - 1))
    }
    el.scrollTop = rowIndex > 0 ? Math.max(0, rowIndex * GIT_LINE_H - Math.floor(el.clientHeight * 0.35)) : 0
    paintWindow()
    if (rowIndex >= 0) {
      setHitLine(targetLine)
      const timer = setTimeout(() => setHitLine(0), 2400)
      return () => clearTimeout(timer)
    }
    return undefined
    // rows identity changes whenever the rendered content (commit/branch/file) changes.
  }, [viewKey, targetLine, diffMode, rows, total])

  React.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const onScroll = () => {
    if (!virtual) return
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      paintWindow()
    })
  }

  const windowFrom = virtual ? Math.max(0, Math.min(win.first, Math.max(0, total - 1))) : 0
  const windowTo = virtual ? Math.min(total, Math.max(windowFrom, win.last)) : 0

  const plainHtml = React.useMemo(() => {
    if (virtual) return ''
    let html = ''
    for (let index = 0; index < rows.length; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, hitLine, codeHtmlAt(index), null)
    }
    return html
  }, [virtual, rows, lang, diffMode, hitLine])

  const windowHtml = React.useMemo(() => {
    if (!virtual) return ''
    let html = ''
    for (let index = windowFrom; index < windowTo; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, hitLine, codeHtmlAt(index), index * GIT_LINE_H)
    }
    return html
  }, [virtual, rows, lang, diffMode, hitLine, windowFrom, windowTo])

  return h(
    'div',
    {
      className: 'mdr-code-body' + (virtual ? ' mdr-git-vscroll' : ''),
      ref: scrollerRef,
      onScroll,
    },
    virtual
      ? h('div', {
          className: 'mdr-git-vwrap',
          style: { height: total * GIT_LINE_H + 'px' },
          dangerouslySetInnerHTML: { __html: windowHtml },
        })
      : h('div', { dangerouslySetInnerHTML: { __html: plainHtml } }),
  )
}

function CodeGitInfo(props) {
  const { view } = props
  const meta = view.commitMeta
  const parts = []
  if (view.commit) {
    parts.push(h('span', { className: 'mdr-git-hash' }, meta ? meta.short : String(view.commit).slice(0, 7)))
    if (meta) {
      parts.push(h('span', { className: 'mdr-git-author' }, meta.author))
      parts.push(h('span', { className: 'mdr-git-date' }, meta.date))
      parts.push(h('span', { className: 'mdr-git-subject', title: meta.subject }, meta.subject))
    }
  }
  if (view.loading) parts.push(h('span', { className: 'mdr-git-stat' }, '加载中…'))
  else if (view.hint) parts.push(h('span', { className: 'mdr-git-stat mdr-git-note' }, view.hint))
  else if (view.commit) parts.push(h('span', { className: 'mdr-git-stat' }, `+${view.stats.add} −${view.stats.del} 行`))
  return h('div', { className: 'mdr-git-info' }, parts)
}

function CodeView(props) {
  const { tab, onOpen } = props
  const { view, actions } = useGitView(tab)
  const lang = tab.lang || langForPath(tab.path)
  const workspaceContent = String(tab.content == null ? '' : tab.content)
  const viewRef = React.useRef(null)
  const [defState, setDefState] = React.useState(null)

  // Ctrl/Cmd+click anywhere in the code body looks the symbol up and opens the
  // chooser (or the only candidate directly).
  React.useEffect(() => {
    const root = viewRef.current
    if (!root || typeof onOpen !== 'function') return undefined
    const dispose = setupDefinitionClick(root, tab, (candidates, symbol, error) => {
      if (!candidates.length) {
        setDefState({ symbol, candidates: [], error: error || '' })
        return
      }
      if (candidates.length === 1) {
        onOpen(candidates[0].path, candidates[0].line)
        return
      }
      setDefState({ symbol, candidates, error: '' })
    })
    return dispose
  }, [tab.id, tab.path, onOpen])
  // "◎ branch 最新" shows the selected branch's own HEAD file when it was fetched
  // (branch switches), otherwise the workspace content the App loaded.
  const baseContent = view.branchContent != null ? view.branchContent : workspaceContent
  const diffRows = React.useMemo(
    () => (view.commit && view.hunks && view.hunks.length ? buildDiffRows(view.fileLines, view.hunks) : null),
    [view.commit, view.hunks, view.fileLines],
  )
  const rows = React.useMemo(() => {
    if (diffRows) return diffRows
    return baseContent.split('\n').map((text, index) => ({ no: index + 1, kind: 'plain', text }))
  }, [diffRows, baseContent])
  const diffMode = !!diffRows
  const viewKey = `${tab.id}|${view.branch}|${view.commit || ''}|${diffMode ? 'diff' : 'base'}`
  const showInfo = !!view.commit || !!view.hint || !!view.loading

  return h(
    'div',
    { className: 'mdr-code' },
    h('style', { dangerouslySetInnerHTML: { __html: GIT_CSS } }),
    h(
      'div',
      { className: 'mdr-code-head' },
      h(Icons.code, { size: 14 }),
      h('span', { className: 'mdr-code-path', title: tab.path }, tab.path),
      h('span', { className: 'mdr-spacer' }),
      view.git ? h(GitBar, { view, actions }) : null,
      h('span', { className: 'mdr-tip', title: 'Ctrl/Cmd + 点击符号跳转到定义' }, `${lang || 'text'} · ${rows.length} 行 · Ctrl+点击跳定义`),
    ),
    showInfo ? h(CodeGitInfo, { view }) : null,
    h(
      'div',
      { className: 'mdr-code-viewwrap', ref: viewRef },
      h(CodeBody, {
        rows,
        lang,
        diffMode,
        targetLine: tab.line || 0,
        viewKey,
      }),
    ),
    defState
      ? h(DefinitionChooser, {
          state: defState,
          onPick: (candidate) => {
            onOpen(candidate.path, candidate.line)
            setDefState(null)
          },
          onClose: () => setDefState(null),
        })
      : null,
  )
}
