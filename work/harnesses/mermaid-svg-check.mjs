/**
 * A mermaid diagram must actually APPEAR (user: 「有个mermaid图加载不出来」,
 * 2026-11-24).
 *
 * The reader shows the diagram as an image: the rendered SVG is encoded as a
 * `data:image/svg+xml;base64,…` URL and put into an `<img>`. An SVG used as an
 * image is parsed as XML - and mermaid's HTML labels put a BARE `<br>` into the
 * foreignObject (`<span class="nodeLabel">line1<br>line2</span>`). XML has no
 * void elements, so the parser stopped at the `<br>` and the whole image
 * failed: the reader showed 「mermaid 图片加载失败」 and the diagram never
 * appeared.
 *
 * Every diagram with a MULTI-LINE label was affected - 323 of the 1051
 * mermaid diagrams of the workspace, not only the one the user reported.
 *
 * The check runs the SHIPPED client (12-mermaid.js) with the vendored mermaid
 * library and the live Host (the 3.3 MB library is served by the plugin
 * route) and asserts:
 *   - the placeholder ends up 'done' with an <img> in it
 *   - the SVG is a WELL-FORMED XML document (the parser has no error)
 *   - the image really loads (no 「mermaid 图片加载失败」)
 *
 * Usage: HOST_BASE=http://127.0.0.1:54258/markdown-reader node work/harnesses/mermaid-svg-check.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const HOST = (process.env.HOST_BASE || 'http://127.0.0.1:54258').replace(/\/markdown-reader\/?$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

// The label of the report the user opened: several lines, Chinese text, and
// the characters that break the XML (a bare <br>).
const DIAGRAM = [
  'flowchart TD',
  '    A["CkDataXXxlJob<br/>XXL-JOB 定时任务（CK 侧 @964）"] --> B["queryEzrOrderMasterChange<br/>取本批待推 EZR 的订单"]',
  '    B --> C["getRefIds<br/>按 sync_data 分页取数<br/>sync_status_1 ∈ 0,2 = 待推 / 失败重推<br/>→ 同一张单可能多次进入批次"]',
  '    C --> D["组装报文<br/>填 RefSaleNo → 游客会员码置空 → SourceOrderNumber 置空"]',
].join('\n')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" class="mdr-content" style="height:900px"><div id="inner" class="mdr-md"></div></div>
<pre id="report" style="display:none"></pre>
<script>
  window.React = {
    createElement: () => ({}), useRef: () => ({ current: null }), useEffect: () => {},
    useState: () => ['', () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn,
  }
  window.fetch = (url) => {
    if (String(url).includes('/api/exists')) return Promise.resolve({ ok: true, json: async () => ({ results: {} }) })
    return Promise.resolve({ ok: true, json: async () => ({}) })
  }
</script>
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/highlight.min.js"></script>
<script src="/client/00-core.js"></script>
<script src="/client/10-markdown.js"></script>
<script src="/client/12-mermaid.js"></script>
<script src="/client/14-diffflazy.js"></script>
<script src="/client/20-code.js"></script>
<script>
  const style = document.createElement('style')
  style.textContent = APP_CSS
  document.head.appendChild(style)
  const md = ['# 报告', '', '\`\`\`mermaid', ${JSON.stringify(DIAGRAM)}, '\`\`\`', ''].join('\\n')
  const host = document.getElementById('host')
  const inner = document.getElementById('inner')
  inner.innerHTML = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
  window.__svg = ''
  const origApply = window.mmdApplyCached
  window.mmdApplyCached = function (el, cached, source) {
    try {
      const url = String((cached && cached.url) || '')
      const comma = url.indexOf(',')
      if (comma > 0) window.__svg = atob(url.slice(comma + 1))
    } catch (error) { window.__svg = '' }
    return origApply.apply(this, arguments)
  }
  enhanceMarkdown(inner, 'doc.md', true, ['code'])
  setTimeout(() => {
    // scroll the diagram into view, like a reader
    const el = inner.querySelector('.mdr-mermaid')
    if (el) host.scrollTop = Math.max(0, el.offsetTop - 100)
  }, 1200)
  setTimeout(() => {
    const els = Array.from(inner.querySelectorAll('.mdr-mermaid'))
    const el = els[0]
    let parseError = ''
    try {
      const doc = new DOMParser().parseFromString(window.__svg || '', 'image/svg+xml')
      const err = doc.querySelector('parsererror')
      if (err) parseError = String(err.textContent || '').slice(0, 200)
    } catch (error) { parseError = String(error) }
    document.getElementById('report').textContent = JSON.stringify({
      count: els.length,
      state: el ? (el.classList.contains('mdr-mermaid-done') ? 'done' : el.classList.contains('mdr-mermaid-failed') ? 'failed' : 'pending') : 'none',
      imgs: el ? el.querySelectorAll('img').length : 0,
      text: el ? String(el.textContent || '').trim().slice(0, 120) : '',
      imageFailed: /图片加载失败/.test(el ? el.textContent || '' : ''),
      svgLength: (window.__svg || '').length,
      parseError,
      bareBr: /<br\\s*>/i.test(window.__svg || ''),
    })
  }, 14000)
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/client/')) {
    const file = path.join(SRC, url.pathname.slice('/client/'.length))
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('missing')
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(file, 'utf8'))
    return
  }
  if (url.pathname.startsWith('/vendor/')) {
    const file = path.join(ROOT, 'plugin', 'vendor', url.pathname.slice('/vendor/'.length))
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('missing')
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(file, 'utf8'))
    return
  }
  if (url.pathname.startsWith('/markdown-reader/')) {
    // the plugin route of the live Host (the 3.3 MB mermaid library lives there)
    const proxy = http.request(
      `${HOST}${req.url}`,
      { method: req.method, headers: { ...req.headers, host: '127.0.0.1:54258' } },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers)
        upstream.pipe(res)
      },
    )
    proxy.on('error', () => {
      res.writeHead(502)
      res.end('proxy error')
    })
    req.pipe(proxy)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  server.close()
  process.exit(0)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-mmd-'))
const debugPort = 9500 + Math.floor(Math.random() * 200)
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--window-size=1500,1000',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('devtools endpoint never came up')
}

try {
  const wsUrl = await waitForDevtools()
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const pageLog = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageLog.push('EXCEPTION: ' + String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text).slice(0, 300))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageLog.push('console: ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    }
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  let out = null
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(1000)
    const res = await send('Runtime.evaluate', {
      expression: "document.getElementById('report') ? document.getElementById('report').textContent : ''",
      returnByValue: true,
    })
    const text = res.result?.result?.value || ''
    if (text && text.trim().startsWith('{')) {
      out = JSON.parse(text)
      break
    }
  }
  if (!out) {
    check('the page reported something', false, 'no report' + (pageLog.length ? ` (${pageLog.slice(0, 3).join(' | ')})` : ''))
  } else {
    console.log(`  ${JSON.stringify(out)}`)
    check('the diagram was rendered', out.state === 'done', out.state)
    check('the image is in the DOM', out.imgs === 1, String(out.imgs))
    check('the image really loaded', out.imageFailed === false, out.text)
    check('the SVG is well-formed XML', out.parseError === '', out.parseError)
    check('the SVG has no bare <br>', out.bareBr === false, 'a bare <br> breaks the XML parser')
  }
  ws.close()
} finally {
  child.kill()
  await sleep(300)
  try {
    execFileSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {
    /* gone */
  }
  fs.rmSync(profile, { recursive: true, force: true })
  server.close()
}

console.log('\n[2] the wiring (source level)')
const mermaid = fs.readFileSync(path.join(SRC, '12-mermaid.js'), 'utf8')
check('the SVG is made well-formed before it is encoded', /function mmdSvgWellFormed/.test(mermaid))
check('the void elements are self-closed', /<\$\{tag\}/.test(mermaid) && /mmdSvgWellFormed\(svg\)/.test(mermaid))

console.log(failures ? `\n${failures} check(s) failed` : '\nall mermaid svg checks passed')
if (failures) process.exitCode = 1
