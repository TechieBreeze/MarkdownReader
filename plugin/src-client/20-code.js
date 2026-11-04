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

function buildCodeHtml(lines, lang) {
  const chunks = new Array(lines.length)
  for (let i = 0; i < lines.length; i += 1) {
    chunks[i] = `<div class="mdr-cl" data-line="${i + 1}"><span class="mdr-cl-no">${i + 1}</span><span class="mdr-cl-code">${highlightLineHtml(
      lines[i],
      lang,
    )}</span></div>`
  }
  return chunks.join('')
}

function CodeView(props) {
  const { tab } = props
  const scrollerRef = React.useRef(null)
  const content = String(tab.content == null ? '' : tab.content)
  const lang = tab.lang || langForPath(tab.path)
  const lineCount = tab.content == null ? 0 : content.split('\n').length
  const html = React.useMemo(() => buildCodeHtml(content.split('\n'), lang), [content, lang])
  const targetLine = tab.line || 0

  React.useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return undefined
    scroller.querySelectorAll('.mdr-cl.hit').forEach((row) => row.classList.remove('hit'))
    if (!targetLine) {
      scroller.scrollTop = 0
      return undefined
    }
    const row = scroller.querySelector(`.mdr-cl[data-line="${targetLine}"]`)
    if (!row) return undefined
    const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = Math.max(0, top - Math.floor(scroller.clientHeight * 0.35))
    row.classList.add('hit')
    const timer = setTimeout(() => row.classList.remove('hit'), 2400)
    return () => clearTimeout(timer)
  }, [tab.id, content, targetLine, html])

  return h(
    'div',
    { className: 'mdr-code' },
    h(
      'div',
      { className: 'mdr-code-head' },
      h(Icons.code, { size: 14 }),
      h('span', { className: 'mdr-code-path', title: tab.path }, tab.path),
      h('span', { className: 'mdr-spacer' }),
      h('span', { className: 'mdr-tip' }, `${lang || 'text'} · ${lineCount} 行`),
    ),
    h('div', { className: 'mdr-code-body', ref: scrollerRef, dangerouslySetInnerHTML: { __html: html } }),
  )
}
