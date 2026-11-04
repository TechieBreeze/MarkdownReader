/**
 * Lead acceptance probe for round 7 — runs against the LIVE plugin Host
 * (:57377) so the evidence is what the user's page will actually call.
 *
 * 1) The reported doc's bare-backtick paths: every citation the reader may
 *    linkify must resolve through /api/exists?from=<doc>.
 * 2) The reported Ctrl+click scenario: /api/def on the live Host must match the
 *    original reader (:8790) file+line for variables/constant/type/method.
 */
import fs from 'node:fs'

const LIVE = 'http://127.0.0.1:57377/markdown-reader'
const ORACLE = 'http://127.0.0.1:8790'
const DOC = '20260917-微服务/docs/codereview/20261104_ck-dev-1105_th-dev-1105_vs_基线_1105版本_codereview.md'
const DOC_ABS = `C:/Users/1/Desktop/work/tasks/${DOC}`

const looksLikePath = (text) => {
  if (!text || text.length > 260) return false
  if (/^[a-z]+:\/\//i.test(text)) return false
  if (/\s/.test(text)) return false
  return /\.[a-z0-9]{1,10}$/i.test(text)
}

// Git branch names in backticks (`ck_test2.0`) also satisfy the extension regex but
// are not files: the reader leaves them unlinked, which is correct.
const BRANCH_LIKE = new Set(['ck_test2.0', 'test2.0_merge20240312', 'ck-dev-1105', 'th-dev-1105'])
const md = fs.readFileSync(DOC_ABS, 'utf8')
const cited = [...new Set([...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((item) => looksLikePath(item) && !BRANCH_LIKE.has(item)))]
const params = new URLSearchParams({ from: DOC })
for (const item of cited) params.append('path', item)
const exists = await (await fetch(`${LIVE}/api/exists?${params}`)).json()
const hits = cited.filter((item) => exists.results[item]?.exists)
console.log(`[1] doc bare-path citations: ${hits.length}/${cited.length} resolved via live /api/exists`)
for (const item of cited) {
  const row = exists.results[item]
  console.log(`    ${row?.exists ? 'ok  ' : 'MISS'} ${item}${row?.exists ? ' -> ' + row.abs : ''}`)
}

const samples = [
  { line: 21, col: 22, name: 'token', kind: 'variable', note: 'method parameter' },
  { line: 22, col: 48, name: 'queryWrapper', kind: 'variable', note: 'local decl' },
  { line: 23, col: 50, name: 'token', kind: 'variable', note: 'param use' },
  { line: 26, col: 26, name: 'cookiePO', kind: 'variable', note: 'local decl' },
  { line: 32, col: 20, name: 'cookiePO', kind: 'variable', note: 'local use' },
  { line: 31, col: 48, name: 'renewExpirationTime', kind: 'method', note: 'mapper method (XML impl)' },
  { line: 39, col: 30, name: 'dict', kind: 'variable', note: 'local in method 2' },
  { line: 40, col: 14, name: 'dto', kind: 'variable', note: 'local decl' },
  { line: 42, col: 20, name: 'dto', kind: 'variable', note: 'local use' },
  { line: 17, col: 14, name: 'UserCookieServiceImpl', kind: 'type', note: 'type self' },
  { line: 17, col: 60, name: 'UserCookiePO', kind: 'type', note: 'generic arg' },
  { line: 7, col: 30, name: 'UserCookieMapper', kind: 'type', note: 'import type' },
  { line: 9, col: 30, name: 'UserCookieService', kind: 'type', note: 'import interface' },
]
const PATH = '20260917-微服务/gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
const text = fs.readFileSync(`C:/Users/1/Desktop/work/tasks/${PATH}`, 'utf8')

let same = 0
let bothFailed = 0
const rows = []
for (const sample of samples) {
  const body = { path: PATH, line: sample.line, col: sample.col, name: sample.name, kind: sample.kind, text }
  const [liveResponse, oracleResponse] = await Promise.all([
    fetch(`${LIVE}/api/def`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    fetch(`${ORACLE}/api/java/def`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  ])
  const live = liveResponse.ok ? `${liveResponse.file}:${liveResponse.line}` : `ERR ${liveResponse.error}`
  const oracle = oracleResponse.file ? `${oracleResponse.file}:${oracleResponse.line}` : `ERR ${oracleResponse.error}`
  const verdict = live === oracle ? 'SAME' : 'DIFF'
  if (verdict === 'SAME' && live.startsWith('ERR')) bothFailed += 1
  else if (verdict === 'SAME') same += 1
  rows.push({ verdict, sample: `${sample.name} (${sample.note})`, live, oracle })
}
console.log(`\n[2] live /api/def vs original /api/java/def on the reported file`)
for (const row of rows) console.log(`    ${row.verdict}  ${row.sample.padEnd(44)} live=${row.live}  oracle=${row.oracle}`)
console.log(`\n    identical successful targets: ${same}/${samples.length}  (both failed: ${bothFailed}, different: ${samples.length - same - bothFailed})`)
const ok = hits.length === cited.length && same + bothFailed === samples.length
console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL')
process.exitCode = ok ? 0 : 1
