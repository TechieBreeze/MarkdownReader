/**
 * Compare our plugin's repo-view link resolution with the ORIGINAL reader's
 * /api/git/resolve for every GitLab/GitHub blob link found in workspace docs.
 *
 * Usage: node work/compare-link-resolve.mjs
 *   original reader on http://127.0.0.1:8790  (root = 微服务)
 *   plugin Host      on http://127.0.0.1:57377 (multi-root with vtop prefixes)
 */
import fs from 'node:fs'
import path from 'node:path'

const ORIGIN = 'http://127.0.0.1:8790'
const PLUGIN = 'http://127.0.0.1:57377/markdown-reader'
const ROOT = 'C:/Users/1/Desktop/work/tasks/20260917-微服务'
const BLOB_RE = /https?:\/\/[^\s)\]"'<>]+?\/(?:\-\/)?blob\/[^\s)\]"'<>]+/g

function walk(dir, depth, out) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, depth + 1, out)
      continue
    }
    if (!/\.(md|markdown)$/i.test(entry.name)) continue
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
    const links = text.match(BLOB_RE) || []
    if (links.length) out.push({ doc: rel, links })
  }
}

async function batchResolve(base, us, docRel) {
  const params = new URLSearchParams()
  for (const url of us) params.append('url', url)
  if (docRel) params.set('path', docRel)
  const response = await fetch(`${base}/api/git/resolve?${params}`)
  if (!response.ok) return {}
  const payload = await response.json()
  return payload.resolved || {}
}

async function main() {
  const docs = []
  for (const sub of ['gits/ckdocs', 'docs', 'gits']) walk(path.join(ROOT, sub), 0, docs)
  const seen = new Set()
  const cases = []
  for (const { doc, links } of docs) {
    for (const url of links) {
      const key = `${doc}\u0000${url}`
      if (seen.has(key)) continue
      seen.add(key)
      cases.push({ doc, url })
    }
  }
  console.log(`docs=${docs.length} unique(doc,url)=${cases.length}`)
  const grouped = new Map()
  for (const item of cases) {
    if (!grouped.has(item.doc)) grouped.set(item.doc, [])
    grouped.get(item.doc).push(item.url)
  }
  let total = 0
  let both = 0
  let onlyOriginal = 0
  let onlyPlugin = 0
  let neither = 0
  const mismatches = []
  for (const [doc, urls] of grouped) {
    const original = await batchResolve(ORIGIN, urls, doc)
    const plugin = await batchResolve(PLUGIN, urls, `20260917-微服务/${doc}`)
    for (const url of urls) {
      total += 1
      const a = original[url]
      const b = plugin[url]
      if (a && b) both += 1
      else if (a && !b) {
        onlyOriginal += 1
        if (mismatches.length < 15) mismatches.push({ kind: 'original-only', doc, url, original: a })
      } else if (!a && b) {
        onlyPlugin += 1
        if (mismatches.length < 15) mismatches.push({ kind: 'plugin-only', doc, url, plugin: b })
      } else {
        neither += 1
      }
    }
    if (total >= 120) break
  }
  console.log({ total, both, onlyOriginal, onlyPlugin, neither })
  for (const item of mismatches) console.log(JSON.stringify(item))
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exitCode = 1
})
