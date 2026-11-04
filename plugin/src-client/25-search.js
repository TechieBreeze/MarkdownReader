/** Global search panel + quick open (owned by the search slice). */

const SEARCH_MIN_CHARS = 2
const SEARCH_DEBOUNCE_MS = 250
const SEARCH_LIMIT = 120
const SEARCH_MAX_ROWS = 200
const FILES_DEBOUNCE_MS = 160
const FILES_LIMIT = 40

/**
 * Highlight every case-insensitive occurrence of `query` in a result line.
 *
 * The line text arrives as raw file text, so the match is located on the raw
 * string and each slice is escaped separately. Doing it in this order means a
 * query containing `<`, `>` or `&` cannot inject markup and cannot miss because
 * the needle was escaped into `&lt;` before comparison.
 */
function highlightMatch(text, query) {
  const source = String(text == null ? '' : text)
  const needle = String(query || '')
  if (!needle) return escapeHtml(source)
  const haystack = source.toLowerCase()
  const lower = needle.toLowerCase()
  let html = ''
  let from = 0
  for (;;) {
    const at = haystack.indexOf(lower, from)
    if (at < 0) break
    html += escapeHtml(source.slice(from, at))
    html += `<mark>${escapeHtml(source.slice(at, at + needle.length))}</mark>`
    from = at + Math.max(1, needle.length)
  }
  html += escapeHtml(source.slice(from))
  return html
}

const SEARCH_CSS = `
.mdr-search-panel{width:min(720px,88vw);height:min(78vh,660px);max-height:78vh}
.mdr-search-head{gap:8px}
.mdr-search-title{flex:0 0 auto}
.mdr-search-close{padding:3px 5px}
.mdr-search-body{display:flex;flex-direction:column;overflow:hidden;padding:0}
.mdr-search-status{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;white-space:nowrap}
.mdr-search-status-text{overflow:hidden;text-overflow:ellipsis}
.mdr-search-status-err .mdr-search-status-text{color:var(--dsw-alias-state-error-primary)}
.mdr-search-keys{flex:0 0 auto;opacity:.75}
.mdr-search-list{flex:1;min-height:0;overflow:auto;padding:2px 0 6px}
.mdr-search-list .mdr-item-sub{flex:0 1 auto;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-search-list .mdr-item-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-search-row{display:block;padding:5px 12px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.mdr-search-row:hover{background:var(--dsw-alias-bg-layer-2)}
.mdr-search-row.on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mdr-search-row-head{display:flex;align-items:baseline;gap:6px;min-width:0;line-height:1.5}
.mdr-search-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mdr-search-line{flex:0 0 auto;color:var(--dsw-alias-label-secondary);opacity:.8;font-family:"Cascadia Code",Consolas,monospace;font-size:11px}
.mdr-search-row .mdr-hit-line{padding:1px 0 0;font-size:11.5px}
@media (max-width:560px){.mdr-search-keys{display:none}}
`

