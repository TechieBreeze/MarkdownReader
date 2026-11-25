/**
 * A link that pins a COMMIT must show THAT commit: its branch and its line
 * numbers (user: 「打开ck和th两个环境的代码链接，显示的分支都是同一个，但是
 * 实际上代码不在同一个分支」, 2026-11-25).
 *
 * The document `20261125-CK与TH注册触发事件及订阅方梳理.md` links the CK code
 * to the merge commit `df40a0de` (on `ck_test2.0`) and the TH code to
 * `a8555d8f` (on `test2.0_merge20240312`). Both links resolve to the same
 * local file, so the popup has to tell them apart:
 *
 *   - the branch dropdown showed the LOCAL CHECKOUT's branch for both
 *     (ck-dev-1020) - the branch of the pinned commit was never resolved;
 *   - the CONTENT was the working tree's copy, because a merge commit has no
 *     diff by default: the rows fell back to the branch content, so the link's
 *     line 118 highlighted `@Resource` (the checkout) instead of `@Override`
 *     (the commit's own line 118).
 *
 * The check mounts the real popup (real React + the shipped sources) with both
 * links and asserts the branch AND the highlighted line.
 *
 * Usage:
 *   cd work && pnpm add react@18 react-dom@18    (once)
 *   HOST_BASE=http://127.0.0.1:54258/markdown-reader node work/harnesses/popup-branch-check.mjs
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

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

if (!fs.existsSync(path.join(REACT, 'react', 'umd', 'react.development.js'))) {
  console.log('\nSKIP: React is not installed for this harness.')
  console.log(`      cd work && pnpm add react@18 react-dom@18   (then run it again)`)
  console.log(`      expected in: ${REACT}\n`)
  process.exit(0)
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

const FILE = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/service/impl/CustomerRegisterServiceImpl.java'
const SCENARIOS = {
  // The TH link: the merge commit of th-dev-1124 into test2.0_merge20240312.
  th: { line: 118, refCommit: 'a8555d8f8442148bfcf8700b33434f9f57225f0f', branch: 'test2.0_merge20240312', lineText: '@Override' },
  // The CK link: the merge commit of ck-dev-1124 into ck_test2.0 (a branch that
  // only exists on the remote - it must still be shown).
  ck: { line: 118, refCommit: 'df40a0de74da95fa8bd54c5728645706cb849590', branch: 'ck_test2.0', lineText: '@Resource' },
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
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
  const scenarios = ${JSON.stringify(SCENARIOS)}
  const file = ${JSON.stringify(FILE)}
  const name = new URLSearchParams(location.search).get('s') || 'th'
  const scenario = scenarios[name]
  const request = { path: file, line: scenario.line, refCommit: scenario.refCommit }
  const started = Date.now()
  function report() {
    const selects = Array.from(document.querySelectorAll('.mdr-git-sel'))
    const hit = document.querySelector('.mdr-cl.hit')
    document.getElementById('report').textContent = JSON.stringify({
      scenario: name,
      ms: Date.now() - started,
      branch: selects[0] ? selects[0].value : '',
      branchOptions: selects[0] ? Array.from(selects[0].options).map((o) => o.value) : [],
      commit: selects[1] ? selects[1].value : '',
      hitLine: hit ? hit.getAttribute('data-line') : '',
      hitText: hit ? String(hit.textContent || '').trim() : '',
      errors: window.__errors,
    })
  }
  ReactDOM.createRoot(document.getElementById('root')).render(
    h(CodeModal, { request, onClose: () => {}, onOpenTab: () => {}, onOpen: () => {}, searchBar: null, searchOpen: false, onCloseSearch: () => {} }),
  )
  setTimeout(report, 3000)
  setTimeout(report, 9000)
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
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(path.join(REACT, pkg, 'umd', `${pkg}.development.js`), 'utf8'))
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
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  server.close()
  process.exit(0)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-br-'))
const debugPort = 9400 + Math.floor(Math.random() * 200)
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

const results = {}
try {
  const wsUrl = await waitForDevtools()
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
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
  for (const name of Object.keys(SCENARIOS)) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?s=${name}` })
    let out = null
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
    results[name] = out
    console.log(`  ${JSON.stringify(out)}`)
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

console.log('\n[1] the branch of a pinned commit')
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const out = results[name]
  if (!out) {
    check(`[${name}] the popup reported something`, false, 'no report')
    continue
  }
  check(`[${name}] the branch is the one that contains the commit`, out.branch === scenario.branch, out.branch)
  check(`[${name}] the branch is in the dropdown`, out.branchOptions.includes(scenario.branch), JSON.stringify(out.branchOptions))
  check(`[${name}] the commit dropdown shows the pinned commit`, out.commit === scenario.refCommit, out.commit)
}
check('the CK and the TH link show DIFFERENT branches', results.th && results.ck && results.th.branch !== results.ck.branch, `${results.th && results.th.branch} vs ${results.ck && results.ck.branch}`)

console.log('\n[2] the content is the commit\'s own file (the line numbers of the link)')
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const out = results[name]
  if (!out) continue
  check(`[${name}] the link's line is highlighted`, out.hitLine === String(scenario.line), String(out.hitLine))
  check(`[${name}] the highlighted line is the COMMIT's line`, out.hitText.includes(scenario.lineText), out.hitText)
  check(`[${name}] no uncaught error`, !out.errors.length, JSON.stringify(out.errors))
}

console.log('\n[3] the wiring (source level)')
const gitSource = fs.readFileSync(path.join(SRC, '15-git.js'), 'utf8')
const codeSource = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
const apiSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'api.js'), 'utf8')
check('the Host answers which branches contain a commit', /function branchesContaining/.test(apiSource) && /contains,/.test(apiSource))
check('the popup applies the branch of the commit', /function applyCommitBranch/.test(gitSource))
check('a commit view shows the file at that commit', /view\.commit && Array\.isArray\(view\.fileLines\)/.test(codeSource))
check('a merge commit is diffed against its first parent', /--first-parent/.test(apiSource))

console.log(failures ? `\n${failures} check(s) failed` : '\nall popup branch checks passed')
if (failures) process.exitCode = 1
