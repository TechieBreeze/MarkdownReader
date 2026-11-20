/**
 * A lazy fence must never THROW THE USER BACK DOWN (user: 「划到最底部然后向上
 * 滚动，为什么会不断回弹」, 2026-11-20).
 *
 * The reproduction (real browser, real IntersectionObserver):
 *   scroll to the bottom of a document with a big diff fence, then scroll up.
 *   The fence at the edge of the keep band renders, and the reader PINNED the
 *   scroll to the bottom - the user was thrown ~600 px down, again and again.
 *
 * Two independent defects, both checked here:
 *
 *  1. `lazyFenceRender` dropped the RESERVED height before
 *     `lazyFenceKeepBottom` measured "is the user at the bottom?". For a moment
 *     the document was shorter than the scroll position, so the test said
 *     "yes, at the bottom" and the scroll was pinned to the bottom - after the
 *     content was back, the user was 600 px below where they were.
 *
 *  2. The placeholder reserved `source.split('\n').length` rows, but the
 *     rendered block has ONE row less (the trailing newline of the fence is
 *     not a row). The document height therefore changed on every render
 *     (20 px per diff fence), which moves the page at the bottom of a
 *     document and can push a fence across the keep band (release -> render
 *     -> release ...).
 *
 * The check runs the SHIPPED client sources in a real browser (a CDP session,
 * because the IntersectionObserver needs a real compositor - `--dump-dom`
 * never fires it) and asserts:
 *   - scrolling up never moves the scroll position DOWN again
 *   - the document height does not change while the fences render
 *   - at the bottom of the document the bottom STAYS at the bottom
 *
 * Usage: node work/harnesses/lazy-fence-bounce-check.mjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------- the fixture */

// The same traits as the report the user scrolled: a long document, a big
// ```diff fence (135 rows) and a ```java fence (89 lines), both ending with a
// newline (as every real fence does).
const diffLines = [
  'diff --git a/src/Main.java b/src/Main.java',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/Main.java',
  '@@ -0,0 +1,131 @@',
]
for (let i = 0; i < 131; i += 1) diffLines.push(`+    private String field${i} = "value${i}";`)
const diffFence = diffLines.join('\n')

const codeLines = []
for (let i = 0; i < 89; i += 1) codeLines.push(`    log.info("line ${i} of the request");`)
const codeFence = codeLines.join('\n')

const filler = []
for (let i = 0; i < 60; i += 1) filler.push(`第 ${i} 段正文。`.repeat(6))

