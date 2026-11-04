/**
 * Round-7 jump parity: compare the ORIGINAL reader's definition resolver with the
 * plugin's /api/def on real clicks from real workspace files.
 *
 * Oracle (original, Python):  POST /api/java/def  (Java)  /  POST /api/web/def (JS/TS/Vue)
 * Plugin (rewritten, Node):   POST /api/def       (v2 contract, Java + web branch)
 *
 * A "sample" is a real identifier at a real line in a real file; the tool derives
 * the 1-based column from the file text, sends the full text to both services and
 * compares `file` + `line` (the plan's acceptance rule; derived fields like repo
 * are ignored because the two servers use different root orders).
 *
 * Usage:
 *   node work/work-def-parity.mjs                 # table + exit code
 *   node work/work-def-parity.mjs --json          # machine-readable JSON
 *   node work/work-def-parity.mjs --filter cookie # only matching samples
 *   node work/work-def-parity.mjs --min-match 95  # pass threshold (default 95)
 *   node work/work-def-parity.mjs --no-web        # Java-only run
 *   node work/work-def-parity.mjs --verbose       # raw payloads for non-matched rows
 *   node work/work-def-parity.mjs --oracle http://127.0.0.1:8790 --plugin http://127.0.0.1:8799
 *
 * Exit codes:
 *   0  pass: >= 40 valid Java samples, match rate >= --min-match, no "原版能跳/插件失败",
 *      no plugin contract / web-support gap
 *   2  parity failure (below threshold / only-original / plugin not ready / web unsupported)
 *   1  infrastructure or sample-definition error (service unreachable, < 40 valid samples…)
 */
import fs from 'node:fs'

const DEFAULTS = {
  oracle: 'http://127.0.0.1:8790',
  plugin: 'http://127.0.0.1:8799',
  rootName: '20260917-微服务',
  workspace: 'C:/Users/1/Desktop/work/tasks/20260917-微服务',
  minMatch: 95,
  timeoutMs: 30000,
  concurrency: 4,
  minJavaSamples: 40,
}

/**
 * Real-click samples. `file` is workspace-relative WITHOUT the virtual-top prefix;
 * `line` is 1-based in the file, `token` must occur on that line (the tool derives
 * the column, so the sample stays honest if the file is edited elsewhere).
 *
 * Categories cover the plan's acceptance list: variable/constant/type/method,
 * cross-file, inheritance (BasePO field via Lombok), Lombok getters/setters,
 * chained calls (BrandEnum.X.getContent()), plus a few oracle-negative samples
 * (external framework types) to make sure the plugin does not invent jumps.
 */
