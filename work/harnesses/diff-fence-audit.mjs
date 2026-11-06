/**
 * Diff fence AUDIT: check every ```diff block of a directory of markdown files.
 *
 * The unit harnesses cover the parser with synthetic patches; this one checks
 * the REAL documents (the design docs of the CK project) against the same
 * contract:
 *
 *   - every body line of the patch becomes a code row (nothing is dropped into
 *     a dim header row)
 *   - every rendered row shows exactly its own line (no old/new side drift)
 *   - the hunk header's declared counts are only a HINT: a wrong count must
 *     not lose a line (reported as info, not as an error)
 *   - no row of the patch is silently missing (meta rows included)
 *
 * Usage:
 *   node work/harnesses/diff-fence-audit.mjs [dir ...]
 *   (no argument -> the docs folder of the CK project if it exists)
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

/** Lift the real functions out of the shipped sources (no copies). */
function lift(file, names, extra = '') {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  const parts = []
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`${name} not found in ${file}`)
    const end = source.indexOf('\nfunction ', start + 10)
    parts.push(source.slice(start, end < 0 ? source.length : end))
  }
  return new Function(`${parts.join('\n')}\n${extra}\nreturn { ${names.join(', ')} }`)()
}
function constOf(file, name) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  const start = source.indexOf(`const ${name} =`)
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end < 0 ? source.length : end)
}

const core = lift('00-core.js', ['escapeHtml', 'extOf'])
const code = lift(
  '20-code.js',
  ['parseDiffFenceRows', 'renderDiffFenceHtml', 'diffFenceSections', 'langForPath', 'diffPlainText', 'isDiffFileHeaderLine'],
  `${constOf('20-code.js', 'DIFF_FENCE_LANGS')}\n${constOf('20-code.js', 'LANG_MAP')}\nconst escapeHtml = ${core.escapeHtml.toString()}\nconst extOf = ${core.extOf.toString()}`,
)

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'target') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.md$/i.test(entry.name)) out.push(full)
  }
  return out
}

/** The body rows a patch really has (independent of the parser). */
function expectedBody(source) {
  const body = []
  let inHunk = false
  for (const line of source.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('diff --git ') || /^(---|\+\+\+) (a\/|b\/|\/dev\/null)/.test(line)) {
      inHunk = false
      continue
    }
    if (line.startsWith('\\')) continue
    body.push(line)
  }
  return body
}

const dirs = process.argv.slice(2)
const targets = dirs.length
  ? dirs
  : ['C:/Users/1/Desktop/work/tasks/20260917-微服务/docs', path.join(ROOT, 'docs')].filter((dir) => fs.existsSync(dir))

let fileCount = 0
let blockCount = 0
let wrongCounts = 0
const errors = []

for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.log(`skip ${dir} (not found)`)
    continue
  }
  for (const file of walk(dir)) {
    fileCount += 1
    const md = fs.readFileSync(file, 'utf8')
    const blocks = [...md.matchAll(/```(?:diff|git-diff|patch)\r?\n([\s\S]*?)```/g)]
    blocks.forEach((match, index) => {
      blockCount += 1
      const source = match[1]
      const label = `${path.relative(dir, file)} block ${index + 1}`
      const rows = code.parseDiffFenceRows(source)
      const parsed = rows.filter((row) => row.kind === 'ctx' || row.kind === 'add' || row.kind === 'del')
      const body = expectedBody(source)
      if (parsed.length !== body.length) {
        errors.push(`${label}: ${parsed.length} code rows for ${body.length} body lines`)
        return
      }
      const drift = parsed.findIndex((row, i) => row.text !== body[i].slice(1))
      if (drift >= 0) {
        errors.push(`${label}: row ${drift + 1} shows ${JSON.stringify(parsed[drift].text)} instead of ${JSON.stringify(body[drift])}`)
        return
      }
      // nothing of the patch may fall out of the hunk into a header row
      const stray = rows.filter((row) => row.kind === 'meta' && !/^(diff --git |--- |\+\+\+ |index )/.test(row.text))
      if (stray.length) errors.push(`${label}: ${stray.length} body line(s) turned into header rows`)
      // the declared counts are a hint: a wrong count is worth reporting
      for (const header of source.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const declaredOld = header[2] === undefined ? 1 : Number(header[2])
        const declaredNew = header[4] === undefined ? 1 : Number(header[4])
        let oldCount = 0
        let newCount = 0
        for (const line of source.slice(header.index).split('\n').slice(1)) {
          if (/^@@ /.test(line) || line.startsWith('diff --git ') || /^(---|\+\+\+) (a\/|b\/|\/dev\/null)/.test(line)) break
          if (line.startsWith('\\')) continue
          if (line.startsWith('-')) oldCount += 1
          else if (line.startsWith('+')) newCount += 1
          else {
            oldCount += 1
            newCount += 1
          }
        }
        if (oldCount !== declaredOld || newCount !== declaredNew) {
          wrongCounts += 1
          console.log(`  note ${label}: hunk declares ${declaredOld}/${declaredNew} but has ${oldCount}/${newCount} (counts are a hint - no line lost)`)
        }
      }
    })
  }
}

console.log(`\nfiles: ${fileCount}, diff blocks: ${blockCount}`)
check('every body line of every patch is rendered as its own code row', errors.length === 0, errors.slice(0, 10).join(' | '))
console.log(`hunks with a wrong declared count: ${wrongCounts} (informational - no line is lost)`)

console.log(failures ? `\n${failures} check(s) failed` : '\nall diff fence audit checks passed')
if (failures) process.exitCode = 1
