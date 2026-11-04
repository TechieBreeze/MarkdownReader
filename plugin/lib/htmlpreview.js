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

  const resolveTarget = (target) => {
    const value = String(target || '').trim()
    if (!value) return value
    if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/)/i.test(value)) return value
    if (value.startsWith('#')) return value
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
    return `${ROUTE}/api/raw?path=${encodeURIComponent(resolved)}${query ? `&${query}` : ''}${frag}`
  }

  let html = raw.replace(/<base\b[^>]*>/gi, '')
  html = html.replace(/(\b(?:src|href|poster|data-src)\s*=\s*)(["'])([\s\S]*?)\2/gi, (match, prefix, quote, url) => {
    return `${prefix}${quote}${resolveTarget(url)}${quote}`
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
  return html
}