const md = [
  '# 特性设计说明书',
  '',
  filler.join('\n\n'),
  '',
  '## 改动明细',
  '',
  '```diff',
  diffFence,
  '```',
  '',
  // The fence must be in the MIDDLE of the document: when the user scrolls up
  // from the bottom, the fence enters the keep band far above the bottom -
  // that is where the reader used to pin the scroll to the bottom.
  filler.join('\n\n'),
  '',
  '## 落库组件',
  '',
  '```java',
  codeFence,
  '```',
  '',
  '## 验收',
  '',
  filler.slice(0, 20).join('\n\n'),
  '',
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
    if (String(url).includes('/vendor/mermaid.min.js')) {
      return new Promise((resolve) => {
        const script = document.createElement('script')
        script.src = '/vendor/mermaid.min.js'
        script.onload = () => resolve({ ok: true }); script.onerror = () => resolve({ ok: true })
        document.head.appendChild(script)
      })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  }
</script>
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/highlight.min.js"></script>
<script src="/client/00-core.js"></script>
<script src="/client/20-code.js"></script>
<script src="/client/12-mermaid.js"></script>
<script src="/client/14-diffflazy.js"></script>
<script src="/client/10-markdown.js"></script>
<script>
  const style = document.createElement('style')
  style.textContent = APP_CSS
  document.head.appendChild(style)
  ensureFenceCss()
  const md = ${JSON.stringify(md)}
  const host = document.getElementById('host')
  const inner = document.getElementById('inner')
  inner.innerHTML = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
  enhanceMarkdown(inner, 'doc.md', true, ['code'])
  const out = { samples: [], steps: [], bottom: null, phase: 'start' }
  // Every JS assignment to scrollTop is logged: the browser's own scrolling
  // does not go through the setter.
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(host, 'scrollTop', {
    configurable: true,
    get() { return desc.get.call(this) },
    set(v) {
      out.samples.push({ to: Math.round(v * 100) / 100, phase: out.phase, pinned: String(new Error().stack || '').includes('lazyFenceKeepBottom') })
      desc.set.call(this, v)
    },
  })
  const state = () => ({
    h: host.scrollHeight,
    top: Math.round(host.scrollTop * 100) / 100,
    pending: Array.from(inner.querySelectorAll('.mdr-md-diff, .mdr-md-code')).filter((b) => b.classList.contains('mdr-md-diff-pending') || b.classList.contains('mdr-md-code-pending')).length,
    blocks: Array.from(inner.querySelectorAll('.mdr-md-diff, .mdr-md-code')).map((b) => Math.round(b.getBoundingClientRect().height * 100) / 100),
    // Where does the document height come from? The offset of the first fence
    // and the height of the content around it.
    innerH: Math.round(inner.getBoundingClientRect().height * 100) / 100,
    fenceTop: Math.round((inner.querySelector('.mdr-md-diff') || { offsetTop: -1 }).offsetTop),
    childSum: Math.round(Array.from(inner.children).reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) * 100) / 100,
  })
  setTimeout(() => {
    // 1. to the bottom: the bottom must STAY at the bottom while a fence renders
    out.phase = 'bottom'
    host.scrollTop = host.scrollHeight
    setTimeout(() => {
      out.steps.push(state())
      // 2. now scroll up like a user: the position must never move down again
      out.phase = 'up'
      let step = 0
      const up = setInterval(() => {
        step += 1
        host.scrollTop = Math.max(0, host.scrollTop - 120)
        out.steps.push(state())
        if (step >= 30) {
          clearInterval(up)
          setTimeout(() => {
            out.bottom = state()
            document.getElementById('report').textContent = JSON.stringify(out)
          }, 700)
        }
      }, 80)
    }, 700)
  }, 1800)
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
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(file, 'utf8'))
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-bounce-'))
const debugPort = 9600 + Math.floor(Math.random() * 200)
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
      pageLog.push('EXCEPTION: ' + String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageLog.push('console: ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
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
  let report = null
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(1000)
    const res = await send('Runtime.evaluate', {
      expression: "document.getElementById('report') ? document.getElementById('report').textContent : ''",
      returnByValue: true,
    })
    const text = res.result?.result?.value || ''
    if (text && text.trim().startsWith('{')) {
      report = JSON.parse(text)
      break
    }
  }
  if (!report) {
    check('the page reported something', false, 'no report' + (pageLog.length ? ` (${pageLog.slice(0, 3).join(' | ')})` : ''))
  } else {
    const steps = report.steps || []
    console.log(`  ${steps.length} samples, heights: ${[...new Set(steps.map((s) => s.h))].join(', ')}`)
    let previous = ''
    steps.forEach((step, index) => {
      const blocks = (step.blocks || []).join('/')
      if (blocks !== previous || step.h !== steps[index - 1]?.h) {
        console.log(`    step ${index}: h=${step.h} innerH=${step.innerH} childSum=${step.childSum} fenceTop=${step.fenceTop} top=${step.top} pending=${step.pending} blocks=${blocks}`)
      }
      previous = blocks
    })
    // The scroll position must never move DOWN again while the user scrolls up.
    let bounced = null
    for (let i = 2; i < steps.length; i += 1) {
      if (steps[i].top > steps[i - 1].top + 1) {
        bounced = `${steps[i - 1].top} -> ${steps[i].top}`
        break
      }
    }
    check('scrolling up never throws the user back down', bounced === null, bounced)
    check('the document height does not change while the fences render', new Set(steps.map((s) => s.h)).size <= 1, [...new Set(steps.map((s) => s.h))].join(', '))
    const pinned = (report.samples || []).filter((s) => s.pinned && s.phase === 'up')
    check('the reader never pins the scroll to the bottom while the user scrolls up', pinned.length === 0, JSON.stringify(pinned.slice(0, 3)))
    // At the bottom the bottom must STAY at the bottom (the fence that renders
    // there must not push the page up).
    const bottomStep = steps[0] || {}
    const maxScroll = bottomStep.h - 900
    check('at the bottom the bottom stays at the bottom', Math.abs(bottomStep.top - maxScroll) <= 2, `top=${bottomStep.top} max=${maxScroll}`)
    check('the fence was rendered', steps.length > 0 && steps[steps.length - 1].pending < 2, JSON.stringify(steps[steps.length - 1] || {}))
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
const lazy = fs.readFileSync(path.join(SRC, '14-diffflazy.js'), 'utf8')
check('the reserved height is dropped INSIDE the pinned section', /lazyFenceKeepBottom\(el, \(\) => \{[\s\S]{0,400}el\.style\.minHeight = ''/.test(lazy))
check('the row count comes from the renderer', /function lazyFenceRowCount/.test(lazy) && /parseDiffFenceRows\(text\)\.length/.test(lazy))
check('a diff fence counts its rows, not its source lines', !/const rows = String\(source \|\| ''\)\.split\('\\n'\)\.length/.test(lazy))
check('the fence blocks use a content box', /mdr-md-diff\{[^}]*box-sizing:content-box/.test(fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')))

console.log(failures ? `\n${failures} check(s) failed` : '\nall lazy fence bounce checks passed')
if (failures) process.exitCode = 1
