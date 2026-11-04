/**
 * HTML / image tab views — owned by the html slice.
 *
 * Contracts (wired by 50-app.js / the workbench slice):
 *   h(HtmlTabView, { tab, onToggleMode, onLocate })
 *     tab = { id, kind:'html', path, content?: string|null, htmlMode:'render'|'source', line:number, error?:string }
 *     · render mode is the DEFAULT: a full-height sandboxed iframe pointing at
 *       /api/html?path=… (the Host rewrites relative resources to /api/raw).
 *       The iframe stays mounted while the user toggles to source mode, so
 *       coming back does not reload the document (scripts / scroll survive).
 *     · source mode lazily fetches /api/code (only when tab.content is null),
 *       renders line numbers + hljs highlight via highlightLineHtml/langForPath
 *       from 20-code.js, and keeps the jumped-to line highlighted persistently.
 *   h(ImageView, { tab, onLocate? })
 *     tab = { id, kind:'image', path }
 *     · centered image from /api/raw, letterboxed fit by default, click to
 *       toggle 100% (scrollable) and back; natural-size badge + error retry.
 *
 * All styles are component-local with mdr-html-* / mdr-image-* prefixes; only
 * shared utility classes (.mdr-btn/.mdr-spacer) are reused, none are changed.
 */

/** Same line height as the code view so the source mode looks identical. */
const HTML_SRC_LINE_H = 20
/** Above this many lines the source view only paints the viewport (+ buffer). */
const HTML_SRC_VIRTUAL_THRESHOLD = 800
const HTML_SRC_BUFFER = 40
/** Bound the per-line highlight cache for very large documents. */
const HTML_SRC_HL_CACHE_LIMIT = 8000

const HTML_TAB_CSS = `
.mdr-html{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.mdr-html-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;row-gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.mdr-html-icon{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-brand-primary)}
.mdr-html-path{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.mdr-html-badge{flex:0 0 auto;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mdr-html-note{flex:0 0 auto;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-state-error-primary);background:rgba(248,81,73,.07)}
.mdr-html-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0}
.mdr-html-render{position:relative;display:flex;flex:1;min-height:0;background:#fff}
.mdr-html-frame{display:block;flex:1;width:100%;height:100%;border:0;background:#fff}
.mdr-html-frame-note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.mdr-html-source{flex:1;min-height:0;overflow:auto;background:#1e1e1e}
.mdr-html-rows{position:relative;min-width:100%}
.mdr-html-row{display:flex;min-height:20px;line-height:20px;font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:12.5px}
.mdr-html-src-virtual .mdr-html-row{position:absolute;left:0;right:0;height:20px;min-height:0}
.mdr-html-row.hit{background:rgba(255,214,102,.16);box-shadow:inset 3px 0 0 #ffd33d}
.mdr-html-no{flex:0 0 62px;text-align:right;padding-right:14px;color:#858585;background:#252526;border-right:1px solid #3e3e42;user-select:none;position:sticky;left:0;z-index:1}
.mdr-html-code{flex:1;padding-left:16px;color:#d4d4d4;white-space:pre;tab-size:4}
.mdr-html-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:44px 16px;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center}
.mdr-html-state-err{color:var(--dsw-alias-state-error-primary)}
`

const IMAGE_TAB_CSS = `
.mdr-image{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.mdr-image-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;row-gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.mdr-image-icon{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-brand-primary)}
.mdr-image-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.mdr-image-dims{flex:0 0 auto;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.mdr-image-hint{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.mdr-image-stage{position:relative;display:flex;flex:1;min-height:0;overflow:auto;background-color:#1e1e1e;background-image:linear-gradient(45deg,#262626 25%,transparent 25%),linear-gradient(-45deg,#262626 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#262626 75%),linear-gradient(-45deg,transparent 75%,#262626 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
.mdr-image-wrap{display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin:auto;width:100%;height:100%;padding:20px;box-sizing:border-box}
.mdr-image-img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;cursor:zoom-in;user-select:none;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 8px 30px rgba(0,0,0,.45)}
.mdr-image-zoomed .mdr-image-wrap{width:auto;height:auto;max-width:none;max-height:none}
.mdr-image-zoomed .mdr-image-img{max-width:none;max-height:none;cursor:zoom-out}
.mdr-image-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary);font-size:12.5px;text-align:center}
.mdr-image-error-path{color:var(--dsw-alias-label-secondary);font-size:11.5px;word-break:break-all}
`

