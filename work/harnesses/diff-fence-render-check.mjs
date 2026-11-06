/**
 * Markdown diff fence: REAL rendering check (headless Chrome).
 *
 * The Node harness can only cover the pure parts (parser, escaping). The
 * rendering needs a DOM (highlightToLines) and hljs, so this check runs the
 * SHIPPED client sources (plugin/src-client/00-core.js + 20-code.js) plus the
 * vendored highlight.js in a real browser and inspects the produced HTML:
 *
 *   - NO line-number column (the user asked for the code part only)
 *   - the code part IS syntax highlighted (hljs spans), with the language
 *     taken from the diffed file path
 *   - added rows green, deleted rows red + strike-through, context neutral
 *   - content stays escaped
 *
 * Usage: node work/harnesses/diff-fence-render-check.mjs
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

const SAMPLE = [
  'diff --git a/src/main/resources/mapper/SyncEzrMapper.xml b/src/main/resources/mapper/SyncEzrMapper.xml',
  'index 81882fa..5273b3c 100644',
  '--- a/src/main/resources/mapper/SyncEzrMapper.xml',
  '+++ b/src/main/resources/mapper/SyncEzrMapper.xml',
  '@@ -622,10 +622,12 @@',
  '     </select>',
  ' ',
  '     <select id="queryCustomerServInfo" resultType="com.pvh.biz.model.dto.ezr.CustomerServInfoDTO">',
  '-        select ac.customer_id, ac.associate_id, ac.associate_code, ua.store_id, s.store_code',
  '+        select ac.customer_id, ac.associate_id, ac.associate_code,',
  '+               IFNULL(s1.id, s.id) as store_id, IFNULL(s1.store_code, s.store_code) as store_code',
  '         from user.associate_customer ac',
  '-        inner join user.associate ua on ua.id = ac.associate_id',
  '-        left join user.store s on s.id = ua.store_id',
  '+        left join user.associate ua on ua.id = ac.associate_id',
  '+        left join user.store s on s.id = ac.store_id',
  '+        left join user.store s1 on s1.id = ua.store_id',
  '         where ac.is_deleted = 0 and ac.relation_type = 3 and ac.active_flag = 1',
  '         and ac.customer_id in',
  '         <foreach item="item" collection="customerIds" separator="," open="(" close=")" index="">',
  '',
].join('\n')

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
  process.exitCode = 0
} else {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<pre id="out"></pre>
<script>
const sample = ${JSON.stringify(SAMPLE)}
try {
  document.getElementById('out').textContent = renderDiffFenceHtml(sample)
} catch (error) {
  document.getElementById('out').textContent = 'ERROR: ' + error.message
}
</script>
</body></html>`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-difffence-'))
  const file = path.join(tmp, 'index.html')
  fs.writeFileSync(file, page, 'utf8')
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
        '--virtual-time-budget=4000',
        '--dump-dom',
        `file:///${file.replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    )
  } catch (error) {
    console.log('chrome failed:', error.message)
    process.exitCode = 1
  }
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
  if (!match) {
    console.log('no rendered output in the DOM')
    console.log(dom.slice(0, 500))
    process.exitCode = 1
  } else {
    const html = match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
    console.log('\n[1] no line-number column')
    check('no .mdr-cl-no element', !html.includes('mdr-cl-no'), html.slice(0, 200))
    console.log('\n[2] syntax highlighting of the code part')
    check('hljs spans are present', /class="hljs-[a-z_]+/.test(html), html.slice(0, 300))
    check('xml tags are highlighted', html.includes('hljs-tag') || html.includes('hljs-name'), html.slice(0, 300))
    check('string/attr values are highlighted', html.includes('hljs-string') || html.includes('hljs-attr'), html.slice(0, 300))
    console.log('\n[3] diff rows')
    check('added row class', html.includes('mdr-git-add'))
    check('deleted row class', html.includes('mdr-git-del'))
    check('context row class', html.includes('mdr-git-ctx'))
    check('hunk header class', html.includes('mdr-diff-hunk'))
    check('file header class', html.includes('mdr-diff-meta'))
    check('sign column present', html.includes('mdr-diff-sign'))
    console.log('\n[4] safety')
    check('no raw script tag', !/<script/i.test(html))
    console.log(`\nrendered ${html.length} chars, ${(html.match(/class="mdr-cl /g) || []).length} rows`)

    // The shipped demo document must render by the same rules.
    const demoPath = path.join(ROOT, 'docs', 'demo-diff-fence.md')
    if (fs.existsSync(demoPath)) {
      console.log('\n[5] the demo document (docs/demo-diff-fence.md)')
      const demo = fs.readFileSync(demoPath, 'utf8')
      const blocks = [...demo.matchAll(/```diff\n([\s\S]*?)```/g)].map((match) => match[1])
      check('the demo has diff blocks', blocks.length >= 4, blocks.length)
      const demoPage = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '00-core.js').replace(/\\/g, '/')}"></script>
<script src="${path.join(SRC, '20-code.js').replace(/\\/g, '/')}"></script>
<pre id="out"></pre>
<script>
const blocks = ${JSON.stringify(blocks)}
const report = blocks.map((source) => {
  const html = renderDiffFenceHtml(source)
  return {
    rows: (html.match(/class="mdr-cl /g) || []).length,
    numbers: html.includes('mdr-cl-no'),
    hljs: /class="hljs-/.test(html),
    hasFileHeader: /^diff --git|^\\+\\+\\+ b\\//m.test(source),
  }
})
document.getElementById('out').textContent = JSON.stringify(report)
</script></body></html>`
      const demoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-demo-'))
      fs.writeFileSync(path.join(demoTmp, 'index.html'), demoPage, 'utf8')
      let demoDom = ''
      try {
        demoDom = execFileSync(
          chrome,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--allow-file-access-from-files',
            `--user-data-dir=${path.join(demoTmp, 'profile')}`,
            '--virtual-time-budget=4000',
            '--dump-dom',
            `file:///${path.join(demoTmp, 'index.html').replace(/\\/g, '/')}`,
          ],
          { encoding: 'utf8', timeout: 60000, windowsHide: true },
        )
      } catch (error) {
        console.log('chrome failed for the demo page:', error.message)
      }
      const demoMatch = /<pre id="out">([\s\S]*?)<\/pre>/.exec(demoDom)
      if (!demoMatch) {
        check('the demo document renders', false, 'no output')
      } else {
        const report = JSON.parse(demoMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
        report.forEach((row, index) => {
          check(`demo block ${index + 1}: no line-number column`, row.numbers === false, JSON.stringify(row))
          if (row.hasFileHeader) {
            check(`demo block ${index + 1}: code is highlighted`, row.hljs === true, JSON.stringify(row))
          } else {
            check(`demo block ${index + 1}: no file header -> no highlighting`, row.hljs === false, JSON.stringify(row))
          }
          check(`demo block ${index + 1}: rows rendered`, row.rows > 0, JSON.stringify(row))
        })
      }
      fs.rmSync(demoTmp, { recursive: true, force: true })
    }

    // Real documents: every ```diff block of a directory (default: the CK
    // project's docs) must render row by row, with the row showing its own
    // line and the code part highlighted.
    const auditDirs = process.argv.slice(2)
    const targets = auditDirs.length
      ? auditDirs
      : ['C:/Users/1/Desktop/work/tasks/20260917-微服务/docs'].filter((dir) => fs.existsSync(dir))
    for (const dir of targets) {
      if (!fs.existsSync(dir)) continue
      const files = []
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.md$/i.test(entry.name)) files.push(full)
        }
      }
      walk(dir)
      const blocks = []
      const labels = []
      for (const file of files) {
        const md = fs.readFileSync(file, 'utf8')
        const list = [...md.matchAll(/```(?:diff|git-diff|patch)\r?\n([\s\S]*?)```/g)]
        list.forEach((match, index) => {
          blocks.push(match[1])
          labels.push(`${path.relative(dir, file)} #${index + 1}`)
        })
      }
      console.log(`\n[6] real documents in ${dir} (${files.length} files, ${blocks.length} diff blocks)`)
      if (!blocks.length) {
        check('the directory has diff blocks to check', false, dir)
        continue
      }
      const auditPage = `<!doctype html><html><head><meta charset="utf-8"></head><body>
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
  const rows = [...holder.querySelectorAll('.mdr-cl')]
    .filter((row) => /mdr-git-(ctx|add|del)/.test(row.className))
    .map((row) => row.textContent.replace(/^[+− ]/, ''))
  const parsed = parseDiffFenceRows(source).filter((r) => r.kind === 'ctx' || r.kind === 'add' || r.kind === 'del')
  let drift = 0
  parsed.forEach((row, index) => { if (rows[index] !== row.text) drift += 1 })
  return { rows: rows.length, expected: parsed.length, drift, hljs: (html.match(/class="hljs-/g) || []).length }
})
document.getElementById('out').textContent = JSON.stringify(report)
</script></body></html>`
      const auditTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-audit-'))
      fs.writeFileSync(path.join(auditTmp, 'index.html'), auditPage, 'utf8')
      let auditDom = ''
      try {
        auditDom = execFileSync(
          chrome,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--allow-file-access-from-files',
            `--user-data-dir=${path.join(auditTmp, 'profile')}`,
            '--virtual-time-budget=8000',
            '--dump-dom',
            `file:///${path.join(auditTmp, 'index.html').replace(/\\/g, '/')}`,
          ],
          { encoding: 'utf8', timeout: 120000, windowsHide: true },
        )
      } catch (error) {
        console.log('chrome failed for the audit page:', error.message)
      }
      const auditMatch = /<pre id="out">([\s\S]*?)<\/pre>/.exec(auditDom)
      if (!auditMatch) {
        check('the real documents render', false, 'no output')
      } else {
        const report = JSON.parse(auditMatch[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
        const drifted = report.filter((row) => row.drift > 0 || row.rows !== row.expected)
        check(`all ${report.length} real diff blocks render row by row`, drifted.length === 0, JSON.stringify(drifted.slice(0, 3)))
        const unhighlighted = report.filter((row) => row.hljs === 0)
        check('every real diff block is highlighted', unhighlighted.length === 0, `${unhighlighted.length} block(s) without hljs`)
      }
      fs.rmSync(auditTmp, { recursive: true, force: true })
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall diff fence render checks passed')
if (failures) process.exitCode = 1
