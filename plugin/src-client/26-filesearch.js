/**
 * In-file search (Ctrl+F) — the plugin's port of the standalone reader's
 * 「文件内搜索」 widget.
 *
 * The standalone reader had this feature (search-widget + fsRunCode/fsRunMd);
 * the DSH plugin only got the GLOBAL search (Ctrl+Shift+F) and the quick open
 * (Ctrl+P), so Ctrl+F did nothing at all.
 *
 * Design:
 *  - the ACTIVE view registers a search controller (tab id -> controller);
 *    the App only talks to that controller, so the widget does not care
 *    whether the tab shows markdown, code, html or an image;
 *  - markdown is searched by RENDERED TEXT (matches are wrapped in
 *    `<mark class="mdr-fs-mark">`, the current one gets `.mdr-fs-cur`);
 *  - code is searched by LINE (the rows carry the plain text, so a match is a
 *    row index - the row is marked and the view scrolls to it);
 *  - the search runs on ENTER, never per keystroke ("逐字搜索太卡了"): typing
 *    only marks the query dirty, a second Enter navigates to the next match,
 *    Shift+Enter to the previous one.
 */

/* ------------------------------------------------------------- styles */

const FILE_SEARCH_CSS = `
.mdr-fs{position:absolute;top:34px;right:14px;z-index:60;display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.35);font-size:12.5px;color:var(--dsw-alias-label-primary)}
.mdr-fs-input{width:210px;box-sizing:border-box;padding:3px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.mdr-fs-input:focus{border-color:var(--dsw-alias-brand-primary)}
.mdr-fs-count{min-width:70px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.mdr-fs-count.err{color:var(--dsw-alias-state-error-primary)}
.mdr-fs-btn{padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.mdr-fs-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.mdr-fs-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mdr-fs-mark{background:rgba(255,214,102,.45);color:inherit;border-radius:2px}
.mdr-fs-mark.mdr-fs-cur{background:rgba(255,140,0,.8);color:#fff}
.mdr-cl.mdr-fs-line{background:rgba(255,214,102,.2)}
.mdr-cl.mdr-fs-cur{background:rgba(255,140,0,.32)}
`

/* ----------------------------------------------------------- registry */

/** tab id -> search controller of the mounted view. */
const fileSearchControllers = new Map()

function registerFileSearchController(key, controller) {
  if (!key) return
  fileSearchControllers.set(String(key), controller)
}

function unregisterFileSearchController(key) {
  if (!key) return
  fileSearchControllers.delete(String(key))
}

function fileSearchController(key) {
  if (!key) return null
  return fileSearchControllers.get(String(key)) || null
}

/* ------------------------------------------------------------ helpers */