function SearchPanel(props) {
  const { mode, onClose, onOpen } = props
  const isFiles = mode === 'files'
  const inputRef = React.useRef(null)
  const listRef = React.useRef(null)
  const seqRef = React.useRef(0)
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState('idle')
  const [rows, setRows] = React.useState([])
  const [meta, setMeta] = React.useState({ total: 0, truncated: false, query: '' })
  const [error, setError] = React.useState('')
  const [active, setActive] = React.useState(-1)

  // Autofocus (and select any restored text) as soon as the panel appears.
  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return undefined
    input.focus()
    if (typeof input.select === 'function') input.select()
    return undefined
  }, [])

  // Debounced loading. Every query change invalidates responses still in flight
  // (seqRef), and unmounting clears the pending timer.
  React.useEffect(() => {
    const trimmed = query.trim()
    const seq = ++seqRef.current
    if (!isFiles && trimmed.length < SEARCH_MIN_CHARS) {
      setStatus('idle')
      setRows([])
      setMeta({ total: 0, truncated: false, query: '' })
      setError('')
      setActive(-1)
      return undefined
    }
    setStatus('loading')
    setError('')
    const timer = setTimeout(() => {
      const endpoint = isFiles ? '/api/files' : '/api/search'
      const params = isFiles ? { q: trimmed, limit: FILES_LIMIT } : { q: trimmed, limit: SEARCH_LIMIT }
      fetchJson(endpoint, params)
        .then((payload) => {
          if (seqRef.current !== seq) return
          let count = 0
          if (isFiles) {
            const items = Array.isArray(payload.items) ? payload.items : []
            count = items.length
            setRows(items)
            setMeta({ total: Number(payload.total) || items.length, truncated: false, query: trimmed })
          } else {
            const all = Array.isArray(payload.results) ? payload.results : []
            count = Math.min(all.length, SEARCH_MAX_ROWS)
            setRows(all.slice(0, SEARCH_MAX_ROWS))
            setMeta({
              total: all.length,
              truncated: !!payload.truncated,
              query: typeof payload.query === 'string' ? payload.query : trimmed,
            })
          }
          setStatus('ready')
          setActive((current) => (count ? Math.min(current < 0 ? 0 : current, count - 1) : -1))
        })
        .catch((err) => {
          if (seqRef.current !== seq) return
          setRows([])
          setError(String((err && err.message) || err))
          setStatus('error')
          setActive(-1)
        })
    }, isFiles ? FILES_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      seqRef.current += 1
    }
  }, [query, isFiles])

  // Keep the keyboard-selected row visible while arrowing through results.
  React.useEffect(() => {
    if (active < 0) return undefined
    const list = listRef.current
    if (!list) return undefined
    const row = list.querySelector('.mdr-search-row.on, .mdr-item-row.on')
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
    return undefined
  }, [active, rows])

  const openRow = (row) => {
    if (!row || !row.path) return
    if (isFiles) onOpen(row.path, null)
    else onOpen(row.path, Number(row.line) || 1)
    onClose()
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[active >= 0 ? active : 0]
      if (row) openRow(row)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (!rows.length) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    setActive((current) => {
      const base = current < 0 ? 0 : current
      return (base + delta + rows.length) % rows.length
    })
  }

  let statusText = ''
  let statusError = false
  if (status === 'error') {
    statusText = `${isFiles ? '加载文件失败' : '搜索失败'}：${error}`
    statusError = true
  } else if (status === 'loading') {
    statusText = isFiles ? '加载文件清单…' : '搜索中…'
  } else if (isFiles) {
    if (status === 'ready') {
      if (!rows.length) statusText = meta.query ? `无匹配文件：「${meta.query}」` : '没有可打开的文件'
      else statusText = `共 ${meta.total} 个文件${meta.total > rows.length ? `，显示前 ${rows.length} 个` : ''}`
    } else {
      statusText = '输入文件名或路径片段'
    }
  } else if (status === 'idle') {
    statusText = `输入关键词，至少 ${SEARCH_MIN_CHARS} 个字符`
  } else if (status === 'ready') {
    if (!rows.length) {
      // A truncated walk means "not found" is not authoritative: say so.
      statusText = `无结果：未找到包含「${meta.query}」的内容` + (meta.truncated ? '（扫描被截断，可能未覆盖全部文件）' : '')
    } else
      statusText =
        `找到 ${meta.total} 条匹配` +
        (meta.total > rows.length ? `，显示前 ${rows.length} 条` : '') +
        (meta.truncated ? ' · 结果过多，已截断' : '')
  }

  const rowNodes = isFiles
    ? rows.map((item, index) =>
        h(
          'div',
          {
            key: item.path || `file-${index}`,
            className: 'mdr-item-row' + (index === active ? ' on' : ''),
            title: item.path || '',
            onClick: () => openRow(item),
          },
          h('span', { className: 'mdr-item-main' }, item.name || String(item.path || '').split('/').pop()),
          h('span', { className: 'mdr-item-sub' }, item.dir || ''),
        ),
      )
    : rows.map((row, index) =>
        h(
          'div',
          {
            key: `${row.path}:${row.line}:${index}`,
            className: 'mdr-search-row' + (index === active ? ' on' : ''),
            title: `${row.path}:${row.line}`,
            onClick: () => openRow(row),
          },
          h(
            'div',
            { className: 'mdr-search-row-head' },
            h('span', { className: 'mdr-search-path', 'data-mdr-path': row.path }, row.path),
            h('span', { className: 'mdr-search-line' }, `:${row.line}`),
          ),
          h('div', { className: 'mdr-hit-line', dangerouslySetInnerHTML: { __html: highlightMatch(row.text, meta.query || query) } }),
        ),
      )

  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h(
      'div',
      {
        className: 'mdr-panel mdr-search-panel',
        onClick: (event) => event.stopPropagation(),
      },
      h('style', { dangerouslySetInnerHTML: { __html: SEARCH_CSS } }),
      h(
        'div',
        { className: 'mdr-panel-head mdr-search-head' },
        h('span', { className: 'mdr-search-title' }, isFiles ? '快速打开' : '搜索'),
        h('input', {
          ref: inputRef,
          className: 'mdr-panel-input',
          type: 'text',
          value: query,
          spellCheck: false,
          autoComplete: 'off',
          'aria-label': isFiles ? '按文件名或路径搜索' : '搜索关键词',
          placeholder: isFiles ? '文件名 / 路径片段（↑↓ 选择，回车打开）' : '关键词（至少 2 个字符，回车打开首条结果）',
          onChange: (event) => setQuery(event.target.value),
          onKeyDown,
        }),
        h(
          'button',
          { type: 'button', className: 'mdr-btn mdr-search-close', title: '关闭（Esc）', 'aria-label': '关闭', onClick: onClose },
          h(Icons.close, { size: 12 }),
        ),
      ),
      h(
        'div',
        { className: 'mdr-panel-body mdr-search-body' },
        h(
          'div',
          { className: 'mdr-search-status mdr-tip' + (statusError ? ' mdr-search-status-err' : '') },
          h('span', { className: 'mdr-search-status-text' }, statusText),
          h('span', { className: 'mdr-spacer' }),
          h('span', { className: 'mdr-search-keys' }, '↑↓ 选择 · Enter 打开 · Esc 关闭'),
        ),
        h('div', { className: 'mdr-search-list', ref: listRef }, rowNodes),
      ),
    ),
  )
}
