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
/**
 * How far the rendered block is KEPT.
 *
 * A rendered diff block is ~50 DOM rows; a review document has 44 of them, so
 * scrolling through the whole document builds the same ~24k nodes as before and
 * the GPU starts compositing that huge tree (the machine stutters). So a block
 * that scrolls far away is RELEASED again - back to its placeholder - and is
 * restored from the cache (instantly) when it comes back.
 */
const LAZY_KEEP_MARGIN = '300% 0px'
/**
 * The rendered height of ONE line, per kind.
 *
 * The placeholder reserves the height of the block it stands in for, so the
 * estimate has to match the RENDERED height exactly - otherwise the document
 * height changes when the block renders, and at the bottom of the document
 * that moves the page (the scroll position is clamped there).
 *
 * - code: `.mdr-md-code` is font-size 12.5px with line-height 1.55 → 19.375px
 * - diff: every row is a `.mdr-cl` with min-height/line-height 20px → 20px
 */
const LAZY_CODE_LINE_HEIGHT = 19.375
const LAZY_DIFF_ROW_HEIGHT = 20
/** A code block with more lines than this is rendered lazily. */
const LAZY_CODE_MIN_LINES = 30

/** container -> { observer, left } */
const lazyFenceRecs = new Map()
/** element -> { el, source, kind, lang, height } */
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

/**
 * The box "chrome" of a fence block: padding + border.
 *
 * `getBoundingClientRect().height` and `offsetHeight` are BORDER-box heights,
 * while `style.height` (and `style.min-height`) are CONTENT-box heights for
 * these blocks. Writing a border-box number back as a content-box height
 * makes the released placeholder TALLER than the rendered block by exactly
 * its padding (+ border) - 24 px for a code block.
 *
 * That 24 px is the whole bug behind 「拉到最底下页面会上下抖动，看起来像有
 * 东西反复加载卸载」: every release/render cycle changed the document height,
 * so the scroll position (clamped at the bottom) moved, and the block was
 * pushed across the observer's keep band, which released it again - release,
 * render, release, render ...
 */
function lazyFenceChrome(el) {
  try {
    const style = window.getComputedStyle(el)
    return (
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0)
    )
  } catch {
    return 0
  }
}

/**
 * Keep the view stable when a lazy block changes its height.
 *
 * At the bottom of a document the scroll position is CLAMPED to the document
 * height, so any height change - even below the viewport - moves the whole
 * page. While the user sits at the bottom, the bottom stays at the bottom.
 *
 * THE MEASUREMENT MUST HAPPEN BEFORE THE CHANGE: the caller drops the
 * reserved height right before the swap, and a document that is (for a moment)
 * SHORTER than the scroll position reads as "the user is at the bottom" - the
 * block was then pinned to the bottom and the user was thrown back down
 * (user: 「划到最底部然后向上滚动，为什么会不断回弹」, 2026-11-20: the throw
 * was ~600 px and it repeated on every observer tick).
 */
function lazyFenceKeepBottom(el, apply) {
  const scroller = el && el.closest ? el.closest('.mdr-content') : null
  if (!scroller) {
    apply()
    return
  }
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const atBottom = max - scroller.scrollTop <= 2
  apply()
  if (!atBottom) return
  const after = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  if (Math.abs(scroller.scrollTop - after) > 0.5) scroller.scrollTop = after
}

/**
 * Release a rendered block: back to the placeholder, keeping the EXACT height
 * so the scroll position does not jump.
 */
