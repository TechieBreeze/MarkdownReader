/**
 * Ctrl+click symbol lookup for the code view: extracts the symbol under the
 * pointer, asks the Host for declaration candidates and shows a chooser when
 * there is more than one.
 */

function symbolAtPoint(rootEl, event) {
  let node = null
  let offset = 0
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (position) {
      node = position.offsetNode
      offset = position.offset
    }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  }
  if (!node || node.nodeType !== 3) {
    const element = event.target && event.target.closest ? event.target.closest('.mdr-cl-code') : null
    if (!element) return null
    const text = element.textContent || ''
    const match = /[A-Za-z_$][\w$]*/.exec(text)
    return match ? { symbol: match[0], lineText: text } : null
  }
  const text = node.textContent || ''
  const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch)
  let start = offset
  let end = offset
  while (start > 0 && isWord(text[start - 1])) start -= 1
  while (end < text.length && isWord(text[end])) end += 1
  const symbol = text.slice(start, end)
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return null
  const row = node.parentElement && node.parentElement.closest ? node.parentElement.closest('.mdr-cl') : null
  const lineText = row ? (row.querySelector('.mdr-cl-code') || {}).textContent || '' : ''
  return { symbol, lineText: String(lineText).trim().slice(0, 300) }
}

/**
 * Attach the Ctrl/Cmd+click listener. `onResult(candidates, symbol, clicked)`
 * is called with a non-empty candidate list.
 */
function setupDefinitionClick(rootEl, tab, onResult) {
  if (!rootEl) return () => {}
  let busy = false
  const handler = async (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const hit = symbolAtPoint(rootEl, event)
    if (!hit || hit.symbol.length < 2) return
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    busy = true
    rootEl.classList.add('mdr-def-busy')
    try {
      const payload = await postJson('/api/def', {
        path: tab.path,
        symbol: hit.symbol,
        context: hit.lineText,
      })
      const candidates = (payload && payload.candidates) || []
      if (candidates.length) onResult(candidates, hit.symbol)
      else onResult([], hit.symbol)
    } catch (err) {
      onResult([], hit.symbol, String((err && err.message) || err))
    } finally {
      busy = false
      rootEl.classList.remove('mdr-def-busy')
    }
  }
  rootEl.addEventListener('click', handler)
  return () => rootEl.removeEventListener('click', handler)
}

const KIND_LABELS = { type: '类型', method: '方法', field: '字段', function: '函数', export: '导出', class: '类' }

function DefinitionChooser(props) {
  const { state, onPick, onClose } = props
  const candidates = (state && state.candidates) || []
  const [active, setActive] = React.useState(0)
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => Math.min(candidates.length - 1, current + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => Math.max(0, current - 1))
      } else if (event.key === 'Enter' && candidates[active]) {
        event.preventDefault()
        onPick(candidates[active])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [candidates, active, onPick, onClose])

  const missing = state && state.error ? state.error : ''
  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h(
      'div',
      { className: 'mdr-panel', style: { width: 'min(820px,90vw)' }, onClick: (event) => event.stopPropagation() },
      h(
        'div',
        { className: 'mdr-panel-head' },
        h(Icons.code, { size: 14 }),
        h('span', null, `定义 · ${state ? state.symbol : ''}`),
        h('span', { className: 'mdr-tip' }, missing ? missing : `${candidates.length} 个候选`),
        h('span', { className: 'mdr-spacer' }),
        h('span', { className: 'mdr-btn', onClick: onClose }, '✕'),
      ),
      h(
        'div',
        { className: 'mdr-panel-body' },
        candidates.length === 0
          ? h('div', { className: 'mdr-tip', style: { padding: '10px 12px' } }, missing || '未找到定义')
          : candidates.map((candidate, index) =>
              h(
                'div',
                {
                  key: `${candidate.path}:${candidate.line}:${index}`,
                  className: 'mdr-item-row' + (index === active ? ' on' : ''),
                  onMouseEnter: () => setActive(index),
                  onClick: () => onPick(candidate),
                  title: `${candidate.path}:${candidate.line}`,
                },
                h('span', { className: 'mdr-badge' }, KIND_LABELS[candidate.kind] || candidate.kind),
                h('span', { className: 'mdr-item-main' }, candidate.path),
                h('span', { className: 'mdr-tip' }, `:${candidate.line}`),
                h('span', { className: 'mdr-item-sub mdr-def-snippet', style: { marginLeft: 8 } }, candidate.snippet || ''),
              ),
            ),
      ),
    ),
  )
}
