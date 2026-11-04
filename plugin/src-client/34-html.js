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
 *     · one <img> (src derived only from tab.path — never replaced on click)
 *       centered on a checkered stage, letterboxed to fit by default.
 *     · gestures: click toggles 适应 ↔ 100%, wheel / Ctrl+wheel zooms in steps
 *       (25%–400% of fit, anchored at the cursor), double-click resets to fit,
 *       drag pans when the zoomed image overflows; a % badge shows the scale.
 *     · zoom + scroll are remembered on tab (imgScale/scrollLeft/scrollTop, plus
 *       a module cache) so switching tabs and back keeps the view; error state
 *       with retry; header shows filename (path tooltip) + natural size.
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

/** Padding around the image inside the stage; the fit math below assumes it. */
const IMAGE_PAD = 20
/** Zoom factor is relative to the fit size (1 = fit); gestures clamp to this. */
const IMAGE_MIN_ZOOM = 0.25
const IMAGE_MAX_ZOOM = 4
/** One wheel notch multiplies the current zoom by this factor. */
const IMAGE_WHEEL_STEP = 1.2
/** First-paint fallback when the stage cannot be measured yet. */
const IMAGE_FALLBACK_VIEWPORT = { width: 960, height: 640 }
/** zoom/scroll memory keyed by tab id, so tab switches keep the view. */
const imageViewStateCache = new Map()

const IMAGE_TAB_CSS = `
.mdr-image{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.mdr-image-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;row-gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.mdr-image-icon{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-brand-primary)}
.mdr-image-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.mdr-image-dims{flex:0 0 auto;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.mdr-image-zoom{flex:0 0 auto;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.mdr-image-hint{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.mdr-image-stage{position:relative;display:flex;flex:1;min-height:0;overflow:auto;padding:${IMAGE_PAD}px;box-sizing:border-box;background-color:#1e1e1e;background-image:linear-gradient(45deg,#262626 25%,transparent 25%),linear-gradient(-45deg,#262626 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#262626 75%),linear-gradient(-45deg,transparent 75%,#262626 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
.mdr-image-wrap{display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin:auto}
.mdr-image-img{display:block;max-width:100%;max-height:100%;border-radius:6px;user-select:none;-webkit-user-drag:none;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 8px 30px rgba(0,0,0,.45)}
.mdr-image-img-sized{max-width:none;max-height:none}
.mdr-image-pannable .mdr-image-img{cursor:grab}
.mdr-image-dragging,.mdr-image-dragging .mdr-image-img{cursor:grabbing;user-select:none}
.mdr-image-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.mdr-image-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary);font-size:12.5px;text-align:center}
.mdr-image-error-path{color:var(--dsw-alias-label-secondary);font-size:11.5px;word-break:break-all}
`

/* --------------------------------------------------- image view math ---- */

/** Clamp a zoom factor (relative to fit) into the supported gesture range. */
function imageClampZoom(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 1
  return Math.min(IMAGE_MAX_ZOOM, Math.max(IMAGE_MIN_ZOOM, number))
}

/** One wheel notch in (`direction` > 0) or out, clamped to the range. */
function imageStepZoom(zoom, direction) {
  const base = imageClampZoom(zoom)
  return imageClampZoom(direction > 0 ? base * IMAGE_WHEEL_STEP : base / IMAGE_WHEEL_STEP)
}

/**
 * Scale that makes the natural size fit the stage content box. Never upscales
 * beyond 100% (same as the original `max-width/max-height` behaviour).
 */
function imageFitScale(naturalWidth, naturalHeight, viewWidth, viewHeight, padding) {
  const width = Number(naturalWidth) || 0
  const height = Number(naturalHeight) || 0
  const pad = Math.max(0, Number(padding) || 0)
  const availableWidth = (Number(viewWidth) || 0) - pad * 2
  const availableHeight = (Number(viewHeight) || 0) - pad * 2
  if (!(width > 0) || !(height > 0) || !(availableWidth > 0) || !(availableHeight > 0)) return 1
  return Math.min(1, availableWidth / width, availableHeight / height)
}

