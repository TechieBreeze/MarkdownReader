/**
 * Markdown diff fence: ```diff renders like the commit-diff view (regression).
 *
 * Format contract (also documented in the markdown-reader skill):
 *   - fence language `diff` (aliases `git-diff`, `patch`)
 *   - content is a standard unified diff (git diff / git show --patch output)
 *   - one line-number column: deleted rows carry the OLD number, others the NEW
 *   - +/- gutter sign, green added rows, red struck-through deleted rows,
 *     neutral context rows, dimmed file/hunk header rows
 *   - the hunk header's declared counts are authoritative (a trailing newline
 *     in the patch must not become a row)
 *   - every piece of content is escaped
 *
 * Usage: node work/harnesses/diff-fence-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
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

/** Lift real functions out of the shipped sources (no copies). */
function lift(file, names, extra = '') {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  const parts = []
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`${name} not found in ${file}`)
    const end = source.indexOf('\nfunction ', start + 10)
    parts.push(source.slice(start, end < 0 ? source.length : end))
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${parts.join('\n')}\n${extra}\nreturn { ${names.join(', ')} }`)()
}

/** The module-level constant the lifted code closes over. */
function constOf(file, name) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  const start = source.indexOf(`const ${name} =`)
  if (start < 0) throw new Error(`${name} not found in ${file}`)
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end < 0 ? source.length : end)
}

const core = lift('00-core.js', ['escapeHtml', 'extOf'])
const code = lift(
  '20-code.js',
  ['parseDiffFenceRows', 'renderDiffFenceHtml', 'isDiffFenceLang', 'diffFenceSections', 'langForPath', 'highlightDiffFragment'],
  `${constOf('20-code.js', 'DIFF_FENCE_LANGS')}\n${constOf('20-code.js', 'LANG_MAP')}\nconst escapeHtml = ${core.escapeHtml.toString()}\nconst extOf = ${core.extOf.toString()}`,
)

/* ------------------------------------------------------------- the sample */

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

console.log('\n[1] fence language detection')
check('diff is a diff fence', code.isDiffFenceLang('diff'))
check('git-diff is a diff fence', code.isDiffFenceLang('git-diff'))
check('patch is a diff fence', code.isDiffFenceLang('patch'))
check('DIFF is a diff fence (case-insensitive)', code.isDiffFenceLang('DIFF'))
check('java is NOT a diff fence', !code.isDiffFenceLang('java'))
check('empty is NOT a diff fence', !code.isDiffFenceLang(''))

console.log('\n[2] rows of a unified diff')
const rows = code.parseDiffFenceRows(SAMPLE)
const meta = rows.filter((row) => row.kind === 'meta')
const hunk = rows.filter((row) => row.kind === 'hunk')
const add = rows.filter((row) => row.kind === 'add')
const del = rows.filter((row) => row.kind === 'del')
const ctx = rows.filter((row) => row.kind === 'ctx')
check('the 4 file headers become meta rows', meta.length === 4, meta.length)
check('hunk header row', hunk.length === 1 && hunk[0].text.startsWith('@@ -622,10 +622,12 @@'), hunk.length)
check('5 added rows', add.length === 5, add.length)
check('3 deleted rows', del.length === 3, del.length)
check('7 context rows', ctx.length === 7, ctx.length)
check('the hunk body has exactly the declared 15 lines', add.length + del.length + ctx.length === 15, add.length + del.length + ctx.length)
check('no phantom row from the trailing newline', rows[rows.length - 1].kind === 'ctx' && rows[rows.length - 1].no === 633, JSON.stringify(rows[rows.length - 1]))
check('deleted rows carry the OLD line number', JSON.stringify(del.map((row) => row.no)) === '[625,627,628]', JSON.stringify(del.map((row) => row.no)))
check('added rows carry the NEW line number', JSON.stringify(add.map((row) => row.no)) === '[625,626,628,629,630]', JSON.stringify(add.map((row) => row.no)))
check('context rows carry the NEW line number', JSON.stringify(ctx.map((row) => row.no)) === '[622,623,624,627,631,632,633]', JSON.stringify(ctx.map((row) => row.no)))
const noNewline = code.parseDiffFenceRows(['@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n'))
check('the "No newline" marker is a meta row', noNewline[noNewline.length - 1].kind === 'meta' && noNewline[noNewline.length - 1].text.startsWith('\\'), JSON.stringify(noNewline[noNewline.length - 1]))

console.log('\n[3] rendered HTML')
const html = code.renderDiffFenceHtml(SAMPLE)
check('added rows carry the add class', html.includes('mdr-git-add'))
check('deleted rows carry the del class', html.includes('mdr-git-del'))
check('context rows carry the ctx class', html.includes('mdr-git-ctx'))
check('hunk header has its own class', html.includes('mdr-diff-hunk'))
check('file headers have the meta class', html.includes('mdr-diff-meta'))
check('sign column present', html.includes('mdr-diff-sign'))
check('NO line-number column (the code part only)', !html.includes('mdr-cl-no'), html.slice(0, 200))
check('added row signs with +', /mdr-git-add[^]*?mdr-diff-sign">\+</.test(html))
check('deleted row signs with the minus sign', /mdr-git-del[^]*?mdr-diff-sign">−</.test(html))

console.log('\n[4] safety')
const injected = code.renderDiffFenceHtml(['@@ -1,1 +1,1 @@', '+<img src=x onerror="alert(1)">', ' ctx'].join('\n'))
check('diff content is escaped', !injected.includes('<img') && injected.includes('&lt;img'), injected.slice(0, 240))
check('no raw script tag survives', !/<script/i.test(injected))

console.log('\n[5] the markdown view routes diff fences to the renderer')
const markdownSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
check('10-markdown dispatches diff fences', /isDiffFenceLang/.test(markdownSource) && /renderDiffFenceHtml/.test(markdownSource))
check('the diff block gets its own wrapper', /mdr-md-diff/.test(markdownSource))
check('other fences still use the highlighter', /renderFenceCodeHtml/.test(markdownSource))

console.log('\n[6] sections: the diffed file decides the highlighting language')
const sections = code.diffFenceSections
  ? code.diffFenceSections(rows)
  : null
if (sections) {
  check('one section for one file', sections.length === 1, sections.length)
  check('the file path comes from the patch header', sections[0].path === 'src/main/resources/mapper/SyncEzrMapper.xml', sections[0].path)
  check('the language comes from the file extension', sections[0].lang === 'xml', sections[0].lang)
} else {
  check('diffFenceSections is exported', false, 'missing')
}

console.log('\n[7] a hunk header with the WRONG counts keeps the whole body')
// The real case: docs/设计/20261105/preSync游标翻页改造详细设计说明书.md declares
// `@@ -11,21 +11,21 @@` over a 22-line body. Cutting the body there lost the
// tail of the change, so the doc "did not render".
const wrong = code.parseDiffFenceRows(
  ['@@ -11,21 +11,21 @@', ' context one', '-old line', '+new line', ' context two', ' context three', ''].join('\n'),
)
const wrongBody = wrong.filter((row) => row.kind === 'ctx' || row.kind === 'add' || row.kind === 'del')
check('the whole body is kept (3 ctx + 1 del + 1 add)', wrongBody.length === 5, wrongBody.length)
check('the last context line is still a context row', wrongBody[4].kind === 'ctx' && wrongBody[4].text === 'context three', JSON.stringify(wrongBody[4]))
check('no phantom row from the trailing newline', wrongBody.every((row) => row.text !== ''))
const wrongHtml = code.renderDiffFenceHtml(
  ['@@ -11,21 +11,21 @@', ' context one', '-old line', '+new line', ' context two', ' context three', ''].join('\n'),
)
check('the tail still renders as diff rows', wrongHtml.includes('mdr-git-ctx') && wrongHtml.includes('context three'), wrongHtml.slice(-200))

console.log('\n[8] the real design document with hand-written diffs')
const designDoc = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'
if (fs.existsSync(designDoc)) {
  const md = fs.readFileSync(designDoc, 'utf8')
  const blocks = [...md.matchAll(/```diff\r?\n([\s\S]*?)```/g)].map((match) => match[1])
  check('the document has diff blocks', blocks.length >= 10, blocks.length)
  let lost = 0
  for (const block of blocks) {
    const bodyLines = block
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => !/^(--- |\+\+\+ |diff --git |index |@@ )/.test(line))
    const parsed = code.parseDiffFenceRows(block).filter((row) => row.kind === 'ctx' || row.kind === 'add' || row.kind === 'del')
    if (parsed.length !== bodyLines.length) lost += 1
  }
  check('no block loses a body line', lost === 0, `${lost} block(s) lost lines`)
} else {
  check('the design document is reachable', false, designDoc)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall diff fence checks passed')
if (failures) process.exitCode = 1
