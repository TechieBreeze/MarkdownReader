/**
 * Oracle parity harness for POST /api/def (plugin :8798) vs /api/java/def
 * (standalone :8790). Compares file + line for real click samples generated
 * from identifier tokens of the sample files.
 *
 * Usage:
 *   node work/tmp-defs/compare-defs.mjs               # default file set
 *   PER_FILE=40 node work/tmp-defs/compare-defs.mjs   # denser sampling
 */
import fs from 'node:fs'
import { tokenizeJava } from '../../plugin/lib/javasym.js'

const TASK_ROOT = 'C:/Users/1/Desktop/work/tasks/20260917-微服务'
const VTOP = '20260917-微服务'
const ORACLE = 'http://127.0.0.1:8790'
const HOST = 'http://127.0.0.1:8798'
const PER_FILE = Number(process.env.PER_FILE || 30)

const FILES = [
  // user service — the file from the user report + bigger peers
  'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/UserServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/LoginServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/StoreServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/DictionaryServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/impl/WecomServiceImpl.java',
  'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java',
  'gits/user/src/main/java/com/pvh/user/model/enums/BrandEnum.java',
  'gits/user/src/main/java/com/pvh/user/mapper/UserCookieMapper.java',
  'gits/user/src/main/java/com/pvh/user/service/UserCookieService.java',
  'gits/user/src/main/java/com/pvh/user/model/po/UserCookiePO.java',
  'gits/user/src/main/java/com/pvh/user/model/po/UserPO.java',
  'gits/user/src/main/java/com/pvh/user/model/po/AssociateCustomerPO.java',
  'gits/user/src/main/java/com/pvh/user/controller/UserCookieController.java',
  // other business repos (different modules / styles)
  'gits/order/src/main/java/com/pvh/order/service/impl/DealWithTierTransactionTimeServiceImpl.java',
  'gits/order/src/main/java/com/pvh/order/model/enums/BrandEnum.java',
  'gits/order/src/main/java/com/pvh/order/model/po/BasePO.java',
  'gits/product/src/main/java/com/pvh/product/service/impl/ProductSkuAttributeServiceImpl.java',
  'gits/customer/src/main/java/com/pvh/customer/service/impl/AccountConfigServiceImpl.java',
  'gits/customer/src/main/java/com/pvh/customer/model/po/AccountConfigPO.java',
  // core multi-module repos (Lombok / enum / constants / utils)
  'gits/core/utils-web/src/main/java/com/pvh/utils/web/BasePO.java',
  'gits/core/utils-web/src/main/java/com/pvh/utils/web/RequestStatusEnum.java',
  'gits/core/utils-web/src/main/java/com/pvh/utils/web/AuthTypeEnum.java',
  'gits/core/utils-web/src/main/java/com/pvh/utils/web/JsonResult.java',
  'gits/core/data-excel/src/main/java/com/pvh/data/constants/DataConst.java',
  'gits/core/data-excel/src/main/java/com/pvh/data/util/type/DataType.java',
  'gits/core/data-excel/src/main/java/com/pvh/data/excel/ExcelFileType.java',
  'gits/core/data-excel/src/main/java/com/pvh/data/impl/DefaultDataExportConfig.java',
  // web files (oracle /api/web/def)
  'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js',
  'gits/employee/employee-detail.vue',
]

function classify(tokens, index) {
  const token = tokens[index]
  const next = tokens[index + 1]
  const prev = tokens[index - 1]
  if (next && next.value === '(' && !(prev && prev.value === 'new')) return 'method'
  if (/^[A-Z][A-Z0-9_]+$/.test(token.value)) return 'constant'
  if (/^[A-Z]/.test(token.value)) return 'type'
  return 'variable'
}

function pickSamples(text) {
  const tokens = tokenizeJava(text)
  const candidates = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind !== 'ident') continue
    if (token.value.length < 2) continue
    const prev = tokens[i - 1]
    if (prev && (prev.value === '@' || prev.value === '::' )) continue
    if (/^(package|import)$/.test(prev ? prev.value : '')) continue
    candidates.push({
      line: token.line,
      col: token.col,
      name: token.value,
      kind: classify(tokens, i),
    })
  }
  if (!candidates.length) return []
  const step = Math.max(1, Math.floor(candidates.length / PER_FILE))
  return candidates.filter((_, index) => index % step === 0).slice(0, PER_FILE)
}

async function postJson(url, body) {
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  return { status: res.status, payload: payload || {}, ms: Date.now() - started }
}

function resultOf(payload) {
  if (!payload || payload.error) return { error: (payload && payload.error) || 'error' }
  if (payload.file && payload.line) return { file: payload.file, line: payload.line }
  return { error: 'no result' }
}

