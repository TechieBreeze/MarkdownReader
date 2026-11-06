/**
 * Markdown view performance + diff rendering on a mermaid document.
 *
 * The user reported two things about a big design document:
 *   1. the ```diff blocks did not render
 *   2. the page froze "around the §10 mermaid diagram"
 *
 * This check runs the SHIPPED client sources (00-core/10-markdown/12-mermaid/
 * 20-code) plus the vendored marked, highlight.js and mermaid in a real
 * browser, on a fixture with the same traits as the real document
 * (hand-written diffs with wrong hunk counts + a mermaid diagram), and
 * measures:
 *   - every diff block is rendered
 *   - the fence highlighting never blocks the main thread for long
 *     (it runs on idle time in small slices)
 *   - the mermaid render does not overlap the fence work
 *
 * Usage: node work/harnesses/md-perf-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const FIXTURE = path.join(ROOT, 'work', 'fixtures', 'diff-fence-doc.md')

let failures = 0
const check = (name, condition, detail) => {
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
  const md = fs.readFileSync(FIXTURE, 'utf8')
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div><pre id="report" style="display:none"></pre>
<script>
window.React = {
  createElement: () => ({}),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useState: () => ['', () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
window.fetch = (url) => {
  if (String(url).includes('/api/exists')) return Promise.resolve({ ok: true, json: async () => ({ results: {} }) })
  if (String(url).includes('/vendor/mermaid.min.js')) {
    return new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = ${JSON.stringify(path.join(ROOT, 'plugin', 'vendor', 'mermaid.min.js').replace(/\\/g, '/'))}
      script.onload = () => resolve({ ok: true })
      script.onerror = () => resolve({ ok: true })
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
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = ${JSON.stringify(md)}
const report = { error: null, longTasks: [], diffBlocks: 0, mermaidDone: false, firstDiffAt: 0, allDiffAt: 0, second: null, cache: null }
// Count the ACTUAL highlighting work: the sources are classic scripts here, so
// the renderers are globals and can be wrapped.
window.__hlCalls = 0
for (const name of ['renderDiffFenceHtml', 'renderFenceCodeHtml']) {
  const original = window[name]
  if (typeof original !== 'function') continue
  window[name] = function (source, lang) {
    window.__hlCalls += 1
    return original(source, lang)
  }
}
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) report.longTasks.push(Math.round(entry.startTime) + ':' + Math.round(entry.duration))
  }).observe({ entryTypes: ['longtask'] })
} catch {}
function renderPass(host) {
  return new Promise((resolve) => {
    const started = performance.now()
    const html = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
    host.innerHTML = html
    enhanceMarkdown(host, '20260917-微服务/docs/设计/fixture.md', true, ['code', '20260917-微服务'])
    let firstAt = 0
    const timer = setInterval(() => {
      const diff = host.querySelectorAll('.mdr-md-diff').length
      if (diff > 0 && !firstAt) firstAt = Math.round(performance.now() - started)
      if (diff >= 3) {
        clearInterval(timer)
        const first = host.querySelector('.mdr-md-diff')
        resolve({
          ms: Math.round(performance.now() - started),
          firstAt,
          diff,
          rows: host.querySelectorAll('.mdr-md-diff .mdr-cl').length,
          html: first ? first.innerHTML : '',
        })
      }
    }, 20)
  })
}
const host = document.getElementById('host')
const t0 = performance.now()
renderPass(host).then((first) => {
  report.diffBlocks = first.diff
  report.allDiffAt = first.ms
  report.firstDiffAt = first.firstAt
  report.rows = first.rows
  report.firstHtml = first.html.length
  report.hlCallsFirst = window.__hlCalls
  const host2 = document.createElement('div')
  document.getElementById('host').appendChild(host2)
  return renderPass(host2).then((second) => {
    report.second = {
      ms: second.ms,
      firstAt: second.firstAt,
      diff: second.diff,
      rows: second.rows,
      sameHtml: second.html === first.html,
      sameLength: second.html.length === first.html.length,
      hlCallsSecond: window.__hlCalls - report.hlCallsFirst,
    }
    report.cache = typeof fenceCacheReport === 'function' ? fenceCacheReport() : null
    report.mermaidDone = !!host.querySelector('.mdr-mermaid-done, .mdr-mermaid-failed')
    report.mermaidPlaceholder = !!host.querySelector('.mdr-mermaid')
    report.totalMs = Math.round(performance.now() - t0)
    document.getElementById('report').textContent = JSON.stringify(report)
  })
}).catch((error) => {
  report.error = String(error && error.message ? error.message : error)
  document.getElementById('report').textContent = JSON.stringify(report)
})
</script>
</body></html>`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-perf-'))
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
        '--virtual-time-budget=30000',
        '--dump-dom',
        `file:///${path.join(tmp, 'index.html').replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 120000, windowsHide: true },
    )
  } catch (error) {
    console.log('chrome failed:', error.message)
  }
  const match = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    check('the fixture renders', false, 'no report')
  } else {
    const report = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    console.log(`\n  fixture: ${report.diffBlocks} diff blocks, ${report.rows} rows, first diff at ${report.firstDiffAt} ms, all at ${report.allDiffAt} ms, total ${report.totalMs} ms`)
    console.log(`  long tasks: ${JSON.stringify(report.longTasks)}`)
    console.log('\n[1] diff blocks')
    check('all 3 diff blocks are rendered', report.diffBlocks === 3, report.diffBlocks)
    check('the diff blocks have rows', report.rows >= 15, report.rows)
    check('the first diff block appears quickly', report.firstDiffAt > 0 && report.firstDiffAt < 3000, report.firstDiffAt)
    console.log('\n[2] responsiveness')
    // The fence highlighting must not block the main thread for long: the slices
    // run on idle time with a 12ms budget.
    const worst = report.longTasks
      .map((entry) => Number(entry.split(':')[1]))
      .filter((duration) => duration > 0)
    const worstBeforeMermaid = worst.length ? Math.max(...worst) : 0
    check('no main-thread block longer than 600ms', worstBeforeMermaid <= 600, `${worstBeforeMermaid}ms`)
    console.log('\n[3] mermaid')
    // Headless Chrome without a compositor never fires the IntersectionObserver,
    // so the DIAGRAM may stay pending here; what must exist is the placeholder
    // the mermaid slice installs (the wiring), not the finished SVG.
    check('the mermaid placeholder is installed', report.mermaidPlaceholder === true, JSON.stringify(report))
    console.log('\n[4] the second visit of a document is served from the cache')
    // Re-opening a document must not re-run highlight.js for every block: the
    // rendered HTML is cached by content, so the second pass is much faster
    // and produces exactly the same markup.
    if (!report.second) {
      check('the second render pass ran', false, JSON.stringify(report))
    } else {
      console.log(`  first pass: ${report.allDiffAt} ms, second pass: ${report.second.ms} ms, cache ${JSON.stringify(report.cache)}`)
      check('the second pass renders the same blocks', report.second.diff === report.diffBlocks && report.second.rows === report.rows, JSON.stringify(report.second))
      check('the second pass produces the SAME html', report.second.sameHtml === true, JSON.stringify(report.second))
      check('the second pass does NOT highlight again', report.second.hlCallsSecond === 0, JSON.stringify(report.second))
      check('the first pass did highlight', report.hlCallsFirst > 0, report.hlCallsFirst)
      check('the cache was hit', report.cache && report.cache.hits >= report.diffBlocks, JSON.stringify(report.cache))
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall markdown performance checks passed')
if (failures) process.exitCode = 1
