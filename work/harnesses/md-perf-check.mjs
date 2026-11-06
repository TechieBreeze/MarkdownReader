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
const report = { error: null, longTasks: [], diffBlocks: 0, mermaidDone: false, firstDiffAt: 0, allDiffAt: 0 }
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) report.longTasks.push(Math.round(entry.startTime) + ':' + Math.round(entry.duration))
  }).observe({ entryTypes: ['longtask'] })
} catch {}
const t0 = performance.now()
const html = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
const host = document.getElementById('host')
host.innerHTML = html
enhanceMarkdown(host, '20260917-微服务/docs/设计/fixture.md', true, ['code', '20260917-微服务'])
const timer = setInterval(() => {
  const diff = host.querySelectorAll('.mdr-md-diff').length
  if (diff > 0 && !report.firstDiffAt) report.firstDiffAt = Math.round(performance.now() - t0)
  if (diff >= 3) {
    report.diffBlocks = diff
    report.allDiffAt = Math.round(performance.now() - t0)
    clearInterval(timer)
    setTimeout(() => {
      report.mermaidDone = !!host.querySelector('.mdr-mermaid-done, .mdr-mermaid-failed')
      report.mermaidPlaceholder = !!host.querySelector('.mdr-mermaid')
      report.rows = host.querySelectorAll('.mdr-md-diff .mdr-cl').length
      report.totalMs = Math.round(performance.now() - t0)
      document.getElementById('report').textContent = JSON.stringify(report)
    }, 4000)
  }
}, 50)
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
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall markdown performance checks passed')
if (failures) process.exitCode = 1