/** Exception text for the inline source-mode error row. */
function htmlTabErrorText(error) {
  if (!error) return ''
  const message = error && error.message != null ? error.message : error
  const text = String(message == null ? '' : message).trim()
  return text || '未知错误'
}

/** langForPath lives in 20-code.js; tolerate it being renamed while slices land. */
function htmlTabLangOf(path) {
  try {
    if (typeof langForPath === 'function') return String(langForPath(path) || '')
  } catch {
    // fall through
  }
  return ''
}

/** highlightLineHtml lives in 20-code.js; fall back to escaped text if absent. */
function htmlTabHighlightLine(text, lang) {
  const value = String(text == null ? '' : text)
  try {
    if (typeof highlightLineHtml === 'function') {
      const html = highlightLineHtml(value, lang)
      if (typeof html === 'string' && html) return html
    }
  } catch {
    // fall through to the safe fallback
  }
  return escapeHtml(value) || ' '
}

/**
 * Line-numbered, highlighted HTML source. Virtualized above
 * HTML_SRC_VIRTUAL_THRESHOLD rows; the jumped line keeps its .hit class for as
 * long as tab.line points at it (no timer here — that is the whole point).
 */
function HtmlSourceView(props) {
  const { content, lang, hitLine } = props || {}
  const text = String(content == null ? '' : content)
  const lines = React.useMemo(() => text.split('\n'), [text])
  const total = lines.length
  const virtual = total > HTML_SRC_VIRTUAL_THRESHOLD
  const scrollerRef = React.useRef(null)
  const [windowState, setWindowState] = React.useState({ first: 0, last: 0 })
  const cacheRef = React.useRef({ lines, lang, map: new Map() })
  if (cacheRef.current.lines !== lines || cacheRef.current.lang !== lang) {
    cacheRef.current = { lines, lang, map: new Map() }
  }

  const htmlAt = (index) => {
    const cache = cacheRef.current
    if (!cache.map.has(index)) {
      if (cache.map.size > HTML_SRC_HL_CACHE_LIMIT) cache.map.clear()
      cache.map.set(index, htmlTabHighlightLine(lines[index] == null ? '' : String(lines[index]), lang))
    }
    return cache.map.get(index)
  }

  const paintWindow = () => {
    const el = scrollerRef.current
    if (!el || !virtual) return
    const first = Math.max(0, Math.floor(el.scrollTop / HTML_SRC_LINE_H) - HTML_SRC_BUFFER)
    const last = Math.min(total, Math.ceil((el.scrollTop + el.clientHeight) / HTML_SRC_LINE_H) + HTML_SRC_BUFFER)
    setWindowState((previous) => (previous.first === first && previous.last === last ? previous : { first, last }))
  }

  // The jump target wins over everything and must stay highlighted; it is
  // re-applied whenever a late /api/code response changes the row count.
  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const line = Number(hitLine) > 0 ? Math.min(Number(hitLine), total) : 0
    if (line > 0) el.scrollTop = Math.max(0, (line - 1) * HTML_SRC_LINE_H - Math.floor(el.clientHeight * 0.3))
    else el.scrollTop = 0
    paintWindow()
    // total/text changes when the lazily fetched source arrives.
  }, [hitLine, total, virtual, text])

  const virtualFrom = virtual ? windowState.first : 0
  // First paint happens before the scroll container can be measured; fall back
  // to a viewport-sized window instead of painting zero rows.
  const virtualTo = virtual
    ? windowState.last > windowState.first
      ? windowState.last
      : Math.min(total, HTML_SRC_BUFFER * 4 + 80)
    : total
  const rowNodes = []
  for (let index = virtualFrom; index < virtualTo; index += 1) {
    const lineNo = index + 1
    rowNodes.push(
      h(
        'div',
        {
          key: index,
          className: 'mdr-html-row' + (lineNo === Number(hitLine) ? ' hit' : ''),
          'data-line': lineNo,
          style: virtual ? { top: index * HTML_SRC_LINE_H } : undefined,
        },
        h('span', { className: 'mdr-html-no' }, lineNo),
        h('span', { className: 'mdr-html-code', dangerouslySetInnerHTML: { __html: htmlAt(index) } }),
      ),
    )
  }

  return h(
    'div',
    {
      className: 'mdr-html-source' + (virtual ? ' mdr-html-src-virtual' : ''),
      ref: scrollerRef,
      onScroll: paintWindow,
    },
    h(
      'div',
      { className: 'mdr-html-rows', style: virtual ? { height: total * HTML_SRC_LINE_H + 'px' } : undefined },
      rowNodes,
    ),
  )
}

