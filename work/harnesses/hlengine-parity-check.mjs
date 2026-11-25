/**
 * The doc preview's highlighting engine must be the SAME as the markdown
 * plugin's (the user: 「代码的高亮引擎没弄过去」).
 *
 * Only copying highlight.js is NOT enough: the plugin's pipeline is
 *   hljs.highlight → enhanceJavaKtTypes → highlightToLines
 * and the last step colours the things hljs leaves white (static call sites,
 * method call names, variable/field references, parameter types, import paths).
 *
 * This harness loads BOTH implementations into ONE real browser page - the
 * plugin's own sources (plugin/src-client/20-code.js, lifted as globals) and
 * the prototype's assets/hlengine.js - and compares the produced markup. The
 * prototype's engine must produce the SAME HTML as the plugin's.
 *
 * A fake hljs is used on purpose: the comparison is about the ENGINE (the
 * Java/Kotlin post-passes), not about hljs's own grammar.
 *
 * Usage: node work/harnesses/hlengine-parity-check.mjs
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
const PROTO = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/gits/docs/thdocs/demo/pvh-ops-prototype/assets'
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
  for (const c of [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const JAVA = [
  'package com.pvh.promotion.api;',
  '',
  'import com.alibaba.fastjson.JSONObject;',
  'import com.pvh.promotion.model.po.CouponPO;',
  '',
  '@RestController',
  'public class CouponApiController extends BaseController {',
  '    private static final int MAX_COUNT = 100;',
  '    private CouponService couponService;',
  '',
  '    /** 冻结优惠券 */',
  '    @PostMapping("/freeze")',
  '    public Result freezeCustomerCoupon(CustomerCouponFreezeReqDTO req, HttpServletRequest request) {',
  '        Assert.notNull(req, "参数为空");',
  '        String couponCode = req.getCouponCode();',
  '        CouponPO po = couponService.getByCode(couponCode);',
  '        List<String> codes = new ArrayList<String>();',
  '        return Result.ok(JSONObject.parseObject(JSON.toJSONString(po)));',
  '    }',
  '}',
].join('\n')

const SQL = [
  'SELECT',
  '\tservice, request_time, request, response, response_time, `status`, create_time',
  'FROM',
  '\tlog.open_api_log',
  'WHERE',
  '\t`status` = 2',
  '\tAND create_time > DATE_ADD( now( ), INTERVAL - 10 MiNUTE )',
  "\tand service = 'CouponApiController.freezeCustomerCoupon(..)'",
].join('\n')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="report"></pre>
<script>
  // A fake hljs: the comparison is about the ENGINE (the Java/Kotlin
  // post-passes), not about hljs's own grammar.
  window.hljs = {
    getLanguage: (name) => (name === 'java' || name === 'sql' ? {} : null),
    // A fake hljs with the SHAPE of the real one: strings, keywords and a
    // declaration's parameter list each get their own span.
    // The replacements run on the RAW line with placeholders, so a later
    // replacement cannot match inside an earlier one's markup.
    highlight: (source) => ({
      value: source.split('\\n').map((line) => {
        const holes = [];
        const hold = (html) => {
          holes.push(html);
          return '\\u0000' + (holes.length - 1) + '\\u0000';
        };
        let work = line;
        work = work.replace(/"[^"]*"/g, (m) => hold('<span class="hljs-string">' + m + '</span>'));
        // A DECLARATION's parameter list gets <span class="hljs-params">
        if (/^\\s*(public|private|protected|static|final|@)/.test(work) && /\\w+\\s*\\([^)]*\\)/.test(work)) {
          work = work.replace(/(\\([^)]*\\))/g, (m) => hold('<span class="hljs-params">' + m + '</span>'));
        }
        work = work.replace(/\\b(public|private|static|class|void|return|new|int|final)\\b/g, '<span class="hljs-keyword">$1</span>');
        return work.replace(/\\u0000(\\d+)\\u0000/g, (m, index) => holes[Number(index)]);
      }).join('\\n'),
    }),
  };
  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
