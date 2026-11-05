/**
 * HTML preview rewriting contract (regression).
 *
 * The Host rewrites relative resources (src / href / srcset / url(...)) so a
 * previewed page can load files next to it. The rewrite works on raw text, so
 * it MUST NOT touch inline <script> bodies: a self-contained page with an
 * inlined chart library used to die with `echarts missing` + SyntaxError and
 * painted zero charts (the `url(...)` rule rewrote `getDataURL(t)` inside the
 * minified library).
 *
 * Checks:
 *  1. synthetic document: script body byte-identical, img/css rewritten
 *  2. real workspace documents: every script body byte-identical
 *
 * Usage:
 *   HOST_BASE=http://127.0.0.1:8799/markdown-reader node work/harnesses/html-preview-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const HOST_BASE = process.env.HOST_BASE || 'http://127.0.0.1:8799/markdown-reader'
const DOC_ROOT = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs'

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

function scriptBodies(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1])
}

/** Client-visible path of an absolute file, derived from the Host's own roots. */
const meta = await (await fetch(`${HOST_BASE}/api/meta`)).json()
const roots = (meta && meta.roots) || []
function relFor(abs) {
  const normalized = path.resolve(abs)
  for (const root of roots) {
    const base = path.resolve(root.path)
    if (normalized === base || normalized.startsWith(base + path.sep)) {
      const rel = path.relative(base, normalized).replace(/\\/g, '/')
      return meta.single ? rel : `${root.name}/${rel}`
    }
  }
  throw new Error(`file is outside every configured root: ${abs}`)
}

console.log(`host: ${HOST_BASE}`)
console.log(`roots: ${roots.map((root) => root.name).join(', ') || '(none)'}`)

// ---------------------------------------------------------------- synthetic
const synthetic = [
  '<!doctype html><html><head><style>.a{background:url(bg.png)}</style></head><body>',
  '<img src="pic.png"><a href="other.html">next</a>',
  '<script>var api = { getDataURL: function (t) { return "url(data:image/png;base64," + t + ")" } };',
  'var s = "src=\\"x.png\\""; var u = new URL("http://x/y", location.href);</script>',
  '</body></html>',
].join('\n')

// The probe file lives in THIS task directory (never in the user's documents).
const syntheticAbs = path.join(ROOT, 'work', '.html-preview-check.html')
fs.writeFileSync(syntheticAbs, synthetic, 'utf8')
try {
  const rel = relFor(syntheticAbs)
  const response = await fetch(`${HOST_BASE}/api/html?path=${encodeURIComponent(rel)}`)
  const preview = await response.text()
  const originalBodies = scriptBodies(synthetic)
  const previewBodies = scriptBodies(preview)
  console.log('\n[1] synthetic document')
  check('preview served', response.status === 200, response.status)
  check('script body preserved byte-for-byte', previewBodies[0] === originalBodies[0], previewBodies[0]?.slice(0, 80))
  check('relative img rewritten', /\/api\/raw\?path=/.test(preview) && !/src="pic\.png"/.test(preview))
  check('relative html link rewritten to the preview endpoint', /\/api\/html\?path=/.test(preview))
  check('css url() rewritten', /url\([^)]*\/api\/raw\?path=/.test(preview))
} finally {
  fs.rmSync(syntheticAbs, { force: true })
}

// ------------------------------------------------------------------- real
const REAL = ['公众号身份重复门店8888-stage数据全景.html']
console.log('\n[2] real workspace documents')
for (const name of REAL) {
  const abs = path.join(DOC_ROOT, name)
  if (!fs.existsSync(abs)) {
    check(`${name} exists`, false, abs)
    continue
  }
  const original = fs.readFileSync(abs, 'utf8')
  const rel = relFor(abs)
  const response = await fetch(`${HOST_BASE}/api/html?path=${encodeURIComponent(rel)}`)
  const preview = await response.text()
  const originalBodies = scriptBodies(original)
  const previewBodies = scriptBodies(preview)
  check(`${name}: served`, response.status === 200, response.status)
  check(
    `${name}: all ${originalBodies.length} script bodies preserved byte-for-byte`,
    originalBodies.length === previewBodies.length && originalBodies.every((body, index) => body === previewBodies[index]),
    previewBodies.map((body) => body.length).join(','),
  )
  check(`${name}: chart library intact (getDataURL)`, preview.includes('getDataURL'))
  check(`${name}: no rewritten url() inside scripts`, !/\/api\/raw\?path=[^"')]*\)/.test(previewBodies.join('')))
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall html preview checks passed')
if (failures) process.exitCode = 1
