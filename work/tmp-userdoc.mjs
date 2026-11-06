import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const ROOT = process.cwd()
const SRC = path.join(ROOT, 'plugin', 'src-client')
const DOC = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/梳理/20261106/20261106-MarkdownReader-diff渲染-验证.md'
const md = fs.readFileSync(DOC, 'utf8')
console.log('--- first 30 lines of the document ---')
md.split('\n').slice(0, 30).forEach((l, i) => console.log(String(i + 1).padStart(3), JSON.stringify(l)))
const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div><pre id="report" style="display:none"></pre>
<script>
window.React = { createElement: () => ({}), useRef: () => ({ current: null }), useEffect: () => {}, useState: () => ['', () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn }
window.fetch = (url) => String(url).includes('/api/exists')
  ? Promise.resolve({ ok: true, json: async () => ({ results: {} }) })
  : Promise.resolve({ ok: true, json: async () => ({}) })
</script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'marked.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = ${JSON.stringify(md)}
const html = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
const host = document.getElementById('host')
host.innerHTML = html
const classes = [...host.querySelectorAll('pre > code')].map((c) => c.className)
enhanceMarkdown(host, ${JSON.stringify(DOC)}, true, ['code', '20260917-微服务'])
setTimeout(() => {
  const diffs = host.querySelectorAll('.mdr-md-diff')
  document.getElementById('report').textContent = JSON.stringify({
    codeClasses: classes,
    diffBlocks: diffs.length,
    rows: host.querySelectorAll('.mdr-md-diff .mdr-cl').length,
    firstRows: diffs[0] ? [...diffs[0].querySelectorAll('.mdr-cl')].slice(0, 3).map((r) => r.className + ' :: ' + r.textContent.slice(0, 40)) : [],
  })
}, 2500)
</script></body></html>`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-user-'))
fs.writeFileSync(path.join(tmp, 'index.html'), page, 'utf8')
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dom = execFileSync(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--allow-file-access-from-files',
  `--user-data-dir=${path.join(tmp,'profile')}`,'--virtual-time-budget=15000','--dump-dom',
  `file:///${path.join(tmp,'index.html').replace(/\\/g,'/')}`], { encoding: 'utf8', timeout: 120000, windowsHide: true })
const m = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
console.log('\n--- harness result ---')
console.log(m ? m[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : 'NO REPORT')
fs.rmSync(tmp, { recursive: true, force: true })
