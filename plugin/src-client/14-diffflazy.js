/**
 * Lazy fenced blocks (```diff and big code blocks).
 *
 * A ```diff block costs TWO highlight.js passes (the OLD side and the NEW side
 * are highlighted as separate blocks so multi-line comments/strings keep their
 * colours) and it produces one DOM row per line. The codereview document has
 * 44 diff blocks = 2346 rows ≈ 24k DOM nodes, and rendering them all up front
 * froze the whole Harness window for ~2.4 s EVERY time the document was opened
 * ("每次打开那个文件都会卡，而且是电脑卡" - the mouse stuttered too, because the
 * GPU process was compositing that huge tree).
 *
 * So a fenced block starts as a PLACEHOLDER with a reserved height and is
 * rendered when it approaches the viewport - the same trick the mermaid slice
 * already uses for diagrams. The blocks that are already in view are rendered
 * immediately, so the user never sees a placeholder where the content belongs.
 * The rendered HTML is cached by content, so a block that was already rendered
 * comes back instantly.
 */

/** How far ahead of the viewport a block is rendered. */
const LAZY_FENCE_MARGIN = '900px'
/** One code line is about this tall. */
const LAZY_LINE_HEIGHT = 19
/** A code block with more lines than this is rendered lazily. */
const LAZY_CODE_MIN_LINES = 30

/** container -> { observer, left } */
const lazyFenceRecs = new Map()
/** element -> { el, source, kind, lang } */
const lazyFencePending = new Map()

function lazyFenceStop(rec) {
  if (!rec) return
  try {
    if (rec.observer) rec.observer.disconnect()
  } catch {
    /* already gone */
  }
  lazyFenceRecs.delete(rec.container)
  rec.left = 0
}

/** Render one fenced block into its placeholder. */
function lazyFenceRender(entry) {
  const el = entry && entry.el
  if (!el || !el.isConnected) return
  const source = entry.source || ''
  const kind = entry.kind === 'diff' ? 'diff' : 'code'
  let html = ''
  try {
    if (kind === 'diff') {
      html =
        typeof cachedFenceHtml === 'function'
          ? cachedFenceHtml('diff', source, () =>
              typeof renderDiffFenceHtml === 'function' ? renderDiffFenceHtml(source) : escapeHtml(source),
            )
          : typeof renderDiffFenceHtml === 'function'
            ? renderDiffFenceHtml(source)
            : escapeHtml(source)
    } else {
      const lang = entry.lang || ''
      html =
        typeof cachedFenceHtml === 'function'
          ? cachedFenceHtml(`code:${lang}`, source, () =>
              typeof renderFenceCodeHtml === 'function' ? renderFenceCodeHtml(source, lang) : escapeHtml(source),
            )
          : typeof renderFenceCodeHtml === 'function'
            ? renderFenceCodeHtml(source, lang)
            : escapeHtml(source)
    }
  } catch {
    html = escapeHtml(source)
  }
  el.classList.remove('mdr-md-diff-pending')
  el.innerHTML = html
}

/**
 * The placeholder for a fenced block: the note plus a reserved height, so the
 * document height (and therefore the scrollbar) is already correct.
 */
function lazyFencePlaceholder(source, kind) {
  const el = document.createElement('div')
  const isDiff = kind === 'diff'
  el.className = isDiff ? 'mdr-md-diff mdr-md-diff-pending' : 'mdr-md-code mdr-md-code-pending'
  const rows = String(source || '').split('\n').length
  const height = Math.max(60, rows * LAZY_LINE_HEIGHT + 24)
  el.style.minHeight = `${height}px`
  const note = document.createElement('span')
  note.className = isDiff ? 'mdr-md-diff-note' : 'mdr-md-code-note'
  note.textContent = isDiff ? '▦ diff 块 · 滚动到可见时渲染' : '▦ 代码块 · 滚动到可见时渲染'
  el.appendChild(note)
  return el
}

/** The diff flavour of the placeholder (kept for the call sites). */
function diffLazyPlaceholder(source) {
  return lazyFencePlaceholder(source, 'diff')
}

/**
 * Wire the placeholders of one document to the viewport.
 *
 * @param {Element} container  the rendered markdown
 * @param {Array} entries      [{ el, source, kind, lang }]
 */
function enhanceLazyFences(container, entries) {
  try {
    if (!container || !entries || !entries.length) return
    const scroller = container.closest ? container.closest('.mdr-content') : null
    const viewport = window.innerHeight || 800
    const margin = parseFloat(LAZY_FENCE_MARGIN) || 0
    // The blocks that are already near the viewport are rendered RIGHT AWAY:
    // the user must not see a placeholder where the content belongs. The rects
    // are read in one pass (the first read forces the layout, the rest are
    // cheap because nothing changed in between).
    const near = []
    const waiting = []
    for (const entry of entries) {
      const el = entry && entry.el
      if (!el) continue
      let rect = null
      try {
        rect = el.getBoundingClientRect()
      } catch {
        rect = null
      }
      if (rect && rect.top < viewport + margin && rect.bottom > -margin) near.push(entry)
      else waiting.push(entry)
    }
    for (const entry of near) lazyFenceRender(entry)
    if (!waiting.length) return

    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      // No observer: render everything (the old behaviour).
      for (const entry of waiting) lazyFenceRender(entry)
      return
    }
    const rec = { container, left: waiting.length, observer: null }
    rec.observer = new window.IntersectionObserver(
      (changes) => {
        if (!rec.container || !rec.container.isConnected) {
          lazyFenceStop(rec)
          return
        }
        for (const change of changes) {
          if (!change.isIntersecting) continue
          const el = change.target
          const entry = lazyFencePending.get(el)
          lazyFencePending.delete(el)
          try {
            rec.observer.unobserve(el)
          } catch {
            /* already unobserved */
          }
          rec.left = Math.max(0, rec.left - 1)
          if (entry) lazyFenceRender(entry)
        }
        if (rec.left <= 0) lazyFenceStop(rec)
      },
      { root: scroller || null, rootMargin: LAZY_FENCE_MARGIN, threshold: 0 },
    )
    lazyFenceRecs.set(container, rec)
    for (const entry of waiting) {
      lazyFencePending.set(entry.el, entry)
      rec.observer.observe(entry.el)
    }
  } catch (err) {
    if (typeof window !== 'undefined' && window.console && window.console.warn) {
      window.console.warn('[markdown-reader] lazy fences:', err)
    }
  }
}

/** The diff flavour of the wiring (kept for the call sites). */
function enhanceDiffFences(container, entries) {
  enhanceLazyFences(container, entries)
}

/** Stop the lazy rendering of a container (its view was replaced). */
function stopDiffFences(container) {
  const rec = lazyFenceRecs.get(container)
  if (rec) lazyFenceStop(rec)
}
