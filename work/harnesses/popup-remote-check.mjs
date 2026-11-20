/**
 * End-to-end check of the code popup for a repository link whose file is NOT
 * in the workspace (the employee link of the OpenAPI report).
 *
 * The page loads the SHIPPED client sources with a real React and mounts the
 * real `CodeModal`, so the whole chain is exercised in a browser:
 *
 *   click -> setModalRequest({remoteUrl}) -> CodeModal -> loadFile ->
 *   /api/git/remote-file -> the code is rendered, the line is highlighted
 *
 * The Host is reached through a local proxy (the plugin route is
 * same-origin in the app, and the proxy keeps that property here).
 *
 * Usage: node work/harnesses/popup-remote-check.mjs
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
const REACT = path.join(ROOT, 'work', 'tmp-react', 'node_modules')
const HOST = (process.env.HOST_BASE || 'http://127.0.0.1:54258').replace(/\/markdown-reader\/?$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** React is not committed (it is a test dependency): install it once. */
const REACT_READY = fs.existsSync(path.join(REACT, 'react', 'umd', 'react.development.js'))
if (!REACT_READY) {
  console.log(
    '\nSKIP: React is not installed for this harness.\n' +
      `      cd work && pnpm add react@18 react-dom@18   (then run it again)\n` +
      `      expected in: ${REACT}\n`,
  )
  process.exit(0)
}

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

const REMOTE_URL =
  'https://git.tommy.com.cn/middle-platform/microservices/employee/-/blob/' +
  '7c94362a71aa02a7883874ae30d922c0a8a6eb03/src/main/java/com/pvh/employee/api/SmsCallbackController.java#L65'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>popup check</title></head><body>
<div id="root" style="height:900px"></div>
<pre id="report" style="display:none"></pre>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  const h = React.createElement
  const BUILD_ID = 'harness'
  window.__errors = []
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)))
</script>
<script src="/client/00-core.js"></script>
<script src="/client/15-git.js"></script>
<script src="/client/20-code.js"></script>
<script src="/client/22-defs.js"></script>
<script src="/client/24-modal.js"></script>
<script src="/client/26-filesearch.js"></script>
<script>
  const scenario = new URLSearchParams(location.search).get('s') || 'remote'
  const requests = {
    remote: { path: '', line: 65, remoteUrl: ${JSON.stringify(REMOTE_URL)} },
    // A link that pins a commit, for a file that is NOT in the working tree:
    // the popup must show the pinned content, not an error.
    pinned: {
      path: '20260917-微服务/gits/employee/src/main/java/com/pvh/employee/api/SmsCallbackController.java',
      line: 48,
      refCommit: '7c94362a71aa02a7883874ae30d922c0a8a6eb03',
    },
  }
  const request = requests[scenario]
  const started = Date.now()
  function report() {
    const card = document.querySelector('.mdr-cmodal')
    const state = document.querySelector('.mdr-cmodal-state')
    const rows = document.querySelectorAll('.mdr-cl').length
    const hit = document.querySelector('.mdr-cl.hit')
    const badge = Array.from(document.querySelectorAll('.mdr-cmodal-badge')).map((b) => b.textContent)
    const head = document.querySelector('.mdr-cmodal-path')
    document.getElementById('report').textContent = JSON.stringify({
      scenario,
      ms: Date.now() - started,
      hasCard: !!card,
      loading: !!state && /加载中|正在从线上仓库取/.test(state.textContent || ''),
      state: state ? String(state.textContent || '').slice(0, 200) : '',
      rows,
      hitLine: hit ? hit.getAttribute('data-line') : '',
      hitText: hit ? String(hit.textContent || '').slice(0, 120) : '',
      badges: badge,
      head: head ? String(head.textContent || '') : '',
      errors: window.__errors,
    })
  }
  ReactDOM.createRoot(document.getElementById('root')).render(
    h(CodeModal, { request, onClose: () => {}, onOpenTab: () => {}, onOpen: () => {}, searchBar: null, searchOpen: false, onCloseSearch: () => {} }),
  )
  setTimeout(report, 1200)
  setTimeout(report, 6000)
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/react.js' || url.pathname === '/react-dom.js') {
    const pkg = url.pathname === '/react.js' ? 'react' : 'react-dom'
    const file = path.join(REACT, pkg, 'umd', `${pkg}.development.js`)
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(file, 'utf8'))
    return
  }
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
  // The plugin route of the live Host, proxied (same origin for the page).
  const target = `${HOST}${req.url}`
  const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: '127.0.0.1:54258' } }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', () => {
    res.writeHead(502)
    res.end('proxy error')
  })
  req.pipe(proxy)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log(`harness on http://127.0.0.1:${port}`)

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  server.close()
  process.exit(0)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-popup-'))
const debugPort = 9700 + Math.floor(Math.random() * 200)
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
  const pageErrors = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'error'))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
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

  let out = null
  const scenarios = [
    {
      name: 'remote',
      run: async () => {
        check('the popup opens', out.hasCard === true, JSON.stringify(out))
        check('it does not stay in the loading state', out.loading === false, out.state)
        check('the code is rendered', out.rows > 50, String(out.rows))
        check('the line of the link is highlighted', out.hitLine === '65', String(out.hitLine))
        check('the line really is the jdcloud callback', /jdcloud/.test(out.hitText), out.hitText)
        check('the header shows the file', /SmsCallbackController\.java/.test(out.head), out.head)
        check('the badge names the repository and the version', out.badges.some((b) => /employee/.test(b)), JSON.stringify(out.badges))
        check('no uncaught error', !out.errors.length && !pageErrors.length, JSON.stringify(out.errors.concat(pageErrors)))
        check('it is fast (no endless spinner)', out.ms < 8000, String(out.ms))
      },
    },
    {
      name: 'pinned',
      run: async () => {
        check('the popup opens', out.hasCard === true, JSON.stringify(out))
        check('it does not stay in the loading state', out.loading === false, out.state)
        check('the pinned content is rendered', out.rows > 50, String(out.rows))
        check('the pinned line is highlighted', out.hitLine === '48', String(out.hitLine))
        check('no uncaught error', !out.errors.length && !pageErrors.length, JSON.stringify(out.errors.concat(pageErrors)))
      },
    },
  ]

  for (const scenario of scenarios) {
    out = null
    pageErrors.length = 0
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?s=${scenario.name}` })
    for (let attempt = 0; attempt < 20; attempt += 1) {
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
      check(`[${scenario.name}] the page reported something`, false, 'no report')
      continue
    }
    console.log(`  ${JSON.stringify(out)}`)
    scenario.run()
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
console.log(failures ? `\n${failures} check(s) failed` : '\nall popup checks passed')
if (failures) process.exitCode = 1