function HtmlTabView(props) {
  const { tab, onToggleMode, onLocate } = props || {}
  const path = String((tab && tab.path) || '')
  const line = Number(tab && tab.line) || 0
  const tabContent = tab ? tab.content : null
  const tabError = tab && tab.error ? String(tab.error) : ''
  const [fallbackMode, setFallbackMode] = React.useState('')
  const [remote, setRemote] = React.useState({ status: 'idle', content: '', error: '' })
  const [retryNonce, setRetryNonce] = React.useState(0)
  const [frameLoaded, setFrameLoaded] = React.useState(false)

  // htmlMode is owned/persisted by the App (50-app.js); keep a local fallback so
  // the component still works if onToggleMode is not wired yet.
  const mode = fallbackMode || (tab && tab.htmlMode === 'source' ? 'source' : 'render')
  const frameSrc = path ? `${ROUTE}/api/html?path=${encodeURIComponent(path)}` : ''
  const toggle = () => {
    const next = mode === 'render' ? 'source' : 'render'
    if (typeof onToggleMode === 'function') onToggleMode(next)
    else setFallbackMode(next)
  }
  const locate = typeof onLocate === 'function' ? () => onLocate(path) : null

  React.useEffect(() => {
    setFrameLoaded(false)
  }, [path])

  // Lazily pull the source text only when the user actually opens source mode
  // and the App has not loaded it already. Never fetch in render mode.
  React.useEffect(() => {
    if (mode !== 'source') return undefined
    if (tabContent != null) return undefined
    if (!path) return undefined
    let alive = true
    setRemote({ status: 'loading', content: '', error: '' })
    fetchJson('/api/code', { path })
      .then((payload) => {
        if (!alive) return
        setRemote({
          status: 'ready',
          content: String(payload && payload.content != null ? payload.content : ''),
          error: '',
        })
      })
      .catch((error) => {
        if (!alive) return
        setRemote({ status: 'error', content: '', error: htmlTabErrorText(error) })
      })
    return () => {
      alive = false
    }
  }, [mode, path, tabContent, retryNonce])

  const sourceContent = tabContent != null ? String(tabContent) : remote.content
  const sourceReady = tabContent != null || remote.status === 'ready'
  const sourceError = tabContent != null ? '' : remote.status === 'error' ? remote.error : ''
  const badge = mode === 'render' ? '渲染预览' : '源码视图'
  const lang = (tab && typeof tab.lang === 'string' && tab.lang) || htmlTabLangOf(path)

  const head = h(
    'div',
    { className: 'mdr-html-head' },
    h('span', { className: 'mdr-html-icon' }, h(Icons.code, { size: 14 })),
    h('span', { className: 'mdr-html-path', title: path }, path || '（未选择文件）'),
    h('span', { className: 'mdr-html-badge' }, line > 0 ? `${badge} · 第 ${line} 行` : badge),
    h('span', { className: 'mdr-spacer' }),
    locate
      ? h(
          'button',
          { type: 'button', className: 'mdr-btn', onClick: locate, title: '在左侧目录树中定位本文件' },
          '定位',
        )
      : null,
    h(
      'button',
      { type: 'button', className: 'mdr-btn', onClick: toggle, title: '切换 渲染视图 / 源码视图' },
      mode === 'render' ? '源码视图' : '渲染视图',
    ),
  )

  // Keep the iframe mounted in source mode (hidden): toggling back must not
  // reload the document and lose its scripts / scroll position.
  const frameNode = h(
    'div',
    { className: 'mdr-html-render', style: mode === 'render' ? undefined : { display: 'none' } },
    frameSrc
      ? h('iframe', {
          className: 'mdr-html-frame',
          src: frameSrc,
          sandbox: 'allow-scripts allow-modals allow-popups allow-top-navigation-by-user-activation',
          title: 'HTML 渲染预览',
          onLoad: () => setFrameLoaded(true),
        })
      : h('div', { className: 'mdr-html-state' }, '无法预览：缺少文件路径'),
    mode === 'render' && !frameLoaded ? h('div', { className: 'mdr-html-frame-note' }, '正在渲染预览…') : null,
  )

  let sourceNode = null
  if (mode === 'source') {
    if (sourceError) {
      sourceNode = h(
        'div',
        { className: 'mdr-html-state mdr-html-state-err' },
        h('div', null, `读取 HTML 源码失败：${sourceError}`),
        h(
          'button',
          { type: 'button', className: 'mdr-btn', onClick: () => setRetryNonce((value) => value + 1) },
          '重试',
        ),
      )
    } else if (sourceReady) {
      sourceNode = h(HtmlSourceView, { content: sourceContent, lang, hitLine: line })
    } else {
      sourceNode = h(
        'div',
        { className: 'mdr-html-state' },
        remote.status === 'loading' ? '正在读取 HTML 源码…' : '正在准备源码视图…',
      )
    }
  }

  return h(
    'div',
    { className: 'mdr-html' },
    h('style', { dangerouslySetInnerHTML: { __html: HTML_TAB_CSS } }),
    head,
    tabError ? h('div', { className: 'mdr-html-note' }, tabError) : null,
    h('div', { className: 'mdr-html-body' }, frameNode, sourceNode),
  )
}

