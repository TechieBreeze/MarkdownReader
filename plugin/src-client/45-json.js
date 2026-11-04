/** JSON formatting tool (owned by the search slice). */

const JSON_INDENT = 2

/**
 * Parse JSON and locate the first syntax error as line/column.
 *
 * Chrome's JSON.parse message carries no position (or, on newer versions, a
 * "position N" suffix); Node/Firefox include a position. Prefer the message
 * position and fall back to the hand scanner below.
 */
function jsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    let line = 1
    let col = 1
    const match = /position (\d+)/.exec(String((error && error.message) || ''))
    if (match) {
      const pos = parseInt(match[1], 10)
      const lines = text.slice(0, pos).split('\n')
      line = lines.length
      col = lines[lines.length - 1].length + 1
    } else {
      const loc = jsonLocateError(text)
      if (loc) {
        line = loc.line
        col = loc.col
      }
    }
    return { ok: false, line, col, message: String((error && error.message) || error) }
  }
}

/**
 * Lightweight JSON scanner used when the parse error carries no position.
 * Walks characters tracking string/escape state and a bracket stack and returns
 * the first structural problem; it never calls JSON.parse again.
 */
function jsonLocateError(text) {
  let i = 0
  let line = 1
  let col = 1
  const n = text.length
  const stack = []
  const adv = () => {
    if (text[i] === '\n') {
      line += 1
      col = 1
    } else col += 1
    i += 1
  }
  const err = (message) => ({ line, col, message })
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  const isDigit = (c) => c >= '0' && c <= '9'

  while (i < n) {
    const ch = text[i]
    if (isWs(ch)) {
      adv()
      continue
    }
    if (ch === '"') {
      const startLine = line
      const startCol = col
      adv()
      let closed = false
      while (i < n) {
        const c = text[i]
        if (c === '\\') {
          adv()
          if (i < n) adv()
          continue
        }
        if (c === '"') {
          adv()
          closed = true
          break
        }
        if (c === '\n') break // unescaped newline inside a string
        adv()
      }
      if (!closed) return { line: startLine, col: startCol, message: '字符串未闭合' }
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']')
      adv()
      continue
    }
    if (ch === '}' || ch === ']') {
      const expect = stack.pop()
      if (expect !== ch) return err(expect ? `意外的 '${ch}'，期望 '${expect}'` : `多余的 '${ch}'`)
      adv()
      continue
    }
    if (ch === ':') {
      adv()
      continue
    }
    if (ch === ',') {
      adv()
      // trailing comma: [1,2,] / {"a":1,}
      let j = i
      while (j < n && isWs(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') return { line, col, message: '尾随逗号' }
      continue
    }
    if (isDigit(ch) || ch === '-') {
      adv()
      while (i < n && /[0-9.eE+\-]/.test(text[i])) adv()
      continue
    }
    if (text.startsWith('true', i) || text.startsWith('false', i) || text.startsWith('null', i)) {
      const len = text.startsWith('true', i) ? 4 : text.startsWith('false', i) ? 5 : 4
      for (let k = 0; k < len; k += 1) adv()
      continue
    }
    return err(`意外的字符 '${ch}'`)
  }
  if (stack.length) return { line, col, message: `缺少闭合符 '${stack[stack.length - 1]}'` }
  return null
}

function highlightJson(text) {
  try {
    if (!window.hljs || typeof window.hljs.highlight !== 'function') return escapeHtml(text)
    return window.hljs.highlight(text, { language: 'json', ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}

const JSON_CSS = `
.mdr-json-panel{width:min(1100px,92vw);height:min(720px,88vh);max-height:88vh}
.mdr-json-head{gap:8px}
.mdr-json-subtitle{font-weight:400;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdr-json-body{flex:1;min-height:0;display:flex;overflow:hidden;padding:0}
.mdr-json-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;background:#1e1e1e}
.mdr-json-split{flex:0 0 1px;background:var(--dsw-alias-border-l1)}
.mdr-json-label{flex:0 0 auto;padding:5px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mdr-json-input{flex:1;min-height:0;padding:12px 14px;border:none;outline:none;resize:none;background:#1e1e1e;color:#c9d1d9;font:12.5px/1.55 "Cascadia Code",Consolas,"Courier New",monospace;white-space:pre;overflow:auto;tab-size:4}
.mdr-json-input:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.mdr-json-output{flex:1;min-height:0;overflow:auto;padding:12px 14px;background:#1e1e1e;color:#c9d1d9;font:12.5px/1.55 "Cascadia Code",Consolas,"Courier New",monospace;white-space:pre;tab-size:4}
.mdr-json-error{color:var(--dsw-alias-state-error-primary);font-family:inherit;white-space:pre-wrap}
.mdr-json-placeholder{color:var(--dsw-alias-label-secondary);font-family:inherit}
.mdr-json-pre{margin:0;padding:0;background:transparent;font:inherit;white-space:pre;overflow:visible}
.mdr-json-pre code.hljs{padding:0;background:transparent;font:inherit}
.mdr-json-footer{padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;flex:0 0 auto;min-height:30px;box-sizing:border-box}
.mdr-json-ok{color:#57A773}
.mdr-json-bad{color:var(--dsw-alias-state-error-primary)}
@media (max-width:720px){.mdr-json-subtitle{display:none}}
`

function JsonTool(props) {
  const { onClose } = props
  const inputRef = React.useRef(null)
  const outputRef = React.useRef(null)
  const [source, setSource] = React.useState('')
  const [output, setOutput] = React.useState(null)
  const [status, setStatus] = React.useState({ kind: 'info', text: 'Ctrl+Enter 格式化' })

  React.useEffect(() => {
    const input = inputRef.current
    if (input && typeof input.focus === 'function') input.focus()
    return undefined
  }, [])

  const run = (kind) => {
    const text = source
    if (!text.trim()) {
      setOutput(null)
      setStatus({ kind: 'bad', text: '输入为空' })
      return
    }
    const parsed = jsonParse(text)
    if (!parsed.ok) {
      setOutput({ text: '', html: '', error: `JSON 解析错误：${parsed.message}\n位置：第 ${parsed.line} 行，第 ${parsed.col} 列` })
      setStatus({ kind: 'bad', text: `解析失败：第 ${parsed.line} 行，第 ${parsed.col} 列` })
      return
    }
    let result
    try {
      result = kind === 'minify' ? JSON.stringify(parsed.value) : JSON.stringify(parsed.value, null, JSON_INDENT)
    } catch (error) {
      setOutput({ text: '', html: '', error: `序列化失败：${String((error && error.message) || error)}` })
      setStatus({ kind: 'bad', text: '序列化失败' })
      return
    }
    setOutput({ text: result, html: highlightJson(result), error: '' })
    setStatus({ kind: 'ok', text: `解析成功（${kind === 'minify' ? '已压缩' : '已格式化'}，${result.length} 字符）` })
  }

  const selectOutput = () => {
    const node = outputRef.current
    if (!node) return false
    try {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection ? window.getSelection() : null
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    } catch {
      return false
    }
  }

  const copyOutput = () => {
    const text = output && output.text
    if (!text) {
      setStatus({ kind: 'bad', text: '无输出可复制' })
      return
    }
    // http:// origins have no navigator.clipboard in Chromium: fall back to
    // selecting the output (and execCommand, which needs a user gesture).
    const fallback = () => {
      const selected = selectOutput()
      let copied = false
      try {
        copied = selected && document.execCommand ? document.execCommand('copy') : false
      } catch {
        copied = false
      }
      if (copied) setStatus({ kind: 'ok', text: '已复制到剪贴板' })
      else if (selected) setStatus({ kind: 'ok', text: '已选中输出文本，按 Ctrl+C 复制' })
      else setStatus({ kind: 'bad', text: '复制失败，请手动选择输出文本' })
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(
        () => setStatus({ kind: 'ok', text: '已复制到剪贴板' }),
        () => fallback(),
      )
    } else {
      fallback()
    }
  }

  const clearAll = () => {
    setSource('')
    setOutput(null)
    setStatus({ kind: 'ok', text: '已清空' })
    const input = inputRef.current
    if (input && typeof input.focus === 'function') input.focus()
  }

  const onInputKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      run('format')
    }
  }

  let outputNode
  if (output == null) {
    outputNode = h('span', { className: 'mdr-json-placeholder' }, '格式化 / 压缩后的结果会显示在这里')
  } else if (output.error) {
    outputNode = h('span', { className: 'mdr-json-error' }, output.error)
  } else {
    outputNode = h('pre', { className: 'mdr-json-pre' }, h('code', { className: 'hljs', dangerouslySetInnerHTML: { __html: output.html } }))
  }

  const statusClass = status.kind === 'ok' ? 'mdr-json-ok' : status.kind === 'bad' ? 'mdr-json-bad' : 'mdr-tip'

  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h(
      'div',
      {
        className: 'mdr-panel mdr-json-panel',
        onClick: (event) => event.stopPropagation(),
      },
      h('style', { dangerouslySetInnerHTML: { __html: JSON_CSS } }),
      h(
        'div',
        { className: 'mdr-panel-head mdr-json-head' },
        h(Icons.code, { size: 14 }),
        h('span', null, 'JSON 工具'),
        h('span', { className: 'mdr-json-subtitle mdr-tip' }, '粘贴 JSON → 格式化 / 压缩 / 校验'),
        h('span', { className: 'mdr-spacer' }),
        h('button', { type: 'button', className: 'mdr-btn', title: '格式化（2 空格缩进，Ctrl+Enter）', onClick: () => run('format') }, '格式化'),
        h('button', { type: 'button', className: 'mdr-btn', title: '压缩为单行', onClick: () => run('minify') }, '压缩'),
        h('button', { type: 'button', className: 'mdr-btn', title: '复制输出结果', onClick: copyOutput }, '复制结果'),
        h('button', { type: 'button', className: 'mdr-btn', title: '清空输入和输出', onClick: clearAll }, '清空'),
        h(
          'button',
          { type: 'button', className: 'mdr-btn', title: '关闭（Esc）', 'aria-label': '关闭', onClick: onClose },
          h(Icons.close, { size: 12 }),
        ),
      ),
      h(
        'div',
        { className: 'mdr-json-body' },
        h(
          'div',
          { className: 'mdr-json-col' },
          h('div', { className: 'mdr-json-label' }, '输入'),
          h('textarea', {
            ref: inputRef,
            className: 'mdr-json-input',
            value: source,
            spellCheck: false,
            autoComplete: 'off',
            'aria-label': 'JSON 输入',
            placeholder: '{"key": "value", "list": [1, 2, 3]}',
            onChange: (event) => setSource(event.target.value),
            onKeyDown: onInputKeyDown,
          }),
        ),
        h('div', { className: 'mdr-json-split' }),
        h(
          'div',
          { className: 'mdr-json-col' },
          h('div', { className: 'mdr-json-label' }, '输出'),
          h('div', { className: 'mdr-json-output', ref: outputRef }, outputNode),
        ),
      ),
      h('div', { className: 'mdr-json-footer' }, h('span', { className: statusClass }, status.text)),
    ),
  )
}