</script>
<script src="/plugin/20-code.js"></script>
<script src="/proto/hlengine.js"></script>
<script>
  const JAVA = ${JSON.stringify(JAVA)};
  const SQL = ${JSON.stringify(SQL)};
  const out = {};
  try {
    for (const [label, source, lang] of [['java', JAVA, 'java'], ['sql', SQL, 'sql']]) {
      const a = highlightToLines(highlightCodeHtml(source, lang), isJavaKtLang(lang));
      const b = PVH_HL.highlightToLines(PVH_HL.highlightCodeHtml(source, lang), PVH_HL.isJavaKtLang(lang));
      const diffs = [];
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i += 1) {
        if (a[i] !== b[i]) diffs.push({ line: i + 1, plugin: String(a[i] || '').slice(0, 220), proto: String(b[i] || '').slice(0, 220) });
      }
      out[label] = { pluginLines: a.length, protoLines: b.length, diffs: diffs.slice(0, 3), diffCount: diffs.length };
    }
    // What does the engine colour that hljs leaves white?
    // NOTE: highlightToLines MERGES the parent classes with the token classes
    // into ONE span (class="hljs-params hljs-type"), so the parameter's type
    // is a merged span, not a nested one.
    const java = PVH_HL.highlightToLines(PVH_HL.highlightCodeHtml(JAVA, 'java'), true).join('\\n');
    out.marks = {
      type: /<span class="hljs-type">CouponService<\\/span>/.test(java),
      function: /<span class="hljs-title function_">getByCode<\\/span>/.test(java),
      variable: /<span class="hljs-variable">couponService<\\/span>/.test(java),
      constant: /<span class="hljs-constant">MAX_COUNT<\\/span>/.test(java),
      paramType: /<span class="hljs-params hljs-type">CustomerCouponFreezeReqDTO<\\/span>/.test(java),
      importType: /<span class="hljs-type">CouponPO<\\/span>/.test(java),
    };
    out.sample = java.split('\\n').filter((l) => /getByCode|MAX_COUNT|CustomerCouponFreezeReqDTO/.test(l)).slice(0, 3);
  } catch (error) {
    out.error = String((error && error.stack) || error);
  }
  document.getElementById('report').textContent = JSON.stringify(out);
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/plugin/20-code.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8'))
    return
  }
  if (url.pathname === '/proto/hlengine.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(path.join(PROTO, 'hlengine.js'), 'utf8'))
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-hl-'))
const debugPort = 9700 + Math.floor(Math.random() * 150)
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
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
  const ws = new WebSocket(await waitForDevtools())
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
      pageLog.push('EXCEPTION: ' + String(msg.params.exceptionDetails?.exception?.description || '').slice(0, 300))
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(700)
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
    check('the page reported something', false, 'no report ' + pageLog.slice(0, 2).join(' | '))
  } else {
    if (out.error) check('no error on the page', false, out.error)
    console.log('\n[1] the two engines produce the SAME markup')
    for (const label of ['java', 'sql']) {
      const info = out[label] || {}
      check(`${label}: same line count`, info.pluginLines === info.protoLines, `${info.pluginLines} vs ${info.protoLines}`)
      check(`${label}: identical markup`, info.diffCount === 0, info.diffCount ? JSON.stringify(info.diffs[0]) : '')
    }
    console.log('\n[2] the engine colours what hljs leaves white')
    for (const [name, ok] of Object.entries(out.marks || {})) {
      check(name, ok === true)
    }
    if (out.sample) console.log('  sample:', JSON.stringify(out.sample, null, 1))
  }
  ws.close()
} finally {
  child.kill()
  await sleep(600)
  try {
    execFileSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {
    /* gone */
  }
  await sleep(400)
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* Chrome still holds a file in the profile - the temp dir is disposable */
  }
  server.close()
}

console.log('\n[3] the shipped files')
const protoEngine = fs.readFileSync(path.join(PROTO, 'hlengine.js'), 'utf8')
for (const name of [
  'enhanceJavaKtTypes',
  'hljsPostProcJavaKtTokens',
  'hljsParamTokens',
  'isImportPathText',
  'highlightToLines',
  'highlightCodeHtml',
]) {
  check(`the engine has ${name}`, protoEngine.includes(`function ${name}(`))
}
const mdpreview = fs.readFileSync(path.join(PROTO, 'mdpreview.js'), 'utf8')
check('the preview uses the engine', /PVH_HL/.test(mdpreview) && /highlightFenceLines/.test(mdpreview))
check('the code popup uses the engine', /highlightFenceLines\(r\.content/.test(mdpreview))
const indexHtml = fs.readFileSync(path.join(PROTO, '..', 'index.html'), 'utf8')
check('index.html loads the engine', /assets\/hlengine\.js/.test(indexHtml))
const css = fs.readFileSync(path.join(PROTO, 'style.css'), 'utf8')
check('the palette has the post-pass classes', /\.mdp-md pre code \.hljs-params\.hljs-type/.test(css) && /\.mdp-md pre code \.hljs-constant/.test(css))
check('the code popup has the palette too', /\.mdp-cl-code \.hljs-params\.hljs-type/.test(css))

console.log(failures ? `\n${failures} check(s) failed` : '\nall highlight engine parity checks passed')
if (failures) process.exitCode = 1
