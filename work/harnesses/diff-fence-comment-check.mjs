/**
 * Markdown diff fence: unterminated multi-line comment check (headless Chrome).
 *
 * Bug (2026-11-06): a diff fragment that ends with an OPEN block comment
 * (the javadoc opener of a hunk whose closer is not part of the hunk) made
 * hljs treat the REST OF THE FRAGMENT as comment text - so every following
 * row of the same hunk/file was painted as a comment and lost its own
 * highlighting.
 *
 * This check renders every ```diff block of a document and flags rows whose
 * HTML says "comment" while their source line is obviously NOT a comment
 * (a comment line starts with a line comment, a block comment opener or a
 * javadoc continuation star).
 *
 * Usage: node work/harnesses/diff-fence-comment-check.mjs [doc.md ...]
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
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

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

const docs = process.argv.slice(2)
if (!docs.length) {
  console.log('usage: node work/harnesses/diff-fence-comment-check.mjs <doc.md ...>')
  process.exitCode = 1
} else {
  const blocks = []
  const labels = []
  for (const doc of docs) {
    if (!fs.existsSync(doc)) {
      console.log(`SKIP (missing): ${doc}`)
      continue
    }
    const md = fs.readFileSync(doc, 'utf8')
    const list = [...md.matchAll(/```(?:diff|git-diff|patch)\r?\n([\s\S]*?)```/g)]
    list.forEach((match, index) => {
      blocks.push(match[1])
      labels.push(`${path.basename(doc)} #${index + 1}`)
    })
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  } else {
    const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<pre id="out"></pre>
<script>
const blocks = ${JSON.stringify(blocks)}
const report = blocks.map((source) => {
  const html = renderDiffFenceHtml(source)
  const holder = document.createElement('div')
  holder.innerHTML = html
  const parsed = parseDiffFenceRows(source).filter((r) => r.kind === 'ctx' || r.kind === 'add' || r.kind === 'del')
  const rows = [...holder.querySelectorAll('.mdr-cl')].filter((r) => /mdr-git-(ctx|add|del)/.test(r.className))
  let drift = 0
  let swallowed = 0
  let sample = ''
  rows.forEach((row, index) => {
    const text = parsed[index] ? parsed[index].text : ''
    if (row.textContent.replace(/^[+− ]/, '') !== text) drift += 1
    const isCommentLine = /^\\s*(\\/\\/|\\/\\*|\\*|\\*\\/)/.test(text)
    const painted = row.querySelector('.hljs-comment') !== null
    if (painted && !isCommentLine) {
      swallowed += 1
      if (!sample) sample = text.slice(0, 70)
    }
  })
  return { rows: rows.length, expected: parsed.length, drift, swallowed, sample }
})
document.getElementById('out').textContent = JSON.stringify(report)
</script></body></html>`
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-comment-'))
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
          '--virtual-time-budget=8000',
          '--dump-dom',
          `file:///${path.join(tmp, 'index.html').replace(/\\/g, '/')}`,
        ],
        { encoding: 'utf8', timeout: 120000, windowsHide: true },
      )
    } catch (error) {
      console.log('chrome failed:', error.message)
      process.exitCode = 1
    }
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
    if (!match) {
      check('the diff blocks render', false, 'no output')
    } else {
      const report = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      report.forEach((row, index) => {
        const label = labels[index] || `block ${index + 1}`
        check(`${label}: rows match the diff (no drift)`, row.drift === 0 && row.rows === row.expected, JSON.stringify(row))
        check(`${label}: no code line swallowed by an unterminated comment`, row.swallowed === 0, `${row.swallowed} row(s), e.g. ${row.sample}`)
      })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall diff fence comment checks passed')
if (failures) process.exitCode = 1
