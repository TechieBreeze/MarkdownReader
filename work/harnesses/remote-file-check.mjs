/**
 * A repository link whose file is NOT in the workspace must open the CODE, not
 * the web page.
 *
 * The user (2026-11-19): 「线上代码链接在没解析出本地文件的情况下直接点击的
 * 行为也不应退化和shift+点击一样打开网站链接，应该从线上获取代码然后开代码弹窗」.
 *
 * Three layers are checked here:
 *
 *  1. the Host: the URL parsing and the ref/file split (the ref may contain
 *     slashes, a permalink pins a commit) - the real module, not a copy;
 *  2. the markdown view: a link the Host cannot resolve gets `data-remote` and
 *     the line of the link, so the click can be routed in-app - checked in a
 *     REAL browser with the shipped sources;
 *  3. the wiring: the click opens the popup with the remote URL, the popup
 *     loads `/api/git/remote-file`, and a file that only exists in the
 *     repository never borrows the branch content of a same-named local file.
 *
 * Usage: node work/harnesses/remote-file-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseRemoteBlobUrl, splitRefAndFile, credentialsOf } from '../../plugin/lib/remote.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')

let failures = 0
let checks = 0
const check = (name, condition, detail) => {
  checks += 1
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

console.log('\n[1] the Host: URL parsing and the ref/file split')
const blob = 'https://git.tommy.com.cn/middle-platform/microservices/customer/-/blob/53a4bf0ddac6329218598e2b52407c90a77e3991/src/main/java/com/pvh/customer/consumer/OrderStatusConsumer.java#L98'
const parsed = parseRemoteBlobUrl(blob)
check('the host is parsed', parsed && parsed.host === 'git.tommy.com.cn', JSON.stringify(parsed))
check('the project path keeps the group', parsed && parsed.projectPath === 'middle-platform/microservices/customer', parsed && parsed.projectPath)
check('the line is parsed', parsed && parsed.line === 98, parsed && parsed.line)
check('the tail keeps the ref and the file', parsed && parsed.tail.endsWith('OrderStatusConsumer.java'), parsed && parsed.tail)
const shaSplit = splitRefAndFile(parsed.tail, new Set())
check('a pinned commit is the ref', shaSplit && shaSplit.ref === '53a4bf0ddac6329218598e2b52407c90a77e3991', JSON.stringify(shaSplit))
check('the file path is the rest', shaSplit && shaSplit.file === 'src/main/java/com/pvh/customer/consumer/OrderStatusConsumer.java', JSON.stringify(shaSplit))
const branchSplit = splitRefAndFile('test2.0_merge20240312/src/a/B.java', new Set(['test2.0_merge20240312']))
check('a branch is the ref', branchSplit && branchSplit.ref === 'test2.0_merge20240312', JSON.stringify(branchSplit))
const slashSplit = splitRefAndFile('feature/x/src/a/B.java', new Set(['feature/x', 'feature/x/other']))
check('a ref with slashes wins over its prefix', slashSplit && slashSplit.ref === 'feature/x', JSON.stringify(slashSplit))
check('an unknown ref is refused', splitRefAndFile('nope/src/a/B.java', new Set(['other'])) === null)
check('the credentials of an origin URL are read', (() => {
  const cred = credentialsOf('https://user:pa%40ss@git.example/group/project.git')
  return cred && cred.user === 'user' && cred.pass === 'pa@ss'
})())
check('an origin URL without credentials has none', credentialsOf('https://git.example/group/project.git') === null)

console.log('\n[2] the markdown view: an unresolved link becomes a remote link')
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
  console.log('  SKIP: no Chromium binary found (set CHROME_PATH)')
} else {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div>
<pre id="report" style="display:none"></pre>
<script>
window.React = {
  createElement: () => ({}), useRef: () => ({ current: null }), useEffect: () => {},
  useState: () => ['', () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn,
}
// The Host resolves NOTHING: the link stays a remote one.
window.fetch = (url) => {
  if (String(url).includes('/api/git/resolve')) {
    return Promise.resolve({ ok: true, json: async () => ({ resolved: {} }) })
  }
  if (String(url).includes('/vendor/mermaid.min.js')) {
    return new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = ${JSON.stringify(path.join(ROOT, 'plugin', 'vendor', 'mermaid.min.js').replace(/\\/g, '/'))}
      script.onload = () => resolve({ ok: true }); script.onerror = () => resolve({ ok: true })
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
<script src="${path.join(SRC, '14-diffflazy.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '10-markdown.js').replace(/\\/g, '/')}"></script>
<script>
const md = [
  '# 报告',
  '',
  '线上代码 [WecomExternalContactPO.java:15](${blob})',
  '',
  '本地代码 [X.java:7](https://git.tommy.com.cn/middle-platform/microservices/customer/-/blob/master/src/main/java/X.java#L7)',
  '',
].join('\\n')
const host = document.getElementById('host')
host.innerHTML = window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
enhanceMarkdown(host, 'doc.md', true, ['code'])
setTimeout(() => {
  const anchors = Array.from(host.querySelectorAll('a'))
  const remote = anchors.find((a) => a.dataset.remote)
  const out = {
    count: anchors.length,
    remoteUrl: remote ? remote.dataset.remote : '',
    remoteLine: remote ? remote.dataset.line : '',
    remoteHasPath: remote ? !!remote.dataset.path : false,
    remoteBadge: remote ? !!remote.querySelector('.mdr-line-badge, .mdr-line-token, [class*=badge]') : false,
    remoteTitle: remote ? remote.title : '',
    remoteHasHref: remote ? !!remote.getAttribute('href') : false,
  }
  document.getElementById('report').textContent = JSON.stringify(out)
}, 900)
</script>
</body></html>`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-remote-'))
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
        '--virtual-time-budget=20000',
        '--dump-dom',
        `file:///${path.join(tmp, 'index.html').replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 120000, windowsHide: true },
    )
  } catch (error) {
    console.log('  chrome failed:', error.message)
  }
  const match = /<pre id="report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    check('the markdown renders', false, 'no report')
  } else {
    const out = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    console.log(`  ${JSON.stringify(out)}`)
    check('the unresolved link carries the remote URL', out.remoteUrl === blob, out.remoteUrl)
    check('the line of the link is kept', out.remoteLine === '98', out.remoteLine)
    check('it is NOT a local path link', out.remoteHasPath === false, String(out.remoteHasPath))
    check('the title says the code comes from the repository', /线上/.test(out.remoteTitle), out.remoteTitle)
    check('the original href stays (Shift+click / right-click)', out.remoteHasHref === true, String(out.remoteHasHref))
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n[3] the wiring (source level)')
const mdSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
const appSource = fs.readFileSync(path.join(SRC, '50-app.js'), 'utf8')
const modalSource = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
const gitSource = fs.readFileSync(path.join(SRC, '15-git.js'), 'utf8')
const apiSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'api.js'), 'utf8')
const linksSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'gitlinks.js'), 'utf8')
check('the markdown view marks unresolved links', /item\.anchor\.dataset\.remote = item\.url/.test(mdSource))
check('the click handler knows the remote links', /a\[data-path\], a\[data-remote\]/.test(appSource))
check('the click opens the popup with the remote URL', /setModalRequest\(\{ path: '', line: .*remoteUrl: remote \}\)/.test(appSource))
check('the popup accepts a remote request', /!request\.path && !request\.remoteUrl/.test(modalSource))
check('the popup loads the remote file', /fetchJson\('\/api\/git\/remote-file', \{ url: remote \}\)/.test(modalSource))
check('a remote file never borrows a local branch view', /requestRemote \? 'remote:' \+ displayPath : displayPath/.test(modalSource))
check('a remote file cannot become a tab', /if \(!view \|\| !view\.path \|\| isRemote\) return/.test(modalSource))
check('the Host serves the endpoint', /\/api\/git\/remote-file/.test(apiSource))

console.log('\n[4] a link-heavy document: the URL list goes into the BODY')
check('the client posts the URL list', /postJson\('\/api\/git\/resolve', \{ urls: unique, path: mdPath \}\)/.test(mdSource))
check('the Host accepts the POST', /\/api\/git\/resolve' && req\.method === 'POST'/.test(apiSource))
check(
  'the POST reads the URLs from the body',
  /Array\.isArray\(body\.urls\)/.test(apiSource),
)

console.log('\n[5] the remote is authoritative')
check('a ref that the clone lacks is looked up on the remote', /remoteRefKind/.test(linksSource))
check('a pinned hash is always a commit', /\^\[0-9a-f\]\{7,40\}\$\/i\.test\(ref\)/.test(linksSource))
check('the git file endpoint falls back to the remote', /readRemoteFile\(repo, commit, relInRepo\)/.test(apiSource))
check('the git diff endpoint falls back to the remote', /readRemotePatch/.test(apiSource))
check('the requested branch is not replaced by the local one', /const branch = branchParam \|\| currentBranch/.test(apiSource))
check('the UI says when the file came from the remote', /来自远程仓库/.test(gitSource))

console.log(failures ? `\n${failures} check(s) failed` : '\nall remote file checks passed')
if (failures) process.exitCode = 1
