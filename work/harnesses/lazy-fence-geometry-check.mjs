/**
 * Lazy fence GEOMETRY: the document height must not change while a block is
 * rendered / released.
 *
 * The user reported: 「打开拉到最底下页面会上下抖动，看起来像有东西反复加载
 * 卸载」 (the page shakes at the bottom of the document, as if something were
 * loaded and unloaded over and over).
 *
 * Two independent causes, both checked here:
 *
 *  1. The release/render height round trip was NOT exact: the released
 *     placeholder stored the BORDER-box height (offsetHeight) and wrote it
 *     back as a CONTENT-box height (style.height) - 24 px too tall for a code
 *     block. Every cycle changed the document height, and at the bottom the
 *     scroll position is clamped to that height, so the page moved; the block
 *     was also pushed across the observer's keep band, which released it
 *     again - release, render, release, render ...
 *
 *  2. The reserved placeholder height was an estimate (rows × 19 + 24) that did
 *     not match the rendered height (rows × 19.375), so the FIRST render
 *     changed the document height as well.
 *
 * The check runs the SHIPPED client sources (00-core / 20-code / 12-mermaid /
 * 14-diffflazy / 10-markdown) plus the vendored marked + highlight.js in a
 * real browser and asserts:
 *   - the placeholder is exactly as tall as the block it replaces
 *   - releasing keeps the height, rendering again keeps the height
 *   - at the bottom of a document the scroll position and the document height
 *     do not move while the lazy blocks render
 *
 * Usage: node work/harnesses/lazy-fence-geometry-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')

let failures = 0
let checks = 0
const check = (name, condition, detail) => {
  checks += 1
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  process.exitCode = 0
} else {
  // A document with the same traits as the one the user reported: a big sql
  // fence (lazy, > 30 lines) in the middle and a long table at the end.
  const sql = Array.from({ length: 50 }, (_, i) => `  select ${i}, count(*) from t_${i} group by ${i};`).join('\n')
  const tail = Array.from({ length: 40 }, (_, i) => `| ${i} | 结论 ${i} | 说明 ${i} |`).join('\n')
  const md = [
    '# 报告',
    '',
    '前言。',
    '',
    '```sql',
    sql,
    '```',
    '',
    '## 结论',
    '',
    '| 序号 | 结论 | 说明 |',
    '|---|---|---|',
    tail,
    '',
  ].join('\n')

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" class="mdr-content" style="height:700px;overflow:auto"><div id="inner" class="mdr-md"></div></div>
<pre id="report" style="display:none"></pre>
<script>
window.React = {
  createElement: () => ({}), useRef: () => ({ current: null }), useEffect: () => {},
  useState: () => ['', () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn,
}
window.fetch = (url) => {
  if (String(url).includes('/api/exists')) return Promise.resolve({ ok: true, json: async () => ({ results: {} }) })
  if (String(url).includes('/vendor/mermaid.min.js')) {
    return new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = ${JSON.stringify(path.join(ROOT, 'plugin', 'vendor', 'mermaid.min.js').replace(/\\/g, '/'))}
      script.onload = () => resolve({ ok: true }); script.onerror = () => resolve({ ok: true })
      document.head.appendChild(script)
    })
  }
  return Promise.resolve({ ok: true, json: async () => ({}) })
}
</script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'marked.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '12-mermaid.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '14-diffflazy.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = ${JSON.stringify(md)}
const host = document.getElementById('host')
const inner = document.getElementById('inner')
const out = { steps: {}, doc: null }

// ---- 1. the height round trip of ONE block ----
// The fence CSS must be in place BEFORE the placeholder is measured: the
// reserved height is a CONTENT-box length, so the block's padding is added on
// top of it - without the CSS the two numbers are not comparable.
ensureFenceCss()
const source = Array.from({ length: 40 }, (_, i) => 'select ' + i + ';').join('\\n')
const probe = document.createElement('div')
probe.className = 'mdr-md'
inner.appendChild(probe)
const code = document.createElement('div')
code.className = 'mdr-md-code'
probe.appendChild(code)
const entry = { el: code, source, kind: 'code', lang: 'sql', height: 0 }
const placeholder = lazyFencePlaceholder(source, 'code')
probe.replaceChild(placeholder, code)
const pendingHeight = placeholder.getBoundingClientRect().height
const entry2 = { el: placeholder, source, kind: 'code', lang: 'sql', height: 0 }
lazyFenceRender(entry2)
const renderedHeight = placeholder.getBoundingClientRect().height
lazyFenceRelease(entry2)
const releasedHeight = placeholder.getBoundingClientRect().height
lazyFenceRender(entry2)
const renderedAgain = placeholder.getBoundingClientRect().height
out.steps = { pendingHeight, renderedHeight, releasedHeight, renderedAgain }
probe.remove()

// ---- 2. the real document: scroll to the bottom and watch the geometry ----
inner.innerHTML = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
enhanceMarkdown(inner, 'doc.md', true, ['code'])
const samples = []
setTimeout(() => {
  const max = host.scrollHeight - host.clientHeight
  let step = 0
  const drag = setInterval(() => {
    step += 1
    host.scrollTop = Math.min(max, step * (max / 8))
    if (step >= 8) {
      clearInterval(drag)
      host.scrollTop = host.scrollHeight
      const t0 = performance.now()
      const watch = setInterval(() => {
        const blocks = Array.from(inner.querySelectorAll('.mdr-md-code, .mdr-md-diff'))
        samples.push({
          t: Math.round(performance.now() - t0),
          h: host.scrollHeight,
          top: Math.round(host.scrollTop * 100) / 100,
          pending: blocks.filter((b) => b.classList.contains('mdr-md-code-pending') || b.classList.contains('mdr-md-diff-pending')).length,
          blockHeights: blocks.map((b) => Math.round(b.getBoundingClientRect().height * 100) / 100).join('/'),
        })
        if (performance.now() - t0 > 2000) {
          clearInterval(watch)
          out.doc = { samples }
          document.getElementById('report').textContent = JSON.stringify(out)
        }
      }, 100)
    }
  }, 60)
}, 900)
</script>
</body></html>`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-geometry-'))
  fs.writeFileSync(path.join(tmp, 'index.html'), page, 'utf8')
  let dom = ''
  try {
    dom = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--virtual-time-budget=40000',
        '--dump-dom',
        `file:///${path.join(tmp, 'index.html').replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 180000, windowsHide: true },
    )
  } catch (error) {
    console.log('chrome failed:', error.message)
  }
  const match = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    check('the fixture renders', false, 'no report')
  } else {
    const report = JSON.parse(
      match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    )
    console.log('\n[1] the height round trip of one block')
    const s = report.steps
    console.log(`  placeholder ${s.pendingHeight}px -> rendered ${s.renderedHeight}px -> released ${s.releasedHeight}px -> rendered ${s.renderedAgain}px`)
    check('the placeholder is as tall as the rendered block', Math.abs(s.pendingHeight - s.renderedHeight) <= 1.5, `${s.pendingHeight} vs ${s.renderedHeight}`)
    check('releasing keeps the height EXACTLY', Math.abs(s.releasedHeight - s.renderedHeight) <= 0.5, `${s.releasedHeight} vs ${s.renderedHeight}`)
    check('rendering again keeps the height EXACTLY', Math.abs(s.renderedAgain - s.renderedHeight) <= 0.5, `${s.renderedAgain} vs ${s.renderedHeight}`)

    console.log('\n[2] the bottom of a document stays still')
    const samples = (report.doc && report.doc.samples) || []
    for (const sample of samples) {
      console.log(`  t=${String(sample.t).padStart(4)} height=${sample.h} top=${sample.top} pending=${sample.pending} blocks=${sample.blockHeights}`)
    }
    const heights = new Set(samples.map((x) => x.h))
    const tops = new Set(samples.map((x) => x.top))
    check('the document height does not change at the bottom', heights.size <= 1, [...heights].join(', '))
    check('the scroll position does not move at the bottom', tops.size <= 1, [...tops].join(', '))
    check('the lazy block was rendered', samples.length > 0 && samples[samples.length - 1].pending === 0, JSON.stringify(samples[samples.length - 1] || {}))
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log('\n[3] the wiring (source level)')
  const lazy = fs.readFileSync(path.join(SRC, '14-diffflazy.js'), 'utf8')
  const mdSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
  check('the release subtracts the padding/border', /lazyFenceChrome/.test(lazy) && /height - chrome/.test(lazy))
  check('the release drops the estimated min-height', /el\.style\.minHeight = ''/.test(lazy))
  check('the render drops the reserved height', /el\.style\.minHeight = ''/.test(lazy))
  check('the bottom is pinned while the height changes', /lazyFenceKeepBottom/.test(lazy))
  check('the placeholder height uses the real line height', /LAZY_CODE_LINE_HEIGHT = 19\.375/.test(lazy) && /LAZY_DIFF_ROW_HEIGHT = 20/.test(lazy))
  check('a scrollbar drag stops the scroll restore', /pointerdown', markUser/.test(mdSource) && /mousedown', markUser/.test(mdSource))
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall lazy fence geometry checks passed')
if (failures) process.exitCode = 1