/** Explicit rendered size for the current zoom; null until the natural size is known. */
function imageDisplaySize(naturalWidth, naturalHeight, fitScale, zoom) {
  const width = Number(naturalWidth) || 0
  const height = Number(naturalHeight) || 0
  if (!(width > 0) || !(height > 0)) return null
  const scale = (Number(fitScale) || 1) * imageClampZoom(zoom)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Header percentage: displayed size relative to the natural pixels. */
function imageZoomPercent(zoom, fitScale) {
  return Math.max(1, Math.round(imageClampZoom(zoom) * (Number(fitScale) || 1) * 100))
}

/** Pan scroll offsets from drag deltas (dragging right shows content to the left). */
function imagePanScroll(startLeft, startTop, deltaX, deltaY) {
  return {
    left: Math.max(0, (Number(startLeft) || 0) - (Number(deltaX) || 0)),
    top: Math.max(0, (Number(startTop) || 0) - (Number(deltaY) || 0)),
  }
}

/** Restored zoom factor for a (re)mounted image tab. */
function imageInitialZoom(tab, stateKey) {
  const cached = stateKey ? imageViewStateCache.get(stateKey) : null
  if (cached && Number.isFinite(cached.zoom)) return imageClampZoom(cached.zoom)
  const stored = tab ? Number(tab.imgScale) : NaN
  if (Number.isFinite(stored) && stored > 0) return imageClampZoom(stored)
  return 1
}

/** Legacy `tab.imgZoom` (boolean "100%") resolved once the fit scale is known. */
function imageInitialNaturalZoom(tab, stateKey) {
  const cached = stateKey ? imageViewStateCache.get(stateKey) : null
  if (cached && Number.isFinite(cached.zoom)) return false
  const stored = tab ? Number(tab.imgScale) : NaN
  if (Number.isFinite(stored) && stored > 0) return false
  return !!(tab && tab.imgZoom)
}


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
  const stateKey = tab && tab.id ? String(tab.id) : path
  const src = path ? `${ROUTE}/api/raw?path=${encodeURIComponent(path)}` : ''
  const locate = typeof onLocate === 'function' ? () => onLocate(path) : null

  const [natural, setNatural] = React.useState(null)
  const [viewport, setViewport] = React.useState(null)
  const [zoom, setZoom] = React.useState(() => imageInitialZoom(tab, stateKey))
  const [loaded, setLoaded] = React.useState(false)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const stageRef = React.useRef(null)
  const panRef = React.useRef(null)
  const panCleanupRef = React.useRef(null)
  const suppressClickRef = React.useRef(false)
  const clickTimerRef = React.useRef(0)
  const pendingScrollRef = React.useRef(null)
  const restoredRef = React.useRef(false)
  const naturalRef = React.useRef(natural)
  naturalRef.current = natural
  const zoomRef = React.useRef(zoom)
  zoomRef.current = zoom
  const viewportRef = React.useRef(viewport)
  viewportRef.current = viewport
  const legacyNaturalRef = React.useRef(imageInitialNaturalZoom(tab, stateKey))
  const applyZoomRef = React.useRef(null)

  // Wheel / pan / resize listeners must not capture stale state; the memory
  // lives on the tab (mutable, like the original) plus a module-level cache so
  // an App re-render or a tab switch cannot reset the view.
  const persistState = (nextZoom, scroll) => {
    if (!stateKey) return
    const entry = imageViewStateCache.get(stateKey) || {}
    if (Number.isFinite(nextZoom)) entry.zoom = nextZoom
    if (scroll) {
      entry.scrollLeft = scroll.left
      entry.scrollTop = scroll.top
    }
    imageViewStateCache.set(stateKey, entry)
    if (tab && typeof tab === 'object') {
      if (Number.isFinite(nextZoom)) {
        tab.imgScale = nextZoom
        tab.imgZoom = Math.abs(nextZoom - 1) > 0.001
      }
      if (scroll) {
        tab.scrollLeft = scroll.left
        tab.scrollTop = scroll.top
      }
    }
  }

  // The stage size drives the fit scale; observe it (ResizeObserver + window
  // resize) so panel resizes never leave the image at a stale size.
  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const measure = () => {
      const width = Number(stage.clientWidth) || 0
      const height = Number(stage.clientHeight) || 0
      setViewport((previous) => (previous && previous.width === width && previous.height === height ? previous : { width, height }))
    }
    measure()
    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(stage)
    }
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', measure)
    return () => {
      if (observer) observer.disconnect()
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', measure)
    }
  }, [path])

  React.useEffect(() => {
    setNatural(null)
    setLoaded(false)
    setError('')
    restoredRef.current = false
  }, [path])

  React.useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      if (panCleanupRef.current) panCleanupRef.current()
    },
    [],
  )

  const viewWidth = viewport && viewport.width > 0 ? viewport.width : IMAGE_FALLBACK_VIEWPORT.width
  const viewHeight = viewport && viewport.height > 0 ? viewport.height : IMAGE_FALLBACK_VIEWPORT.height
  const fitScale = natural ? imageFitScale(natural.width, natural.height, viewWidth, viewHeight, IMAGE_PAD) : 1
  const display = natural ? imageDisplaySize(natural.width, natural.height, fitScale, zoom) : null
  const percent = natural ? imageZoomPercent(zoom, fitScale) : 0
  const canPan = !!display && (display.width > viewWidth - IMAGE_PAD * 2 || display.height > viewHeight - IMAGE_PAD * 2)

  // Restore the previous zoom (100% legacy) and scroll once the size is known.
  React.useEffect(() => {
    if (!legacyNaturalRef.current || !natural) return
    legacyNaturalRef.current = false
    const scale = imageFitScale(natural.width, natural.height, viewWidth, viewHeight, IMAGE_PAD)
    if (scale > 0 && Math.abs(scale - 1) > 0.01 && applyZoomRef.current) applyZoomRef.current(1 / scale)
  }, [natural, viewWidth, viewHeight])

  React.useEffect(() => {
    if (restoredRef.current || !natural) return
    restoredRef.current = true
    const stage = stageRef.current
    if (!stage) return
    const cached = stateKey ? imageViewStateCache.get(stateKey) : null
    const left = cached && Number.isFinite(cached.scrollLeft) ? cached.scrollLeft : Number(tab && tab.scrollLeft) || 0
    const top = cached && Number.isFinite(cached.scrollTop) ? cached.scrollTop : Number(tab && tab.scrollTop) || 0
    if (left > 0) stage.scrollLeft = left
    if (top > 0) stage.scrollTop = top
  }, [natural, display && display.width, display && display.height, stateKey, tab])

  React.useEffect(() => {
    const stage = stageRef.current
    const pending = pendingScrollRef.current
    if (!stage || !pending) return
    pendingScrollRef.current = null
    stage.scrollLeft = pending.left
    stage.scrollTop = pending.top
  }, [zoom])

  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof stage.addEventListener !== 'function') return undefined
    const onWheel = (event) => {
      if (!naturalRef.current) return
      const delta = Number(event.deltaY) || 0
      if (!delta) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      const factor = delta < 0 ? IMAGE_WHEEL_STEP : 1 / IMAGE_WHEEL_STEP
      if (applyZoomRef.current) {
        applyZoomRef.current(imageClampZoom(zoomRef.current * factor), {
          clientX: Number(event.clientX) || 0,
          clientY: Number(event.clientY) || 0,
        })
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (typeof stage.removeEventListener === 'function') stage.removeEventListener('wheel', onWheel)
    }
  }, [path])

  /** Fit scale measured from the live stage box (falls back to the state viewport). */
  const currentFitScale = () => {
    const stage = stageRef.current
    const width = stage && stage.clientWidth ? stage.clientWidth : viewportRef.current && viewportRef.current.width ? viewportRef.current.width : IMAGE_FALLBACK_VIEWPORT.width
    const height = stage && stage.clientHeight ? stage.clientHeight : viewportRef.current && viewportRef.current.height ? viewportRef.current.height : IMAGE_FALLBACK_VIEWPORT.height
    const size = naturalRef.current
    return size ? imageFitScale(size.width, size.height, width, height, IMAGE_PAD) : 1
  }

  /** Zoom change; keeps the point under `anchor` stable, then re-applies scroll. */
  const applyZoom = (nextValue, anchor) => {
    const next = imageClampZoom(nextValue)
    const current = imageClampZoom(zoomRef.current)
    if (Math.abs(next - current) < 0.001) return
    const stage = stageRef.current
    if (anchor && stage) {
      const rect = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null
      if (rect) {
        const px = Number(anchor.clientX) - rect.left
        const py = Number(anchor.clientY) - rect.top
        const ratio = next / current
        pendingScrollRef.current = {
          left: Math.max(0, (stage.scrollLeft + px) * ratio - px),
          top: Math.max(0, (stage.scrollTop + py) * ratio - py),
        }
      }
    }
    zoomRef.current = next
    setZoom(next)
    persistState(next)
  }
  applyZoomRef.current = applyZoom

  const toggleZoom = () => {
    const base = imageClampZoom(zoomRef.current)
    if (Math.abs(base - 1) < 0.001) {
      const scale = currentFitScale()
      applyZoom(scale > 0 ? 1 / scale : 1)
    } else {
      applyZoom(1)
    }
  }

  const onImageClick = () => {
    // A drag that actually moved must not also toggle the zoom.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (clickTimerRef.current) return
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = 0
      toggleZoom()
    }, 180)
  }

  const onImageDoubleClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = 0
    }
    suppressClickRef.current = false
    applyZoom(1)
  }

  const onImageLoad = (event) => {
    setError('')
    setLoaded(true)
    const image = event && event.target
    if (!image) return
    let width = Number(image.naturalWidth) || 0
    let height = Number(image.naturalHeight) || 0
    if (!(width > 0 && height > 0)) {
      // SVG with width="100%" (mermaid exports) can report no natural size:
      // fall back to its rendered box so the layout is never 0×0.
      width = Number(image.clientWidth) || 0
      height = Number(image.clientHeight) || 0
    }
    if (!(width > 0 && height > 0)) return
    setNatural({ width, height })
    if (typeof image.style === 'object' && (!image.clientWidth || !image.clientHeight)) {
      image.style.width = `${width}px`
      image.style.height = `${height}px`
    }
  }

  const onImageError = () => {
    setLoaded(false)
    setError('图片加载失败：无法读取该文件（可能不是受支持的图片格式）')
  }

  const onStageScroll = () => {
    const stage = stageRef.current
    if (!stage) return
    persistState(undefined, { left: stage.scrollLeft || 0, top: stage.scrollTop || 0 })
  }

  const startPan = (event) => {
    const stage = stageRef.current
    if (!stage || !display) return
    if (event && event.button != null && event.button !== 0) return
    const target = event && event.target
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : ''
    if (tag === 'BUTTON' || tag === 'INPUT') return
    const overflowing = stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1
    if (!overflowing) return
    if (typeof window === 'undefined' || !window.addEventListener) return
    const pan = {
      startX: Number(event.clientX) || 0,
      startY: Number(event.clientY) || 0,
      left: stage.scrollLeft || 0,
      top: stage.scrollTop || 0,
      moved: false,
    }
    panRef.current = pan
    setDragging(true)
    const onMove = (moveEvent) => {
      const active = panRef.current
      if (!active) return
      const deltaX = (Number(moveEvent.clientX) || 0) - active.startX
      const deltaY = (Number(moveEvent.clientY) || 0) - active.startY
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) active.moved = true
      if (!active.moved) return
      if (typeof moveEvent.preventDefault === 'function') moveEvent.preventDefault()
      const next = imagePanScroll(active.left, active.top, deltaX, deltaY)
      stage.scrollLeft = next.left
      stage.scrollTop = next.top
      persistState(undefined, next)
    }
    const stop = () => {
      const active = panRef.current
      panRef.current = null
      setDragging(false)
      if (active && active.moved) suppressClickRef.current = true
      if (panCleanupRef.current === stop) panCleanupRef.current = null
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', stop)
      }
    }
    if (panCleanupRef.current) panCleanupRef.current()
    panCleanupRef.current = stop
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
  }

  const head = h(
    'div',
    { className: 'mdr-image-head' },
    h('span', { className: 'mdr-image-icon' }, h(Icons.image, { size: 14 })),
    h('span', { className: 'mdr-image-name', title: path || '（未选择图片）' }, name || '图片'),
    natural ? h('span', { className: 'mdr-image-dims' }, `${natural.width}×${natural.height} px`) : null,
    natural ? h('span', { className: 'mdr-image-zoom', title: '滚轮缩放 · 点击切换 100% · 双击还原' }, `${percent}%`) : null,
    h('span', { className: 'mdr-spacer' }),
    h('span', { className: 'mdr-image-hint' }, '滚轮缩放 · 拖动平移 · 双击还原'),
    locate
      ? h('button', { type: 'button', className: 'mdr-btn', onClick: locate, title: '在左侧目录树中定位本文件' }, '定位')
      : null,
  )

  const stageClass =
    'mdr-image-stage' + (canPan ? ' mdr-image-pannable' : '') + (dragging ? ' mdr-image-dragging' : '')

  return h(
    'div',
    { className: 'mdr-image' },
    h('style', { dangerouslySetInnerHTML: { __html: IMAGE_TAB_CSS } }),
    head,
    h(
      'div',
      { className: stageClass, ref: stageRef, onMouseDown: startPan, onScroll: onStageScroll },
      h(
        'div',
        { className: 'mdr-image-wrap' },
        src
          ? h('img', {
              key: retry,
              // The src is derived from tab.path only: zoom/pan/click NEVER
              // replaces or clears it, so the image can never blank out.
              className: 'mdr-image-img' + (display ? ' mdr-image-img-sized' : ''),
              src,
              alt: name,
              title: '点击切换 适应 / 100% · 双击还原 · 滚轮缩放 · 拖动平移',
              draggable: false,
              style: display ? { width: `${display.width}px`, height: `${display.height}px` } : undefined,
              onLoad: onImageLoad,
              onError: onImageError,
              onClick: onImageClick,
              onDoubleClick: onImageDoubleClick,
            })
          : null,
      ),
      !loaded && !error && src ? h('div', { className: 'mdr-image-loading' }, '正在加载图片…') : null,
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
