/**
 * Feature checks for /api/def that the token-sweep comparison does not cover:
 * Mapper interface -> XML statement, interface -> impl, branch/commit views,
 * requests without `text`, the legacy v1 request shape and auto-detect kind.
 * Oracle comparison is used where the original supports the same scenario.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const TASK_ROOT = 'C:/Users/1/Desktop/work/tasks/20260917-微服务'
const VTOP = '20260917-微服务'
const ORACLE = 'http://127.0.0.1:8790'
const HOST = 'http://127.0.0.1:8798'

let passed = 0
const failures = []
function ok(condition, message, extra) {
  if (condition) {
    passed += 1
    console.log(`  PASS ${message}`)
    return
  }
  failures.push(message)
  console.log(`  FAIL ${message}${extra ? ' :: ' + JSON.stringify(extra) : ''}`)
}

async function post(base, endpoint, body) {
  const response = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload: payload || {} }
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
}

function read(rel) {
  return fs.readFileSync(`${TASK_ROOT}/${rel}`, 'utf8')
}

function sample(rel, line, token, kind) {
  const lines = read(rel).split('\n')
  const lineText = lines[line - 1]
  const col = lineText.indexOf(token) + 1
  return { path: `${VTOP}/${rel}`, line, col, name: token, kind, text: read(rel) }
}

async function compareSample(name, body) {
  const oracle = await post(ORACLE, '/api/java/def', body)
  const plugin = await post(HOST, '/api/def', body)
  const o = oracle.payload
  const p = plugin.payload
  const oracleOk = !!(o.file && o.line)
  ok(oracleOk, `${name}: oracle resolves`, o)
  ok(!!p.file && !!p.line, `${name}: plugin resolves (HTTP ${plugin.status})`, p)
  if (oracleOk && p.file) {
    ok(o.file === p.file && Number(o.line) === Number(p.line), `${name}: file+line matches oracle`, { oracle: o, plugin: p })
  }
  return { oracle: o, plugin: p }
}

async function main() {
  console.log('== Mapper interface method declaration -> XML statement ==')
  {
    const body = sample('gits/user/src/main/java/com/pvh/user/mapper/UserCookieMapper.java', 12, 'renewExpirationTime', 'method')
    const { oracle, plugin } = await compareSample('mapper-method', body)
    ok(/\.xml$/.test(plugin.file || ''), 'mapper-method: plugin target is the Mapper.xml', plugin)
    ok(plugin.kind === 'xml', 'mapper-method: plugin kind is xml', plugin)
  }

  console.log('== Interface type -> impl ==')
  {
    const body = sample('gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', 17, 'UserCookieService', 'type')
    const { plugin } = await compareSample('iface-type', body)
    ok(plugin.impl && /UserCookieServiceImpl\.java$/.test(plugin.impl.file || ''), 'iface-type: impl points at the Impl class', plugin)
    ok(Number(plugin.impl && plugin.impl.line) === 17, 'iface-type: impl line is the class declaration', plugin)
  }

  console.log('== Branch view (branch=th-dev-1105) ==')
  {
    const repo = `${TASK_ROOT}/gits/user`
    const rel = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const repoRel = 'src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const branch = 'th-dev-1105'
    const branchText = git(repo, ['cat-file', 'blob', `${branch}:${repoRel}`])
    const lines = branchText.split('\n')
    const targetLine = lines.findIndex((line) => line.includes('cookiePO')) + 1
    const lineText = lines[targetLine - 1]
    const body = { path: `${VTOP}/${rel}`, line: targetLine, col: lineText.indexOf('cookiePO') + 1, name: 'cookiePO', kind: 'variable', text: branchText, branch }
    const { plugin } = await compareSample('branch-cookiePO', body)
    ok(/UserCookieServiceImpl\.java$/.test(plugin.file || ''), 'branch-cookiePO: resolves in the branch revision', plugin)
  }

  console.log('== Commit view (commit=3eb48a3) ==')
  {
    const repo = `${TASK_ROOT}/gits/user`
    const rel = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const repoRel = 'src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const commit = '3eb48a3f24392fcb77ba03674bb3b82293545352'
    const commitText = git(repo, ['cat-file', 'blob', `${commit}:${repoRel}`])
    const lines = commitText.split('\n')
    const targetLine = lines.findIndex((line) => line.includes('queryWrapper')) + 1
    const lineText = lines[targetLine - 1]
    const body = { path: `${VTOP}/${rel}`, line: targetLine, col: lineText.indexOf('queryWrapper') + 1, name: 'queryWrapper', kind: 'variable', text: commitText, commit }
    const { plugin } = await compareSample('commit-queryWrapper', body)
    ok(/UserCookieServiceImpl\.java$/.test(plugin.file || ''), 'commit-queryWrapper: resolves in the commit revision', plugin)
  }

  console.log('== Request without text (Host reads disk) ==')
  {
    const rel = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const body = { path: `${VTOP}/${rel}`, line: 32, col: 16, name: 'cookiePO', kind: 'variable' }
    const plugin = await post(HOST, '/api/def', body)
    ok(plugin.payload.ok === true && /UserCookieServiceImpl\.java$/.test(plugin.payload.file || ''), 'no-text: plugin reads the workspace file', plugin.payload)
    ok(Number(plugin.payload.line) === 26, 'no-text: cookiePO -> line 26', plugin.payload)
  }

  console.log('== Legacy v1 request shape ({ path, symbol, context }) ==')
  {
    const rel = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const plugin = await post(HOST, '/api/def', {
      path: `${VTOP}/${rel}`,
      symbol: 'cookiePO',
      context: 'return cookiePO.getUserId();',
    })
    ok(plugin.payload.ok === true && Number(plugin.payload.line) === 26, 'v1-shape: resolves cookiePO from context line', plugin.payload)
    ok(!Object.prototype.hasOwnProperty.call(plugin.payload, 'candidates'), 'v1-shape: no legacy candidates field in the response', plugin.payload)
  }

  console.log('== Auto kind (kind omitted) ==')
  {
    const rel = 'gits/user/src/main/java/com/pvh/user/model/po/UserCookiePO.java'
    const body = { path: `${VTOP}/${rel}`, line: 13, col: 14, name: 'UserCookiePO', text: read(rel) }
    const plugin = await post(HOST, '/api/def', body)
    ok(plugin.payload.ok === true && Number(plugin.payload.line) === 13 && plugin.payload.kind === 'type', 'auto-kind: self type resolves', plugin.payload)

    const rel2 = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const serviceRel = 'gits/user/src/main/java/com/pvh/user/service/UserCookieService.java'
    const body2 = { path: `${VTOP}/${rel2}`, line: 17, col: 13, name: 'UserCookieService', kind: '', text: read(rel2) }
    const plugin2 = await post(HOST, '/api/def', body2)
    ok(plugin2.payload.ok === true && /UserCookieService\.java$/.test(plugin2.payload.file || ''), 'auto-kind: interface type resolves', plugin2.payload)
    ok(!!plugin2.payload.impl && /UserCookieServiceImpl\.java$/.test(plugin2.payload.impl.file || ''), 'auto-kind: interface impl included', plugin2.payload)
  }

  console.log('== Response shape ==')
  {
    const rel = 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java'
    const plugin = await post(HOST, '/api/def', sample(rel, 32, 'cookiePO', 'variable'))
    const keys = Object.keys(plugin.payload).sort()
    ok(plugin.status === 200, 'shape: HTTP 200 for success', plugin.payload)
    ok(!Object.prototype.hasOwnProperty.call(plugin.payload, 'candidates'), 'shape: no candidates field', plugin.payload)
    ok(keys.join(',') === 'defName,file,impl,kind,line,ok', 'shape: exactly {ok,file,line,kind,defName,impl}', keys)
    const missing = await post(HOST, '/api/def', { path: `${VTOP}/${rel}`, line: 32, col: 16, name: 'definitelyNotAThing', kind: 'variable', text: read(rel) })
    ok(missing.status === 400 && missing.payload.ok === false && typeof missing.payload.error === 'string', 'shape: HTTP 400 {ok:false,error} for not-found', missing)
  }

  console.log('')
  console.log(`feature checks passed=${passed} failed=${failures.length}`)
  if (failures.length) {
    for (const failure of failures) console.log(' - ' + failure)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('feature checks crashed:', error)
  process.exitCode = 2
})
