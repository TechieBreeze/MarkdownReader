import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'plugin', 'src-client')
const DOC = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'
const md = fs.readFileSync(DOC, 'utf8')

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div>
<pre id="report" style="display:none"></pre>
<script>
window.React = {
  createElement: () => ({}),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useState: () => ['', () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ results: {} }) })
</script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'marked.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = ${JSON.stringify(md)}
const report = { error: null, diffBlocks: 0, codeBlocks: 0, rows: 0, firstRows: [] }
try {
  const html = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
  const host = document.getElementById('host')
  host.innerHTML = html
  report.codeBlocks = host.querySelectorAll('pre > code').length
  report.diffLangBlocks = host.querySelectorAll('pre > code.language-diff').length
  enhanceMarkdown(host, ${JSON.stringify(DOC)}, false, ['code', '20260917-微服务'])
} catch (error) {
  report.error = String((error && error.stack) || error)
}
setTimeout(() => {
  const host = document.getElementById('host')
  report.diffBlocks = host.querySelectorAll('.mdr-md-diff').length
  report.rows = host.querySelectorAll('.mdr-md-diff .mdr-cl').length
  const first = host.querySelector('.mdr-md-diff')
  if (first) report.firstRows = [...first.querySelectorAll('.mdr-cl')].slice(0, 4).map((r) => r.className + ' :: ' + r.textContent.slice(0, 50))
  document.getElementById('report').textContent = JSON.stringify(report)
}, 2500)
</script>
</body></html>`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-real-'))
fs.writeFileSync(path.join(tmp, 'index.html'), page, 'utf8')
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dom = execFileSync(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--allow-file-access-from-files',
  `--user-data-dir=${path.join(tmp,'profile')}`,'--virtual-time-budget=8000','--dump-dom',
  `file:///${path.join(tmp,'index.html').replace(/\\/g,'/')}`], { encoding: 'utf8', timeout: 120000, windowsHide: true })
const raw = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
console.log(raw ? raw[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : 'NO REPORT')
fs.rmSync(tmp, { recursive: true, force: true })