function ImageView(props) {
  const { tab, onLocate } = props || {}
  const path = String((tab && tab.path) || '')
  const name = path.split('/').pop() || path || '图片'
  const [zoomed, setZoomed] = React.useState(false)
  const [size, setSize] = React.useState(null)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  const stageRef = React.useRef(null)
  const srcBase = path ? `${ROUTE}/api/raw?path=${encodeURIComponent(path)}` : ''
  const src = srcBase && retry > 0 ? `${srcBase}&_retry=${retry}` : srcBase
  const locate = typeof onLocate === 'function' ? () => onLocate(path) : null

  React.useEffect(() => {
    // A new file gets a clean fit / error state.
    setZoomed(false)
    setSize(null)
    setError('')
  }, [path])

  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (zoomed) {
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)
    } else {
      stage.scrollLeft = 0
      stage.scrollTop = 0
    }
  }, [zoomed])

  const onImageLoad = (event) => {
    setError('')
    const image = event && event.target
    if (!image) return
    const width = Number(image.naturalWidth) || 0
    const height = Number(image.naturalHeight) || 0
    setSize(width && height ? [width, height] : null)
    // SVG exported with width="100%" lays out at 0×0 inside an <img>: force the
    // intrinsic size as a fallback (max-width/height still constrain it in fit mode).
    if (width && height && (!image.clientWidth || !image.clientHeight)) {
      image.style.width = `${width}px`
      image.style.height = `${height}px`
    }
  }
  const onImageError = () => {
    setSize(null)
    setError('图片加载失败：无法读取该文件（可能不是受支持的图片格式）')
  }

  const head = h(
    'div',
    { className: 'mdr-image-head' },
    h('span', { className: 'mdr-image-icon' }, h(Icons.image, { size: 14 })),
    h('span', { className: 'mdr-image-name', title: path }, path || '（未选择图片）'),
    size ? h('span', { className: 'mdr-image-dims' }, `${size[0]}×${size[1]} px`) : null,
    h('span', { className: 'mdr-spacer' }),
    h('span', { className: 'mdr-image-hint' }, zoomed ? '点击图片还原为适应窗口' : '点击图片放大到 100%'),
    locate
      ? h('button', { type: 'button', className: 'mdr-btn', onClick: locate, title: '在左侧目录树中定位本文件' }, '定位')
      : null,
  )

  return h(
    'div',
    { className: 'mdr-image' },
    h('style', { dangerouslySetInnerHTML: { __html: IMAGE_TAB_CSS } }),
    head,
    h(
      'div',
      { className: 'mdr-image-stage' + (zoomed ? ' mdr-image-zoomed' : ''), ref: stageRef },
      h(
        'div',
        { className: 'mdr-image-wrap' },
        src
          ? h('img', {
              key: retry,
              className: 'mdr-image-img',
              src,
              alt: name,
              title: '点击切换 适应窗口 / 100% 原尺寸',
              draggable: false,
              onLoad: onImageLoad,
              onError: onImageError,
              onClick: () => setZoomed((value) => !value),
            })
          : null,
      ),
      error
        ? h(
            'div',
            { className: 'mdr-image-error' },
            h('div', null, error),
            h('div', { className: 'mdr-image-error-path' }, path),
            h(
              'button',
              {
                type: 'button',
                className: 'mdr-btn',
                onClick: () => {
                  setError('')
                  setRetry((value) => value + 1)
                },
              },
              '重试',
            ),
          )
        : null,
    ),
  )
}
