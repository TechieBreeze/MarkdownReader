/**
 * In-file search (Ctrl+F) — regression check.
 *
 * The feature was missing from the DSH plugin (it only existed in the
 * standalone reader), so this check locks down its contract:
 *   - the markdown search finds every occurrence in the RENDERED text and
 *     wraps it in `<mark class="mdr-fs-mark">`
 *   - clearing the search restores the original text exactly (no split text
 *     nodes left behind - that used to make later searches miss whole words)
 *   - the three switches work: 区分大小写 / 全字 / 正则
 *   - a broken regex is reported, not searched
 *   - the view registry hands the controller to the widget
 *
 * The DOM parts run in headless Chrome (a TreeWalker is needed); the wiring
 * checks read the shipped sources.
 *
 * Usage: node work/harnesses/filesearch-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 300)}`}`)
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

/* --------------------------------------------------------- wiring checks */

console.log('\n[1] the feature is wired into the plugin')
const appSource = fs.readFileSync(path.join(SRC, '50-app.js'), 'utf8')
const searchSource = fs.readFileSync(path.join(SRC, '26-filesearch.js'), 'utf8')
const codeSource = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
const mdSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
check('Ctrl+F is handled by the App', /event\.key\.toLowerCase\(\) === 'f'/.test(appSource))
check('the app opens the file search', /openFileSearch\(\)/.test(appSource))
check('the widget is rendered', /FileSearchWidget/.test(appSource))
check('the markdown view registers a controller', /registerFileSearchController/.test(mdSource))
check('the code view registers a controller', /registerFileSearchController/.test(codeSource))
check('the search marks have styles', /mdr-fs-mark/.test(searchSource) && /mdr-fs-cur/.test(searchSource))
check('the code rows can carry a search mark', /mdr-fs-line/.test(codeSource) && /mdr-fs-cur/.test(codeSource))
check('the search runs on Enter, not per keystroke', /event\.key === 'Enter'/.test(searchSource))
check('the three switches exist', /fileSearchRegex/.test(searchSource) && /opts\.cs/.test(searchSource) && /opts\.word/.test(searchSource) && /opts\.re/.test(searchSource))
check('the bundle contains the new part', fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8').includes('FileSearchWidget'))

/* --------------------------------------------- the code modal (弹窗) scope */

console.log('\n[1b] Ctrl+F inside the code modal searches the MODAL, not the tab')
const modalSource = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
// The standalone reader resolved the scope as 「弹窗优先，其次标签页」
// (`fsResolveScope`) and re-positioned its widget into the popup. The plugin
// only looked at the active tab, so Ctrl+F inside the popup searched the tab
// behind it and nothing was highlighted where the user was looking.
check('the modal owns a search key', /MODAL_SEARCH_KEY/.test(searchSource))
check('the modal registers its code body for search', /searchKey:\s*[^,\n]*MODAL_SEARCH_KEY/.test(modalSource))
check('the App prefers the modal controller', /modalRequest\s*\?/.test(appSource) && /fileSearchController\([^)]*MODAL_SEARCH_KEY/.test(appSource))
check('the bar is handed to the modal', /searchBar:\s*fileSearchBar/.test(appSource))
check('the modal renders the bar inside its card', /searchBar\s*\|\|\s*null/.test(modalSource))
check('the bar is only rendered in the panel without a modal', /!modalRequest \? fileSearchBar : null/.test(appSource))
check('Esc closes the search before the popup', /onCloseSearch/.test(modalSource) && /searchOpen/.test(modalSource))
check('the bar has an in-modal style', /\.mdr-cmodal-body \.mdr-fs/.test(searchSource))
check('the global-search button is hidden inside the modal', /onGlobal:\s*modalRequest/.test(appSource))

/* ----------------------------------------------------------- DOM checks */

const chrome = findChrome()
if (!chrome) {
  console.log('\nSKIP: no Chromium binary found (set CHROME_PATH)')
} else {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '26-filesearch.js').replace(/\\/g, '/')}"></script>
<pre id="out"></pre>
<script>
const html = '<h2>preSync 游标翻页</h2><p>用 <code>lastId</code> 推进游标，避免 <b>OFFSET</b> 漂移。</p><p>lastId 取原始批次，lastId 不是过滤后的批次。</p>'
const container = document.createElement('div')
container.className = 'mdr-md'
container.innerHTML = html
document.body.appendChild(container)
const original = container.textContent
const report = {}
try {
  const marks = mdSearchFind(container, 'lastId', {})
  report.marks = marks.length
  report.markClass = marks.map((m) => m.className)
  report.markText = marks.map((m) => m.textContent)
  report.textAfter = container.textContent
  report.sameText = container.textContent === original
  mdSearchClear(container)
  report.cleared = container.textContent
  report.restored = container.textContent === original
  report.marksLeft = container.querySelectorAll('mark.mdr-fs-mark').length

  const cs = mdSearchFind(container, 'LASTID', { cs: true })
  report.csCount = cs.length
  mdSearchClear(container)
  const ci = mdSearchFind(container, 'LASTID', {})
  report.ciCount = ci.length
  mdSearchClear(container)
  const word = mdSearchFind(container, 'last', { word: true })
  report.wordCount = word.length
  mdSearchClear(container)
  const re = mdSearchFind(container, 'last[A-Za-z]+', { re: true })
  report.reCount = re.length
  mdSearchClear(container)

  report.badRegex = fileSearchRegex('(', { re: true })
  report.badRegexIsNull = fileSearchRegex('(', { re: true }) === null
  report.matchesIn = fileSearchMatchesIn('aaaa', /a/g)
  report.registry = (function () {
    registerFileSearchController('t1', { kind: 'md' })
    const found = fileSearchController('t1')
    unregisterFileSearchController('t1')
    return { found: !!found, after: fileSearchController('t1') }
  })()
} catch (error) {
  report.error = String(error && error.message ? error.message : error)
}
document.getElementById('out').textContent = JSON.stringify(report)
</script></body></html>`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-fs-'))
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
        '--virtual-time-budget=6000',
        '--dump-dom',
        `file:///${path.join(tmp, 'index.html').replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    )
  } catch (error) {
    console.log('chrome failed:', error.message)
  }
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    check('the search engine ran', false, 'no output')
  } else {
    const report = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    console.log('\n[2] the markdown search')
    check('no error', !report.error, report.error)
    check('every occurrence is found (3)', report.marks === 3, report.marks)
    check('the marks carry the search class', (report.markClass || []).every((cls) => cls === 'mdr-fs-mark'), report.markClass)
    check('the mark text is the match', (report.markText || []).every((text) => text === 'lastId'), report.markText)
    check('the text is unchanged by the search', report.sameText === true)
    check('clearing restores the text', report.restored === true, report.cleared)
    check('no mark survives the clear', report.marksLeft === 0, report.marksLeft)

    console.log('\n[3] the switches')
    check('case sensitive finds nothing for LASTID', report.csCount === 0, report.csCount)
    check('case insensitive finds the three', report.ciCount === 3, report.ciCount)
    check('whole word does not match a prefix', report.wordCount === 0, report.wordCount)
    check('the regex switch works', report.reCount === 3, report.reCount)
    check('a broken regex is refused', report.badRegexIsNull === true)

    console.log('\n[4] the registry and the matcher')
    check('all occurrences are listed', JSON.stringify(report.matchesIn) === JSON.stringify([[0, 1], [1, 2], [2, 3], [3, 4]]), report.matchesIn)
    check('a registered controller is found', report.registry && report.registry.found === true)
    check('an unregistered controller is gone', report.registry && report.registry.after === null)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall file search checks passed')
if (failures) process.exitCode = 1
