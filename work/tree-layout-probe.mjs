/**
 * Tree row alignment probe (headless Chrome).
 *
 * The plugin tree row is a flex line whose leading children are the indent
 * caret and the file icon. If the caret is allowed to shrink, a row with a very
 * long file name squeezes it and the icon/name of that row start at a
 * different x than its siblings — the "同级文件左侧对不齐" report.
 *
 * This script extracts the real APP_CSS from the client sources, renders the
 * same row structure in a 262px tree column, measures the left offset of the
 * icon and of the name for every row, and prints the table.
 *
 * Usage: node work/tree-layout-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

/** The client CSS lives in a template literal inside 00-core.js. */
function appCss() {
  const source = fs.readFileSync(path.join(ROOT, 'plugin', 'src-client', '00-core.js'), 'utf8')
  const start = source.indexOf('const APP_CSS = `')
  if (start < 0) throw new Error('APP_CSS not found in 00-core.js')
  const from = start + 'const APP_CSS = `'.length
  const end = source.indexOf('`', from)
  return source.slice(from, end)
}

const ROWS = [
  { name: '需求梳理.md' },
  { name: '查询员工不可内购商品-YApi-高效、易用、功能强大的可视化接口管理平台.html' },
  { name: '杂项.md' },
  { name: '20261104-1105版本需求梳理.md' },
]

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${appCss()}
body{margin:0}
</style></head><body>
<div class="mdr-tree" id="tree" style="width:262px">
${ROWS.map(
  (row, index) => `<div class="mdr-tr" style="padding-left:${6 + 2 * 14}px">
    <span class="mdr-caret"></span>
    <span class="mdr-ticon" style="color:#57A773"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/></svg></span>
    <span class="mdr-tname">${row.name}</span>
  </div>`,
).join('\n')}
</div>
<pre id="out"></pre>
<script>
const rows = [...document.querySelectorAll('.mdr-tr')]
const lines = rows.map((row) => {
  const icon = row.querySelector('.mdr-ticon').getBoundingClientRect()
  const name = row.querySelector('.mdr-tname').getBoundingClientRect()
  const caret = row.querySelector('.mdr-caret').getBoundingClientRect()
  const label = row.querySelector('.mdr-tname').textContent
  return [label.slice(0, 26).padEnd(28), 'caretLeft=' + caret.left.toFixed(2),
          'caretW=' + caret.width.toFixed(2), 'iconLeft=' + icon.left.toFixed(2),
          'nameLeft=' + name.left.toFixed(2), 'nameW=' + name.width.toFixed(2)].join(' ')
})
const iconLefts = rows.map((row) => row.querySelector('.mdr-ticon').getBoundingClientRect().left)
const nameLefts = rows.map((row) => row.querySelector('.mdr-tname').getBoundingClientRect().left)
const spread = (list) => (Math.max(...list) - Math.min(...list)).toFixed(2)

// Long file names must stay fully readable: the tree scrolls horizontally.
const tree = document.getElementById('tree')
const canScrollX = tree.scrollWidth > tree.clientWidth + 1
tree.scrollLeft = 400
const scrolled = tree.scrollLeft
// The toolbar is sticky in both axes, so it must stay pinned at the left edge.
const toolbar = document.createElement('div')
toolbar.className = 'mdr-tree-toolbar'
toolbar.textContent = 'toolbar'
tree.insertBefore(toolbar, tree.firstChild)
tree.scrollLeft = 400
const toolbarLeft = toolbar.getBoundingClientRect().left - tree.getBoundingClientRect().left
const clipped = rows.some((row) => {
  const name = row.querySelector('.mdr-tname')
  return name.scrollWidth > name.clientWidth + 1
})
document.getElementById('out').textContent =
  lines.join('\\n') + '\\niconLeftSpread=' + spread(iconLefts) + ' nameLeftSpread=' + spread(nameLefts) +
  '\\ncanScrollX=' + canScrollX + ' scrollLeftAfterSet=' + scrolled +
  ' toolbarLeftAfterScroll=' + toolbarLeft.toFixed(2) + ' namesClipped=' + clipped
</script></body></html>`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-tree-probe-'))
const file = path.join(tmp, 'index.html')
fs.writeFileSync(file, html, 'utf8')

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  process.exitCode = 0
} else {
  const profile = path.join(tmp, 'profile')
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=3000',
    '--dump-dom',
    `file:///${file.replace(/\\/g, '/')}`,
  ]
  let dom = ''
  try {
    dom = execFileSync(chrome, args, { encoding: 'utf8', timeout: 60000, windowsHide: true })
  } catch (error) {
    console.log('chrome failed:', error.message)
    process.exitCode = 1
  }
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    console.log('no measurement in DOM output')
    console.log(dom.slice(0, 400))
    process.exitCode = 1
  } else {
    const text = match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    console.log(text.trim())
    const failures = []
    const spread = /nameLeftSpread=([\d.]+)/.exec(text)
    if (spread && Number(spread[1]) > 0.5) failures.push(`icon/name left offsets differ by ${spread[1]}px between sibling rows`)
    if (/canScrollX=false/.test(text)) failures.push('long file names are not readable: the tree cannot scroll horizontally')
    if (/namesClipped=true/.test(text)) failures.push('some file names are still truncated (ellipsis)')
    if (/toolbarLeftAfterScroll=-?\d/.test(text)) {
      const toolbar = /toolbarLeftAfterScroll=(-?[\d.]+)/.exec(text)
      if (toolbar && Math.abs(Number(toolbar[1])) > 1) failures.push(`the tree toolbar drifts when scrolling horizontally (left=${toolbar[1]})`)
    }
    if (failures.length) {
      for (const failure of failures) console.log(`\nFAIL: ${failure}`)
      process.exitCode = 1
    } else {
      console.log('\nPASS: every sibling row starts at the same x; long names stay readable')
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