function fileSearchEscapeRe(text) {
  return String(text == null ? '' : text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The search pattern: plain text by default, plus the three switches of the
 * standalone reader (Aa 大小写 / ab 全字 / .* 正则). A broken regex returns
 * null - the caller reports "正则表达式错误" instead of searching nonsense.
 */
function fileSearchRegex(query, options) {
  const opts = options || {}
  let src = String(query == null ? '' : query)
  if (!src) return null
  if (opts.re) {
    try {
      return new RegExp(src, opts.cs ? 'g' : 'gi')
    } catch {
      return null
    }
  }
  src = opts.word ? `\\b${fileSearchEscapeRe(src)}\\b` : fileSearchEscapeRe(src)
  try {
    return new RegExp(src, opts.cs ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** All [start, end] matches of `re` in `text` (the regex is reused, so reset it). */
function fileSearchMatchesIn(text, re) {
  const out = []
  re.lastIndex = 0
  let match
  while ((match = re.exec(text)) !== null) {
    out.push([match.index, match.index + match[0].length])
    if (match[0].length === 0) re.lastIndex += 1
  }
  return out
}

/* ------------------------------------------------------ markdown search */

/** Scroll a match into the middle of the viewport. */
function scrollFileSearchMark(mark) {
  if (!mark || typeof mark.scrollIntoView !== 'function') return
  try {
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    try {
      mark.scrollIntoView()
    } catch {
      /* ignore */
    }
  }
}

/** Unwrap every match mark and merge the split text nodes again. */
function mdSearchClear(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return
  const marks = container.querySelectorAll('mark.mdr-fs-mark')
  for (const mark of marks) {
    if (!mark.parentNode) continue
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent || ''), mark)
  }
  // Adjacent text nodes do not merge on their own: without normalize() the
  // text is cut into pieces and a later search misses whole words.
  if (typeof container.normalize === 'function') container.normalize()
}

/**
 * Search the rendered markdown and wrap every match in `<mark>`.
 *
 * @returns {Element[]} the marks, in document order
 */
function mdSearchFind(container, query, options) {
  mdSearchClear(container)
  if (!container || !query) return []
  const re = fileSearchRegex(query, options)
  if (!re) return []
  const walker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  const marks = []
  for (const node of nodes) {
    const parent = node.parentNode
    if (!parent || parent.nodeType !== 1) continue
    const tag = parent.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') continue
    const text = node.nodeValue || ''
    const segs = fileSearchMatchesIn(text, re)
    if (!segs.length) continue
    const frag = document.createDocumentFragment()
    let pos = 0
    for (const [start, end] of segs) {
      if (start > pos) frag.appendChild(document.createTextNode(text.slice(pos, start)))
      const mark = document.createElement('mark')
      mark.className = 'mdr-fs-mark'
      mark.textContent = text.slice(start, end)
      frag.appendChild(mark)
      marks.push(mark)
      pos = end
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)))
    parent.replaceChild(frag, node)
  }
  return marks
}

/* ------------------------------------------------------------- widget */

/**
 * The floating search widget.
 *
 * Enter searches (or moves to the next match), Shift+Enter to the previous
 * one, Escape closes. The count is the App's state, the widget is dumb.
 */
function FileSearchWidget(props) {
  const {
    query,
    onQuery,
    count,
    index,
    status,
    options,
    onToggleOption,
    onSearch,
    onNext,
    onPrev,
    onClose,
    onGlobal,
  } = props
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return undefined
    input.focus()
    if (typeof input.select === 'function') input.select()
    return undefined
  }, [])

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrev()
      else onNext()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const total = Number(count || 0)
  const current = Number(index || 0) + 1
  const label = status ? status : total ? `${current} / ${total}` : '0 处'

  return h(
    'div',
    { className: 'mdr-fs', onClick: (event) => event.stopPropagation() },
    h('input', {
      ref: inputRef,
      className: 'mdr-fs-input',
      type: 'text',
      value: query,
      placeholder: '在当前文件中查找',
      onChange: (event) => onQuery(event.target.value),
      onKeyDown,
    }),
    h('span', { className: 'mdr-fs-count' + (status ? ' err' : '') }, label),
    h(
      'button',
      { type: 'button', className: 'mdr-fs-btn', title: '上一个匹配 (Shift+Enter)', onClick: onPrev },
      '↑',
    ),
    h(
      'button',
      { type: 'button', className: 'mdr-fs-btn', title: '下一个匹配 (Enter)', onClick: onNext },
      '↓',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mdr-fs-btn' + (options && options.cs ? ' on' : ''),
        title: '区分大小写',
        onClick: () => onToggleOption('cs'),
      },
      'Aa',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mdr-fs-btn' + (options && options.word ? ' on' : ''),
        title: '全字匹配',
        onClick: () => onToggleOption('word'),
      },
      'ab',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mdr-fs-btn' + (options && options.re ? ' on' : ''),
        title: '正则表达式',
        onClick: () => onToggleOption('re'),
      },
      '.*',
    ),
    typeof onGlobal === 'function'
      ? h('button', { type: 'button', className: 'mdr-fs-btn', title: '全局搜索 (Ctrl+Shift+F)', onClick: onGlobal }, '全局')
      : null,
    h('button', { type: 'button', className: 'mdr-fs-btn', title: '关闭 (Esc)', onClick: onClose }, '✕'),
  )
}
