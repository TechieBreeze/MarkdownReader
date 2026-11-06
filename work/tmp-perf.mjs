import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'plugin', 'src-client')
const DOC = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'
const md = fs.readFileSync(DOC, 'utf8')

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div><pre id="report" style="display:none"></pre>
<script>
window.React = { createElement: () => ({}), useRef: () => ({ current: null }), useEffect: () => {}, useState: () => ['', () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn }
let posted = 0
window.fetch = (url, init) => {
  if (String(url).includes('/api/exists')) { posted += 1; return Promise.resolve({ ok: true, json: async () => ({ results: {} }) }) }
  return Promise.resolve({ ok: true, json: async () => ({}) })
}
</script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'marked.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = ${JSON.stringify(md)}
const marks = []
const t0 = performance.now()
const longTasks = []
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
} catch {}
const html = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
const tParse = performance.now() - t0
const host = document.getElementById('host')
host.innerHTML = html
const tInner = performance.now() - t0
enhanceMarkdown(host, ${JSON.stringify(DOC)}, true, ['code', '20260917-微服务'])
const tEnhance = performance.now() - t0
const timer = setInterval(() => {
  const n = host.querySelectorAll('.mdr-md-diff').length
  marks.push({ t: Math.round(performance.now() - t0), diff: n, plain: host.querySelectorAll('pre > code').length })
  if (n >= 19) {
    clearInterval(timer)
    setTimeout(() => {
      document.getElementById('report').textContent = JSON.stringify({
        parseMs: Math.round(tParse), innerMs: Math.round(tInner), enhanceMs: Math.round(tEnhance),
        totalMs: Math.round(performance.now() - t0), diffBlocks: host.querySelectorAll('.mdr-md-diff').length,
        remainingPre: host.querySelectorAll('pre > code').length, longTasks: longTasks.slice(0, 20), marks: marks.filter((m, i) => i % 5 === 0 || m.diff >= 19).slice(0, 30),
      })
    }, 300)
  }
}, 200)
</script>
</body></html>`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-perf-'))
fs.writeFileSync(path.join(tmp, 'index.html'), page, 'utf8')
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dom = execFileSync(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--allow-file-access-from-files',
  `--user-data-dir=${path.join(tmp,'profile')}`,'--virtual-time-budget=120000','--dump-dom',
  `file:///${path.join(tmp,'index.html').replace(/\\/g,'/')}`], { encoding: 'utf8', timeout: 180000, windowsHide: true })
const m = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
console.log(m ? m[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'NO REPORT (timeout?)')
fs.rmSync(tmp, { recursive: true, force: true })