function lazyFenceRelease(entry) {
  const el = entry && entry.el
  if (!el || !el.isConnected) return
  if (!el.classList.contains('mdr-md-diff-pending') && !el.classList.contains('mdr-md-code-pending')) {
    // It is rendered: remember its height and empty it.
    let height = entry.height || 0
    const chrome = lazyFenceChrome(el)
    try {
      height = el.getBoundingClientRect().height || height
    } catch {
      /* ignore */
    }
    entry.height = height
    lazyFenceKeepBottom(el, () => {
      el.classList.add(entry.kind === 'diff' ? 'mdr-md-diff-pending' : 'mdr-md-code-pending')
      el.innerHTML = ''
      // Keep the note: a released block that is an empty hole reads as a
      // rendering glitch, the note reads as "it is still loading".
      const note = document.createElement('span')
      note.className = entry.kind === 'diff' ? 'mdr-md-diff-note' : 'mdr-md-code-note'
      note.textContent =
        entry.kind === 'diff' ? '▦ diff 块 · 滚动到可见时渲染' : '▦ 代码块 · 滚动到可见时渲染'
      el.appendChild(note)
      // The first placeholder reserved an ESTIMATED height (min-height); drop
      // it, otherwise it would win over the exact height written here.
      el.style.minHeight = ''
      // Border-box measured -> content-box written, so the placeholder ends
      // up exactly as tall as the block it replaces.
      const content = height ? Math.max(0, height - chrome) : 0
      if (content) el.style.height = `${content}px`
    })
  }
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
  } catch (error) {
    html = escapeHtml(source)
    // A silent empty block is the worst possible failure mode: say what broke.
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[markdown-reader] fence render failed:', error)
    }
  }
  // The whole visual swap (class + content + the reserved height) happens
  // INSIDE the pinned section: the document height must not change before
  // `lazyFenceKeepBottom` measured whether the user sits at the bottom (the
  // reserved height dropped outside would shrink the document for a moment and
  // the user would be thrown back to the bottom - 「不断回弹」).
  lazyFenceKeepBottom(el, () => {
    // Drop the reserved placeholder height first: the real content decides the
    // height now, and the exact height is measured afterwards.
    el.style.minHeight = ''
    el.style.height = ''
    el.classList.remove('mdr-md-diff-pending')
    el.classList.remove('mdr-md-code-pending')
    el.innerHTML = html
  })
  try {
    entry.height = el.getBoundingClientRect().height || entry.height || 0
  } catch {
    /* ignore */
  }
}

/**
 * The number of ROWS the rendered block will have.
 *
 * The placeholder reserves the height of the block it stands in for, so the
 * count has to match the RENDERED block exactly - otherwise the document
 * height changes when the block renders, and at the bottom of the document
 * that moves the page (the scroll position is clamped there).
 *
 * - a diff fence renders one row per diff row (`parseDiffFenceRows`), and the
 *   trailing newline of the patch is NOT a row (it would be a phantom row);
 * - a code fence renders one line box per line of the source, and a source
 *   that ends with a newline has NO extra empty line box (the trailing
 *   newline terminates the last line).
 *
 * Counting the source lines was one row too many for both kinds (the real
 * documents end their fences with a newline): the block was 20 px taller than
 * the block it replaced, and every render moved the document.
 */
function lazyFenceRowCount(source, kind) {
  const text = String(source == null ? '' : source)
  if (kind === 'diff') {
    if (typeof parseDiffFenceRows === 'function') {
      try {
        return parseDiffFenceRows(text).length
      } catch {
        /* fall through to the estimate */
      }
    }
  }
  if (!text) return 1
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/**
 * The placeholder for a fenced block: the note plus a reserved height, so the
 * document height (and therefore the scrollbar) is already correct.
 *
 * The reserved height is the CONTENT height (min-height is a content-box
 * length): the block's own padding and border are added on top of it, exactly
 * as they are on the rendered block.
 */
function lazyFencePlaceholder(source, kind) {
  const el = document.createElement('div')
  const isDiff = kind === 'diff'
  el.className = isDiff ? 'mdr-md-diff mdr-md-diff-pending' : 'mdr-md-code mdr-md-code-pending'
  const rows = lazyFenceRowCount(source, kind)
  const line = isDiff ? LAZY_DIFF_ROW_HEIGHT : LAZY_CODE_LINE_HEIGHT
  const height = Math.max(60, rows * line)
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
          const el = change.target
          const entry = lazyFencePending.get(el)
          if (!entry) continue
          if (change.isIntersecting) {
            // Inside the keep band: render it (from the cache -> instant).
            lazyFenceRender(entry)
          } else {
            // Far away: release the DOM again, the document stays small.
            lazyFenceRelease(entry)
          }
        }
      },
      { root: scroller || null, rootMargin: LAZY_KEEP_MARGIN, threshold: 0 },
    )
    lazyFenceRecs.set(container, rec)
    for (const entry of waiting) {
      lazyFencePending.set(entry.el, entry)
      rec.observer.observe(entry.el)
    }
    // The blocks that were rendered right away are observed as well, so they
    // are released too when they scroll away.
    for (const entry of near) {
      lazyFencePending.set(entry.el, entry)
      rec.observer.observe(entry.el)
    }
    rec.left = 0
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