const JAVA_SAMPLES = [
  // --- user complaint file: UserCookieServiceImpl.java local variables ---
  { id: 'u03-param-token', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 21, token: 'token', kind: 'variable', note: '方法参数' },
  { id: 'u04-queryWrapper-decl', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 22, token: 'queryWrapper', kind: 'variable', note: '局部变量声明' },
  { id: 'u05-queryWrapper-use', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 23, token: 'queryWrapper', kind: 'variable', note: '局部变量使用' },
  { id: 'u06-cookiePO-decl', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 26, token: 'cookiePO', kind: 'variable', note: '用户报的 cookiePO' },
  { id: 'u07-cookiePO-use', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 27, token: 'cookiePO', kind: 'variable', note: '用户报的 cookiePO 引用' },
  { id: 'u08-dict', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 39, token: 'dict', kind: 'variable', note: '用户报的 dict' },
  { id: 'u09-dto-decl', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 40, token: 'dto', kind: 'variable', note: '用户报的 dto' },
  { id: 'u10-dto-use', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 42, token: 'dto', kind: 'variable', note: 'dto 使用' },
  // --- type / method / Lombok in the same file ---
  { id: 'u11-type-po', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 22, token: 'UserCookiePO', kind: 'type', note: '泛型参数类型' },
  { id: 'u12-type-dto', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 40, token: 'TokenExpirationTimeDTO', kind: 'type', note: '跨文件类型' },
  { id: 'u13-type-mapper', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 17, token: 'UserCookieMapper', kind: 'type', note: 'extends 泛型实参类型' },
  { id: 'u14-type-service', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 17, token: 'UserCookieService', kind: 'type', note: 'implements 接口类型' },
  { id: 'u15-type-self', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 17, token: 'UserCookieServiceImpl', kind: 'type', note: '本文件类声明' },
  { id: 'u16-method-local', category: 'method', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 31, token: 'resolveExpireMinutes', kind: 'method', note: '同文件方法调用' },
  { id: 'u17-method-decl', category: 'method', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 38, token: 'resolveExpireMinutes', kind: 'method', note: '同文件方法声明' },
  { id: 'u18-lombok-getter', category: 'lombok', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 32, token: 'getUserId', kind: 'method', note: '@Getter → UserCookiePO.userId' },
  { id: 'u19-lombok-getter2', category: 'lombok', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 42, token: 'getExpirationTime', kind: 'method', note: '@Getter → TokenExpirationTimeDTO.expirationTime' },
  { id: 'u20-lombok-static-ref', category: 'lombok', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 24, token: 'getExpirationTime', kind: 'method', note: '方法引用里的 Lombok getter' },
  { id: 'u21-inherit-getter', category: 'inheritance', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 25, token: 'getIsDeleted', kind: 'method', note: '@Getter 字段在父类 BasePO（继承链）' },
  // --- enums / constants / cross-file methods ---
  { id: 'e01-constant', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java', line: 35, token: 'BRAND_ENUM_TH', kind: 'constant', note: 'enum 常量' },
  { id: 'e02-constant2', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java', line: 37, token: 'BRAND_ENUM_CK', kind: 'constant', note: 'enum 常量' },
  { id: 'e03-chain-method', category: 'chained', file: 'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java', line: 35, token: 'getContent', kind: 'method', note: 'BrandEnum.X.getContent() 链尾' },
  { id: 'e04-method-decl', category: 'method', file: 'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java', line: 33, token: 'callService', kind: 'method', note: '方法声明' },
  { id: 'e05-method-call', category: 'method', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 369, token: 'callService', kind: 'method', note: '跨文件静态方法调用' },
  { id: 'e06-type-static-holder', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 369, token: 'EmployeeService', kind: 'type', note: '跨文件类型（静态调用接收者）' },
  { id: 'e07-constant-cross', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 369, token: 'QUERY_EMPLOYEE_DETAIL', kind: 'constant', note: '跨文件 enum 常量' },
  { id: 'e08-constant-chain', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 369, token: 'BRAND_ENUM_TH', kind: 'constant', note: '链式表达式里的 enum 常量' },
  { id: 'e09-chain-method2', category: 'chained', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 369, token: 'getContent', kind: 'method', note: '链尾方法（第二处）' },
  { id: 'e10-constant-holder', category: 'type', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 365, token: 'ConstantUser', kind: 'type', note: '常量类类型' },
  { id: 'e11-constant-bind', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java', line: 437, token: 'BIND_ADD_WAY_2', kind: 'constant', note: 'static final 常量' },
  { id: 'e12-constant-channel', category: 'constant', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 365, token: 'BUSINESS_CHANNEL_1', kind: 'constant', note: 'static final 常量（第二处）' },
  { id: 'e13-local-use', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateServiceImpl.java', line: 365, token: 'storePO', kind: 'variable', note: '方法内局部变量（远距离声明）' },
  { id: 'e14-param', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/EmployeeService.java', line: 34, token: 'response', kind: 'variable', note: '局部变量声明' },
  // --- setters / getters on PO (Lombok, cross-file) ---
  { id: 'p01-setter', category: 'lombok', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java', line: 433, token: 'setAssociateId', kind: 'method', note: '@Setter → AssociateCustomerPO.associateId' },
  { id: 'p02-var-decl', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java', line: 433, token: 'addPO', kind: 'variable', note: '局部变量（声明在上一行）' },
  { id: 'p03-param-list', category: 'variable', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java', line: 433, token: 'associatePOList', kind: 'variable', note: '方法参数（声明行 431）' },
  // --- oracle-negative samples: external framework / type-inference limits ---
  { id: 'n01-external-type', category: 'negative', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 22, token: 'LambdaQueryWrapper', kind: 'type', note: '外部依赖类型（原版也失败）' },
  { id: 'n02-external-method', category: 'negative', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 26, token: 'getOne', kind: 'method', note: '框架父类方法（原版也失败）' },
  { id: 'n03-inherited-field', category: 'negative', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 31, token: 'baseMapper', kind: 'variable', note: '框架父类字段（原版也失败）' },
  { id: 'n04-external-json', category: 'negative', file: 'gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java', line: 40, token: 'JSONObject', kind: 'type', note: 'fastjson 类型（原版也失败）' },
  { id: 'n05-chain-generic', category: 'negative', file: 'gits/user/src/main/java/com/pvh/user/service/impl/AssociateCustomerBindServiceImpl.java', line: 433, token: 'getId', kind: 'method', note: 'List.get(0).getId() 链（原版类型推断也失败）' },
]

/** Web samples (oracle POST /api/web/def). The 微服务 tree has no .ts source outside vendor/bower, so these cover .js + .vue. */
const WEB_SAMPLES = [
  { id: 'w01-function-decl', category: 'web-function', file: 'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js', line: 51, token: 'todayYmd', kind: 'function', note: '顶层函数声明' },
  { id: 'w02-function-use', category: 'web-function', file: 'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js', line: 59, token: 'todayYmd', kind: 'function', note: '同文件函数调用' },
  { id: 'w03-function-decl2', category: 'web-function', file: 'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js', line: 58, token: 'v1DefaultFilters', kind: 'function', note: '第二个顶层函数声明' },
  { id: 'w04-function-use2', category: 'web-function', file: 'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js', line: 63, token: 'v1DefaultFilters', kind: 'function', note: '同文件函数调用' },
  { id: 'w05-const', category: 'web-const', file: 'gits/ckdocs/demo/pvh-ops-prototype/assets/app.js', line: 29, token: 'API', kind: 'variable', note: 'const API = window.PVH_API 的使用处' },
  { id: 'w06-vue-method-use', category: 'web-vue', file: 'gits/employee/employee-detail.vue', line: 161, token: 'init', kind: 'method', note: 'Vue methods.init 调用' },
  { id: 'w07-vue-method-use2', category: 'web-vue', file: 'gits/employee/employee-detail.vue', line: 162, token: 'getDetail', kind: 'method', note: 'Vue methods.getDetail 调用' },
  { id: 'w08-vue-method-use3', category: 'web-vue', file: 'gits/employee/employee-detail.vue', line: 185, token: 'getDetail', kind: 'method', note: 'Vue methods.getDetail 另一处调用' },
  { id: 'w09-vue-method-decl', category: 'web-vue', file: 'gits/employee/employee-detail.vue', line: 188, token: 'getDetail', kind: 'method', note: 'Vue methods.getDetail 声明' },
  { id: 'w10-vue-method-decl2', category: 'web-vue', file: 'gits/employee/employee-detail.vue', line: 179, token: 'getMobile', kind: 'method', note: 'Vue methods.getMobile 声明' },
  // oracle-negative web samples (component tag whose file does not exist in this tree)
  { id: 'wn01-missing-component', category: 'web-negative', file: 'gits/employee/employee-detail.vue', line: 4, token: 'pvh-box', kind: 'type', note: '组件标签（原版也失败）' },
  { id: 'wn02-missing-component2', category: 'web-negative', file: 'gits/employee/employee-detail.vue', line: 26, token: 'pvh-svg-icon', kind: 'type', note: '组件标签（原版也失败）' },
]

/* --------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const options = { ...DEFAULTS, json: false, includeWeb: true, verbose: false, filter: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--json-file') options.jsonFile = argv[++i]
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--no-web') options.includeWeb = false
    else if (arg === '--oracle') options.oracle = argv[++i]
    else if (arg === '--plugin') options.plugin = argv[++i]
    else if (arg === '--workspace') options.workspace = argv[++i]
    else if (arg === '--root-name') options.rootName = argv[++i]
    else if (arg === '--filter') options.filter = argv[++i] || ''
    else if (arg === '--min-match') options.minMatch = Number(argv[++i])
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i])
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++i]) || 1)
    else if (arg === '--min-java') options.minJavaSamples = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const HELP = `Usage: node work/work-def-parity.mjs [options]
  --json             print one pure-JSON object on stdout (diagnostics go to stderr)
  --json-file <p>    write the JSON report to <p> as UTF-8 from Node itself
                     (use this instead of PowerShell ">" — that writes UTF-16 and
                     makes JSON.parse fail on the BOM)
  --oracle <url>     original reader base URL (default ${DEFAULTS.oracle})
  --plugin <url>     plugin Host base URL (default ${DEFAULTS.plugin})
  --workspace <dir>  workspace root holding the sample files
  --root-name <name> virtual-top directory name used by both servers
  --filter <text>    only run samples whose id/category/file/token contains text
  --min-match <pct>  pass threshold for the oracle-success match rate (default 95)
  --min-java <n>     minimum valid Java samples required for a pass (default 40)
  --concurrency <n>  parallel requests (default 4)
  --timeout <ms>     per-request timeout (default 30000)
  --no-web           skip the JS/TS/Vue samples
  --verbose          print raw payloads for every non-matched sample
`

/* ------------------------------------------------------------ transport */

async function postJson(base, endpoint, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(base + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return { status: response.status, payload }
  } finally {
    clearTimeout(timer)
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/* -------------------------------------------------------------- samples */

function normalizePath(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function loadSamples(options) {
  const all = [
    ...JAVA_SAMPLES.map((sample) => ({ ...sample, format: 'java' })),
    ...(options.includeWeb ? WEB_SAMPLES.map((sample) => ({ ...sample, format: 'web' })) : []),
  ]
  const filter = String(options.filter || '').trim().toLowerCase()
  const selected = filter
    ? all.filter((sample) =>
        [sample.id, sample.category, sample.file, sample.token, sample.note].some((field) => String(field || '').toLowerCase().includes(filter)),
      )
    : all
  return selected.map((sample) => {
    const abs = `${options.workspace}/${sample.file}`
    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (error) {
      return { ...sample, invalid: `cannot read ${abs}: ${error.message}` }
    }
    const lines = text.split('\n')
    const lineText = lines[sample.line - 1]
    if (lineText === undefined) return { ...sample, invalid: `line ${sample.line} out of range (${lines.length} lines)` }
    const tokenIndex = lineText.indexOf(sample.token)
    if (tokenIndex < 0) return { ...sample, invalid: `token "${sample.token}" not on line ${sample.line}: ${lineText.trim().slice(0, 120)}` }
    return { ...sample, abs, text, col: tokenIndex + 1, lineText }
  })
}

/* ---------------------------------------------------------- comparison */

function describeOracle(payload) {
  if (!payload) return null
  if (payload.file && payload.line) return { file: normalizePath(payload.file), line: Number(payload.line), kind: payload.kind || '', defName: payload.defName || '' }
  return { error: String(payload.error || 'unknown error') }
}

function pluginContractState(result) {
  const payload = result && result.payload
  // v2 success: file + numeric line is all that makes a jump usable. The Host's
  // transitional `candidates` extra (round-7 interim build) is ignored.
  if (payload && typeof payload.file === 'string' && payload.file && Number(payload.line) > 0) return ''
  if (!payload) return result && result.status === 200 ? 'bad-shape' : 'no-payload'
  const message = String(payload.error || '')
  if (/无效的符号名|invalid params|缺少 path|缺少 name/i.test(message)) return 'v2-not-implemented'
  if (/不支持|unsupported/i.test(message)) return 'unsupported'
  if (payload.ok !== false && !message) {
    // HTTP 200 with a body that has neither a target nor an error: a shape
    // problem, not a network problem (kept separate in the report).
    return 'bad-shape'
  }
  return ''
}

function compareSample(sample, oracle, plugin) {
  const oracleInfo = describeOracle(oracle.payload)
  const oracleOk = !!(oracleInfo && oracleInfo.file && oracleInfo.line)
  const contractState = pluginContractState(plugin)
  const pluginPayload = plugin.payload || null
  const pluginInfo =
    pluginPayload && !contractState && pluginPayload.ok !== false && pluginPayload.file && pluginPayload.line
      ? { file: normalizePath(pluginPayload.file), line: Number(pluginPayload.line), kind: pluginPayload.kind || '', defName: pluginPayload.defName || '' }
      : null
  const pluginError = pluginInfo
    ? ''
    : contractState === 'bad-shape'
      ? `bad-shape: ${JSON.stringify(pluginPayload).slice(0, 160)}`
      : String((pluginPayload && pluginPayload.error) || `HTTP ${plugin.status}`)

  let status
  if (contractState === 'v2-not-implemented') status = sample.format === 'web' ? 'plugin-not-ready-web' : 'plugin-not-ready'
  else if (contractState === 'unsupported') status = sample.format === 'web' ? 'web-unsupported' : 'plugin-unsupported'
  else if (contractState === 'bad-shape') status = 'plugin-bad-shape'
  else if (oracleOk && pluginInfo) status = oracleInfo.file === pluginInfo.file && oracleInfo.line === pluginInfo.line ? 'matched' : 'mismatch'
  else if (oracleOk && !pluginInfo) status = 'only-original'
  else if (!oracleOk && pluginInfo) status = 'only-plugin'
  else status = 'both-failed'

  return {
    id: sample.id,
    format: sample.format,
    category: sample.category,
    file: sample.file,
    line: sample.line,
    token: sample.token,
    kind: sample.kind,
    note: sample.note || '',
    status,
    oracle: oracleInfo,
    plugin: pluginInfo || { error: pluginError },
    oracleRaw: oracle,
    pluginRaw: plugin,
    contractState,
  }
}

function formatHit(info) {
  if (!info) return '—'
  if (info.error) return `ERR ${info.error}`
  return `${info.file.split('/').slice(-1)[0]}:${info.line}`
}

/* ---------------------------------------------------------------- main */

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  const samples = loadSamples(options)
  if (!samples.length) {
    console.error('no samples selected')
    process.exit(1)
  }

  const report = {
    oracle: options.oracle,
    plugin: options.plugin,
    generatedAt: new Date().toISOString(),
    total: samples.length,
    javaSamples: samples.filter((sample) => sample.format === 'java').length,
    webSamples: samples.filter((sample) => sample.format === 'web').length,
    invalid: [],
    counts: {
      matched: 0,
      mismatch: 0,
      onlyOriginal: 0,
      onlyPlugin: 0,
      bothFailed: 0,
      pluginNotReady: 0,
      pluginNotReadyWeb: 0,
      pluginBadShape: 0,
      webUnsupported: 0,
      pluginUnsupported: 0,
    },
    samples: [],
  }

  const valid = []
  for (const sample of samples) {
    if (sample.invalid) report.invalid.push({ id: sample.id, file: sample.file, line: sample.line, error: sample.invalid })
    else valid.push(sample)
  }
  if (!valid.length) {
    console.error('all samples invalid:')
    for (const item of report.invalid) console.error(`  ${item.id}: ${item.error}`)
    process.exit(1)
  }

  // Reachability probe: fail fast with a clear infra error instead of 40 timeouts.
  const probe = async (base, endpoint) => postJson(base, endpoint, { path: '', line: 1, col: 1, name: '', kind: '' }, 5000)
  try {
    const [metaResponse] = await Promise.all([fetch(options.oracle + '/api/meta'), fetch(options.plugin + '/api/ping')])
    if (!metaResponse.ok) throw new Error(`oracle /api/meta HTTP ${metaResponse.status}`)
  } catch (error) {
    console.error(`infra error: oracle or plugin not reachable (${error.message})`)
    console.error(`  oracle=${options.oracle}  plugin=${options.plugin}`)
    console.error('  start them with: cd work/oracle && python server.py --port 8790 --root ...  |  node work/host-test.mjs ...')
    process.exit(1)
  }

  const vtop = `${options.rootName}/`
  const results = await pool(valid, options.concurrency, async (sample) => {
    const path = vtop + sample.file
    const body = {
      path,
      line: sample.line,
      col: sample.col,
      text: sample.text,
      name: sample.token,
      kind: sample.kind,
    }
    const endpoint = sample.format === 'java' ? '/api/java/def' : '/api/web/def'
    let oracle
    let plugin
    try {
      oracle = await postJson(options.oracle, endpoint, body, options.timeoutMs)
    } catch (error) {
      oracle = { status: 0, payload: { error: `request failed: ${error.message}` } }
    }
    try {
      plugin = await postJson(options.plugin, '/api/def', body, options.timeoutMs)
    } catch (error) {
      plugin = { status: 0, payload: { error: `request failed: ${error.message}` } }
    }
    return compareSample(sample, oracle, plugin)
  })

  const byStatus = (status) => results.filter((item) => item.status === status)
  report.counts.matched = byStatus('matched').length
  report.counts.mismatch = byStatus('mismatch').length
  report.counts.onlyOriginal = byStatus('only-original').length
  report.counts.onlyPlugin = byStatus('only-plugin').length
  report.counts.bothFailed = byStatus('both-failed').length
  report.counts.pluginNotReady = byStatus('plugin-not-ready').length
  report.counts.pluginNotReadyWeb = byStatus('plugin-not-ready-web').length
  report.counts.pluginBadShape = byStatus('plugin-bad-shape').length
  report.counts.webUnsupported = byStatus('web-unsupported').length
  report.counts.pluginUnsupported = byStatus('plugin-unsupported').length
  report.samples = results.map((item) => ({
    id: item.id,
    format: item.format,
    category: item.category,
    file: item.file,
    line: item.line,
    token: item.token,
    kind: item.kind,
    note: item.note,
    status: item.status,
    oracle: item.oracle,
    plugin: item.plugin,
    contractState: item.contractState,
  }))

  const oracleSuccess = results.filter((item) => item.oracle && item.oracle.file && item.oracle.line)
  const pluginReady = oracleSuccess.filter((item) => !/^plugin-not-ready/.test(item.status) && !/unsupported/.test(item.status))
  const matched = byStatus('matched').length
  report.oracleSuccess = oracleSuccess.length
  report.pluginReady = pluginReady.length
  report.matchRate = pluginReady.length ? Math.round((matched / pluginReady.length) * 1000) / 10 : null
  report.validJava = valid.filter((sample) => sample.format === 'java').length
  report.ready = pluginReady.length === oracleSuccess.length && pluginReady.length > 0
  const failures = []
  if (report.counts.onlyOriginal > 0) failures.push(`${report.counts.onlyOriginal} sample(s): 原版能跳、插件未找到定义`)
  if (report.counts.pluginNotReady > 0 || report.counts.pluginNotReadyWeb > 0) failures.push(`插件 /api/def 未就绪（v2 契约缺失）：${report.counts.pluginNotReady + report.counts.pluginNotReadyWeb} sample(s)`)
  if (report.counts.pluginBadShape > 0) failures.push(`插件返回 200 但响应形状不合契约（bad-shape）：${report.counts.pluginBadShape} sample(s)`)
  if (report.counts.webUnsupported > 0) failures.push(`插件未支持 web 跳转：${report.counts.webUnsupported} sample(s)`)
  if (report.counts.pluginUnsupported > 0) failures.push(`插件声明不支持：${report.counts.pluginUnsupported} sample(s)`)
  if (report.matchRate !== null && report.matchRate < options.minMatch) failures.push(`一致率 ${report.matchRate}% < ${options.minMatch}%`)
  if (report.validJava < options.minJavaSamples) failures.push(`有效 Java 样本 ${report.validJava} < ${options.minJavaSamples}`)
  if (report.invalid.length) failures.push(`${report.invalid.length} 个样本定义失效（文件改动/行号漂移）`)
  report.failures = failures
  report.ok = failures.length === 0

  if (options.jsonFile) {
    // UTF-8 file written by Node itself: avoids Windows PowerShell's UTF-16 `>`
    // redirection corrupting the JSON (the reason a shell-piped parse needs a strip).
    fs.writeFileSync(options.jsonFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else if (!options.jsonFile) {
    console.log(`round-7 def parity: oracle=${options.oracle} plugin=${options.plugin}`)
    console.log(`samples: ${report.total} (java=${report.javaSamples}, web=${report.webSamples}) valid java=${report.validJava}`)
    if (report.invalid.length) {
      for (const item of report.invalid) console.log(`  INVALID ${item.id}: ${item.error}`)
    }
    console.log('')
    const label = {
      matched: '一致',
      mismatch: '不一致',
      'only-original': '仅原版',
      'only-plugin': '仅插件',
      'both-failed': '双方失败',
      'plugin-not-ready': '插件未就绪',
      'plugin-not-ready-web': '插件未就绪(web)',
      'plugin-bad-shape': '响应形状异常',
      'web-unsupported': '插件未支持web',
      'plugin-unsupported': '插件不支持',
    }
    for (const item of results) {
      const oracleHit = formatHit(item.oracle)
      const pluginHit = item.plugin && !item.plugin.error ? formatHit(item.plugin) : `ERR ${String(item.plugin && item.plugin.error).slice(0, 40)}`
      console.log(
        `  ${label[item.status].padEnd(10)} ${item.format === 'web' ? 'WEB' : 'JAVA'} ${item.id.padEnd(22)} ${item.file.split('/').slice(-1)[0]}:${item.line} ${item.token.padEnd(24)} oracle=${oracleHit.padEnd(28)} plugin=${pluginHit}`,
      )
      if (options.verbose && item.status !== 'matched') {
        console.log(`      oracle raw: ${JSON.stringify(item.oracleRaw)}`)
        console.log(`      plugin raw: ${JSON.stringify(item.pluginRaw)}`)
      }
    }
    console.log('')
    console.log(
      `summary: matched=${report.counts.matched} mismatch=${report.counts.mismatch} onlyOriginal=${report.counts.onlyOriginal} onlyPlugin=${report.counts.onlyPlugin} bothFailed=${report.counts.bothFailed}`,
    )
    console.log(
      `         pluginNotReady=${report.counts.pluginNotReady + report.counts.pluginNotReadyWeb} badShape=${report.counts.pluginBadShape} webUnsupported=${report.counts.webUnsupported} webSamples=${report.webSamples}`,
    )
    console.log(`         oracle success=${report.oracleSuccess} plugin-ready=${report.pluginReady} matchRate=${report.matchRate === null ? 'n/a' : report.matchRate + '%'} (threshold ${options.minMatch}%)`)
    if (failures.length) {
      console.log('')
      for (const failure of failures) console.log(`  FAIL ${failure}`)
      console.log('')
      console.log('RESULT: NOT PASS')
    } else {
      console.log('')
      console.log('RESULT: PASS')
    }
  }

  if (report.invalid.length) process.exit(1)
  process.exit(report.ok ? 0 : 2)
}

main().catch((error) => {
  console.error(`unexpected error: ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
