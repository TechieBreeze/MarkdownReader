/**
 * Git diff view: hunk parsing + row assembly (regression).
 *
 * The Host parses `git show --patch` into hunks; the client turns
 * (commit-version file + hunks) into the row sequence it renders.
 *
 * The bug this guards: the patch text ends with a newline, so splitting it
 * yields a trailing empty line. Reading that as a context line invented a
 * phantom row that consumed a REAL line of the commit-version file, so the
 * line right after a hunk rendered empty (e.g. SyncEzrMapper.xml line 634
 * showed nothing instead of `#{item}`).
 *
 * Checks:
 *  1. parseDiff: hunk row counts match the header, trailing newline adds no row
 *  2. real commits: every file line appears exactly once, in order, with its
 *     real content; the row right after a hunk is not empty
 *
 * Usage:
 *   HOST_BASE=http://127.0.0.1:57377/markdown-reader node work/harnesses/git-diff-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiff } from '../../plugin/lib/api.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const HOST_BASE = process.env.HOST_BASE || 'http://127.0.0.1:8799/markdown-reader'

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

/* ------------------------------------------------- the client's own builder */

// buildDiffRows() is a pure function in 15-git.js; lift it out of the source so
// the harness exercises the shipped implementation, not a copy of it.
function loadBuildDiffRows() {
  const source = fs.readFileSync(path.join(SRC, '15-git.js'), 'utf8')
  const start = source.indexOf('function buildDiffRows(')
  if (start < 0) throw new Error('buildDiffRows not found in 15-git.js')
  const end = source.indexOf('\nfunction ', start + 10)
  const body = source.slice(start, end < 0 ? source.length : end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return buildDiffRows`)()
}
const buildDiffRows = loadBuildDiffRows()

/* --------------------------------------------------------- 1) parser unit */

console.log('\n[1] parseDiff: the header counts are authoritative')
const synthetic = [
  '@@ -10,3 +10,4 @@',
  ' context one',
  '-removed line',
  '+added line',
  '+added line two',
  ' context two',
  '',
].join('\n')
const hunks = parseDiff(synthetic)
const hunk = hunks[0]
check('one hunk parsed', hunks.length === 1, hunks.length)
check('hunk has 5 rows (no phantom row from the trailing newline)', hunk.lines.length === 5, hunk.lines.length)
check('old side counted 3', hunk.lines.filter((line) => line.type !== '+').length === 3)
check('new side counted 4', hunk.lines.filter((line) => line.type !== '-').length === 4)
check('deleted row keeps the old line number', hunk.lines[1].type === '-' && hunk.lines[1].old_no === 11, JSON.stringify(hunk.lines[1]))
check('added row carries the new line number', hunk.lines[2].type === '+' && hunk.lines[2].new_no === 11, JSON.stringify(hunk.lines[2]))
check('no phantom context row at the end', hunk.lines[hunk.lines.length - 1].type === ' ' && hunk.lines[hunk.lines.length - 1].new_no === 13, JSON.stringify(hunk.lines[hunk.lines.length - 1]))
check('parser does not leak internal counters', !('_oldLeft' in hunk) && !('_newLeft' in hunk))

// The body is 3 lines (" a", an empty content line, " b") but the header says
// 2/2 - a wrong count. The body must survive completely, and the empty content
// line must still be a context row.
const emptyContext = parseDiff(['@@ -1,2 +1,2 @@', ' a', '', ' b', ''].join('\n'))
check('an empty content line still counts as context', emptyContext[0].lines.length === 3, emptyContext[0].lines.length)
check('the empty content line is a context row', emptyContext[0].lines[1].type === ' ' && emptyContext[0].lines[1].text === '', JSON.stringify(emptyContext[0].lines[1]))
check('the row after it is kept too', emptyContext[0].lines[2].type === ' ' && emptyContext[0].lines[2].text === 'b', JSON.stringify(emptyContext[0].lines[2]))

console.log('\n[1b] parseDiff: a hunk header with the WRONG counts keeps the whole body')
// Hand-written diffs in design docs declare the wrong counts (the real case:
// docs/设计/20261105/preSync游标翻页改造详细设计说明书.md declares
// `@@ -11,21 +11,21 @@` over a 22-line body). The body must not be cut there.
const wrongCounts = [
  '@@ -11,21 +11,21 @@',
  ' context one',
  '-old line',
  '+new line',
  ' context two',
  ' context three',
  '',
].join('\n')
const wrongHunk = parseDiff(wrongCounts)[0]
check('the whole body is kept (3 context + 1 del + 1 add = 5 rows)', wrongHunk.lines.length === 5, wrongHunk.lines.length)
check('the last context line is still a context row', wrongHunk.lines[4].type === ' ' && wrongHunk.lines[4].text === 'context three', JSON.stringify(wrongHunk.lines[4]))
check('no phantom row from the trailing newline', wrongHunk.lines.filter((line) => line.text === '').length === 0)

const twoFiles = [
  'diff --git a/one.xml b/one.xml',
  '--- a/one.xml',
  '+++ b/one.xml',
  '@@ -1,2 +1,2 @@',
  ' ctx',
  '-old',
  '+new',
  'diff --git a/two.xml b/two.xml',
  '--- a/two.xml',
  '+++ b/two.xml',
  '@@ -1,1 +1,1 @@',
  ' ctx',
  '',
].join('\n')
const splitHunks = parseDiff(twoFiles)
check('two files -> two hunks', splitHunks.length === 2, splitHunks.length)
check('the first hunk stops at the next file', splitHunks[0].lines.length === 3, splitHunks[0].lines.length)
check('the second hunk has its own row', splitHunks[1].lines.length === 1, splitHunks[1].lines.length)

/* ------------------------------------------------------- 2) real commits */

const REAL = [
  {
    path: '20260917-微服务/gits/report/src/main/resources/mapper/SyncEzrMapper.xml',
    commit: '538a44a',
    note: 'reported: line 634 must show #{item}',
    expectLine: { no: 634, text: '            #{item}' },
  },
  {
    path: '20260917-微服务/gits/report/src/main/resources/mapper/SyncEzrMapper.xml',
    commit: '51c9fc1',
    note: 'earlier commit on the same file',
  },
  {
    path: '20260917-微服务/gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java',
    commit: '3eb48a3',
    note: 'java file',
  },
]

console.log('\n[2] real commits: every file line appears once, in order, with its content')
for (const item of REAL) {
  const diffResponse = await fetch(`${HOST_BASE}/api/git/diff?path=${encodeURIComponent(item.path)}&commit=${item.commit}`)
  const fileResponse = await fetch(`${HOST_BASE}/api/git/file?path=${encodeURIComponent(item.path)}&commit=${item.commit}`)
  const diff = await diffResponse.json()
  const file = await fileResponse.json()
  if (!diff.hunks || !diff.hunks.length || !file.content) {
    // A commit that does not touch the file legitimately has no hunks; the file
    // content must still be readable.
    check(`${item.commit}: commit-version file readable`, !!file.content, `${diffResponse.status}/${fileResponse.status}`)
    check(`${item.commit}: commit does not touch this file (no hunks)`, Array.isArray(diff.hunks) && diff.hunks.length === 0, JSON.stringify(diff.hunks && diff.hunks.length))
    continue
  }
  const fileLines = String(file.content).split('\n')
  const rows = buildDiffRows(fileLines, diff.hunks)

  // Hunk integrity: the parsed rows must match the counts the header declares.
  const hunkOk = diff.hunks.every((h) => {
    const old = h.lines.filter((line) => line.type !== '+').length
    const neu = h.lines.filter((line) => line.type !== '-').length
    return old === h.old_count && neu === h.new_count
  })
  check(`${item.commit} (${item.note}): hunk row counts match the header`, hunkOk, JSON.stringify(diff.hunks.map((h) => h.lines.length)))

  // Every file line must be present exactly once, in ascending order.
  const fileRows = rows.filter((row) => row.kind !== 'del')
  const numbers = fileRows.map((row) => row.no)
  const ascending = numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1)
  check(`${item.commit}: commit-version lines appear once, in order`, ascending && numbers[0] === 1 && numbers[numbers.length - 1] === fileLines.length, `${numbers[0]}..${numbers[numbers.length - 1]} vs 1..${fileLines.length}`)

  // No row may show empty text while the file line has content.
  const emptyRows = fileRows.filter((row, index) => row.text === '' && fileLines[row.no - 1] !== '')
  check(`${item.commit}: no row lost its content`, emptyRows.length === 0, JSON.stringify(emptyRows.slice(0, 3)))

  // The row right after the last hunk line keeps the file's content.
  if (item.expectLine) {
    const row = rows.find((candidate) => candidate.no === item.expectLine.no && candidate.kind !== 'del')
    check(`${item.commit}: line ${item.expectLine.no} shows "${item.expectLine.text.trim()}"`, !!row && row.text === item.expectLine.text, row ? JSON.stringify(row.text) : 'row missing')
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall git diff checks passed')
if (failures) process.exitCode = 1
