/**
 * HTML preview served inside the reader's iframe tab.
 *
 * The iframe needs a real URL (a srcdoc document resolves `#anchor` against the
 * reader page and nests the app). Relative resources cannot rely on a `<base>`
 * pointing at the raw proxy, because resolving a relative URL against a
 * query-based URL drops the query — so they are rewritten to absolute
 * `<prefix>/api/raw?path=<rel>` URLs here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROUTE } from './constants.js'

function joinRel(dirRel, target) {
  const parts = String(dirRel || '').split('/').filter(Boolean)
  for (const part of String(target || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Inline `<script>` bodies must never be rewritten.
 *
 * The resource rewrite below works on raw text, so it also hits JavaScript:
 * `url(...)` in minified code (`getDataURL(t)`, `new URL(...)`) and `src=` /
 * `href=` inside string literals were turned into `/api/raw?path=…`, which
 * broke the inline library (a self-contained page with an inlined ECharts build
 * then died with `echarts missing` + a SyntaxError and painted zero charts).
 *
 * The script bodies are masked out before the rewrite and restored afterwards;
 * the `<script>` OPENING tag is still rewritten, so `<script src="app.js">`
 * keeps working.
 */
const SCRIPT_MASK_PREFIX = '\u0000mdrScript'
const SCRIPT_MASK_SUFFIX = '\u0000'

function maskScripts(html) {
  const blocks = []
  const masked = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (match, open, body, close) => {
    blocks.push(body)
    return `${open}${SCRIPT_MASK_PREFIX}${blocks.length - 1}${SCRIPT_MASK_SUFFIX}${close}`
  })
  return { masked, blocks }
}

function unmaskScripts(html, blocks) {
  if (!blocks.length) return html
  const pattern = new RegExp(`${SCRIPT_MASK_PREFIX}(\\d+)${SCRIPT_MASK_SUFFIX}`, 'g')
  return html.replace(pattern, (match, index) => (blocks[Number(index)] == null ? match : blocks[Number(index)]))
}

export function renderHtmlPreview(state, rel) {
  const input = String(rel || '')
  if (!input) throw new Error('缺少 path')
  const abs = state.safePath(input)
  if (!/\.html?$/i.test(abs)) {
    const error = new Error('不是 HTML 文件')
    error.status = 415
    throw error
  }
  const raw = fs.readFileSync(abs, 'utf8')
  const displayRel = state.relOf(abs)
  const dirRel = path.posix.dirname(displayRel.replace(/\\/g, '/')).replace(/^\.$/, '')
  const multi = !state.single()
  const rootName = multi ? String(displayRel).split('/')[0] : ''

  const resolveTarget = (target, forHref) => {
    const value = String(target || '').trim()
    if (!value) return value
    if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/|#)/i.test(value)) return value
    let work = value
    let frag = ''
    let query = ''
    const hi = work.indexOf('#')
    if (hi >= 0) {
      frag = work.slice(hi)
      work = work.slice(0, hi)
    }
    const qi = work.indexOf('?')
    if (qi >= 0) {
      query = work.slice(qi + 1)
      work = work.slice(0, qi)
    }
    if (!work) return frag
    let resolved
    if (work.startsWith('/')) {
      const clean = work.replace(/^\/+/, '')
      const first = clean.split('/')[0]
      resolved = multi && !state.roots().some((root) => root.name === first) ? `${rootName}/${clean}` : clean
    } else {
      resolved = joinRel(dirRel, work)
    }
    const isHtmlTarget = /\.html?$/i.test(resolved)
    if (forHref && isHtmlTarget) {
      return `${ROUTE}/api/html?path=${encodeURIComponent(resolved)}${query ? `&${query}` : ''}${frag}`
    }
    return `${ROUTE}/api/raw?path=${encodeURIComponent(resolved)}${query ? `&${query}` : ''}${frag}`
  }

  const { masked, blocks } = maskScripts(raw)
  let html = masked.replace(/<base\b[^>]*>/gi, '')
  html = html.replace(/(\b(src|href|poster|data-src)\s*=\s*)(["'])([\s\S]*?)\3/gi, (match, prefix, attr, quote, url) => {
    return `${prefix}${quote}${resolveTarget(url, String(attr).toLowerCase() === 'href')}${quote}`
  })
  html = html.replace(/(\bsrcset\s*=\s*)(["'])([\s\S]*?)\2/gi, (match, prefix, quote, value) => {
    const rewritten = value
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim()
        if (!trimmed) return trimmed
        const spaceAt = trimmed.search(/\s/)
        if (spaceAt < 0) return resolveTarget(trimmed)
        return `${resolveTarget(trimmed.slice(0, spaceAt))}${trimmed.slice(spaceAt)}`
      })
      .join(', ')
    return `${prefix}${quote}${rewritten}${quote}`
  })
  html = html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, url) => `url(${quote}${resolveTarget(url)}${quote})`)
  if (!/<meta[^>]+charset/i.test(html)) {
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}\n<meta charset="utf-8">`)
      : `<meta charset="utf-8">\n${html}`
  }
  return unmaskScripts(html, blocks)
}