function sameFile(a, b) {
  if (!a || !b) return false
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

async function main() {
  const stats = {
    total: 0,
    oracleOk: 0,
    pluginOk: 0,
    match: 0,
    oracleOkPluginFail: [],
    mismatch: [],
    pluginExtra: [],
    byKind: {},
    oracleMs: [],
    pluginMs: [],
  }
  for (const rel of FILES) {
    const abs = `${TASK_ROOT}/${rel}`
    if (!fs.existsSync(abs)) {
      console.log('MISSING FILE', rel)
      continue
    }
    const text = fs.readFileSync(abs, 'utf8')
    const samples = pickSamples(text)
    const path = `${VTOP}/${rel}`
    const isWeb = /\.(?:js|jsx|mjs|cjs|ts|tsx|vue)$/i.test(rel)
    const oracleEndpoint = isWeb ? '/api/web/def' : '/api/java/def'
    let fileMatch = 0
    let fileTotal = 0
    for (const sample of samples) {
      const body = { path, line: sample.line, col: sample.col, name: sample.name, kind: sample.kind, text }
      const oracle = await postJson(ORACLE + oracleEndpoint, body)
      const plugin = await postJson(HOST + '/api/def', body)
      const o = resultOf(oracle.payload)
      const p = resultOf(plugin.payload)
      stats.total += 1
      stats.byKind[sample.kind] = stats.byKind[sample.kind] || { total: 0, oracleOk: 0, match: 0 }
      stats.byKind[sample.kind].total += 1
      stats.oracleMs.push(oracle.ms)
      stats.pluginMs.push(plugin.ms)
      if (!o.error) {
        stats.oracleOk += 1
        stats.byKind[sample.kind].oracleOk += 1
        fileTotal += 1
      }
      if (!p.error) stats.pluginOk += 1
      if (!o.error && !p.error && sameFile(o.file, p.file) && o.line === p.line) {
        stats.match += 1
        stats.byKind[sample.kind].match += 1
        fileMatch += 1
      } else if (!o.error && p.error) {
        stats.oracleOkPluginFail.push({ rel, sample, oracle: o, plugin: p })
      } else if (!o.error && !p.error) {
        stats.mismatch.push({ rel, sample, oracle: o, plugin: p })
      } else if (o.error && !p.error) {
        stats.pluginExtra.push({ rel, sample, plugin: p })
      }
    }
    console.log(`${rel}: samples=${samples.length} oracleOk=${fileTotal} match=${fileMatch}`)
  }

  const percentile = (list, p) => {
    if (!list.length) return 0
    const sorted = [...list].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  }
  const bothOk = stats.total - stats.oracleOkPluginFail.length - (stats.total - stats.oracleOk - stats.pluginExtra.length)
  console.log('\n================ SUMMARY ================')
  console.log(`samples=${stats.total} oracleOk=${stats.oracleOk} pluginOk=${stats.pluginOk}`)
  console.log(`match(file+line)=${stats.match} / oracleOk=${stats.oracleOk} => ${((stats.match / Math.max(1, stats.oracleOk)) * 100).toFixed(1)}%`)
  console.log(`oracleOk & pluginError=${stats.oracleOkPluginFail.length} (MUST be 0)`)
  console.log(`bothOk but different line=${stats.mismatch.length}`)
  console.log(`pluginExtra (oracle error, plugin resolves)=${stats.pluginExtra.length}`)
  console.log('byKind:', JSON.stringify(stats.byKind))
  console.log(`latency oracle p50=${percentile(stats.oracleMs, 0.5)}ms p95=${percentile(stats.oracleMs, 0.95)}ms`)
  console.log(`latency plugin p50=${percentile(stats.pluginMs, 0.5)}ms p95=${percentile(stats.pluginMs, 0.95)}ms`)

  const show = (title, list, limit) => {
    if (!list.length) return
    console.log(`\n--- ${title} (${list.length}, first ${Math.min(limit, list.length)}) ---`)
    for (const item of list.slice(0, limit)) {
      console.log(JSON.stringify({ rel: item.rel, line: item.sample.line, col: item.sample.col, name: item.sample.name, kind: item.sample.kind, oracle: item.oracle, plugin: item.plugin }))
    }
  }
  show('oracle can jump but plugin failed', stats.oracleOkPluginFail, 40)
  show('file/line mismatch', stats.mismatch, 40)
  show('plugin extra jumps', stats.pluginExtra, 15)
}

main().catch((error) => {
  console.error('compare crashed:', error)
  process.exitCode = 2
})
