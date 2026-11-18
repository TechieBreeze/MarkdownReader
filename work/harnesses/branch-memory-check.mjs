/**
 * 默认打开分支记忆 (branch preference) — regression check.
 *
 * The standalone reader remembered the branch the user picked manually per
 * repo (`mdreader.defaultBranch.v1`) and opened that repo's other files on it.
 * The DSH plugin dropped it: every new file opened on the local checkout again.
 *
 * Contract (user, 2026-11-18): 手动切过的分支 > 本地当前分支 > main/master.
 *  - the memory is written ONLY by a MANUAL switch (the dropdown), never by a
 *    jump link that happens to carry a branch;
 *  - a remembered branch that no longer exists falls back to the local branch;
 *  - the key is the standalone one, so an existing memory carries over.
 *
 * The storage/resolution part runs against the real source (extracted block),
 * the wiring part against the shipped sources and the built bundle.
 *
 * Usage: node work/harnesses/branch-memory-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const gitSource = fs.readFileSync(path.join(SRC, '15-git.js'), 'utf8')
const modalSource = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
const appSource = fs.readFileSync(path.join(SRC, '50-app.js'), 'utf8')
const codeSource = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
const bundle = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')

let failures = 0
let checks = 0
const check = (name, condition, detail) => {
  checks += 1
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 300)}`}`)
  }
}

/* ------------------------------------------------ the real functions, run */

const start = gitSource.indexOf('const DEFAULT_BRANCH_KEY')
const fnStart = gitSource.indexOf('function pickOpenBranch')
let end = -1
if (fnStart >= 0) {
  // Walk to the matching closing brace of pickOpenBranch().
  let depth = 0
  let seenBrace = false
  for (let i = gitSource.indexOf('{', fnStart); i < gitSource.length; i += 1) {
    const ch = gitSource[i]
    if (ch === '{') {
      depth += 1
      seenBrace = true
    } else if (ch === '}') {
      depth -= 1
      if (seenBrace && depth === 0) {
        end = i + 1
        break
      }
    }
  }
}
if (start < 0 || end <= start) {
  console.log('cannot locate the branch-memory block in 15-git.js')
  process.exit(1)
}
const block = gitSource.slice(start, end)
const factory = new Function(
  'localStorage',
  `${block}
  return { DEFAULT_BRANCH_KEY, getDefaultBranch, setDefaultBranch, pickOpenBranch }
`,
)

function makeStorage(initial) {
  const store = new Map(Object.entries(initial || {}))
  return {
    store,
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => store.set(String(key), String(value)),
  }
}

console.log('\n[1] 记忆的读写')
{
  const storage = makeStorage()
  const api = factory(storage)
  check('沿用独立版的 localStorage key', api.DEFAULT_BRANCH_KEY === 'mdreader.defaultBranch.v1', api.DEFAULT_BRANCH_KEY)
  check('没有记忆时返回 null', api.getDefaultBranch('repo-a') === null)
  api.setDefaultBranch('repo-a', 'feature/x')
  check('写入后能读回', api.getDefaultBranch('repo-a') === 'feature/x', api.getDefaultBranch('repo-a'))
  check('按仓库隔离', api.getDefaultBranch('repo-b') === null, api.getDefaultBranch('repo-b'))
  check(
    '存成 {repo: branch} 的 JSON',
    JSON.parse(storage.store.get('mdreader.defaultBranch.v1'))['repo-a'] === 'feature/x',
    storage.store.get('mdreader.defaultBranch.v1'),
  )
  api.setDefaultBranch('', 'x')
  api.setDefaultBranch('repo-a', '')
  check('空 repo / 空分支不写入', Object.keys(JSON.parse(storage.store.get('mdreader.defaultBranch.v1'))).length === 1)
  // A corrupt value must not throw and must not invent a branch.
  const broken = makeStorage({ 'mdreader.defaultBranch.v1': '{not json' })
  const brokenApi = factory(broken)
  check('坏数据不抛错、不返回分支', brokenApi.getDefaultBranch('repo-a') === null)
  // Migrated from the standalone: the map already has an entry.
  const migrated = factory(makeStorage({ 'mdreader.defaultBranch.v1': JSON.stringify({ 'r': 'release/1.0' }) }))
  check('独立版已有的记忆直接生效', migrated.getDefaultBranch('r') === 'release/1.0', migrated.getDefaultBranch('r'))
}

console.log('\n[2] 打开文件时的分支优先级：记忆 > 本地 > main/master')
{
  const api = factory(makeStorage({ 'mdreader.defaultBranch.v1': JSON.stringify({ 'repo-a': 'feature/x' }) }))
  const meta = (over) => ({ repo: 'repo-a', branches: ['dev', 'main', 'master', 'feature/x'], currentBranch: 'dev', branch: 'dev', ...over })
  check('记忆分支存在 → 用记忆', api.pickOpenBranch(meta()) === 'feature/x', api.pickOpenBranch(meta()))
  const apiNoMem = factory(makeStorage({ 'mdreader.defaultBranch.v1': JSON.stringify({ 'repo-other': 'feature/x' }) }))
  check('别的仓库的记忆不影响本仓库', apiNoMem.pickOpenBranch(meta()) === 'dev', apiNoMem.pickOpenBranch(meta()))
  const apiStale = factory(makeStorage({ 'mdreader.defaultBranch.v1': JSON.stringify({ 'repo-a': 'feature/deleted' }) }))
  check('记忆分支已不存在 → 回退本地当前分支', apiStale.pickOpenBranch(meta()) === 'dev', apiStale.pickOpenBranch(meta()))
  check(
    '无本地当前分支（detached）→ 回退 main',
    apiStale.pickOpenBranch(meta({ currentBranch: '', branch: '', branches: ['main', 'master', 'dev'] })) === 'main',
  )
  check(
    '只有 master 时 → master',
    apiStale.pickOpenBranch(meta({ currentBranch: '', branch: '', branches: ['master', 'dev'] })) === 'master',
  )
  check(
    '记忆分支存在时优先于 detached 回退',
    api.pickOpenBranch(meta({ currentBranch: '', branch: '' })) === 'feature/x',
  )
  check('分支列表为空时不崩', typeof api.pickOpenBranch({ repo: 'repo-a', branches: [] }) === 'string')
}

console.log('\n[2b] 跨模块继承：同一项目下每个模块是独立 git 仓库')
{
  // 微服务 workspace: gits/customer, gits/order, gits/promotion are separate
  // repositories; the user thinks of them as one project, so a switch in one
  // must apply to the others (the branch list decides whether it is valid).
  const storage = makeStorage()
  const api = factory(storage)
  api.setDefaultBranch('20260917-微服务/gits/customer', 'test2.0_merge20240312')
  check('本仓库直接命中', api.getDefaultBranch('20260917-微服务/gits/customer') === 'test2.0_merge20240312')
  check(
    '兄弟模块继承',
    api.getDefaultBranch('20260917-微服务/gits/order') === 'test2.0_merge20240312',
    api.getDefaultBranch('20260917-微服务/gits/order'),
  )
  check('不相干的仓库不受影响', api.getDefaultBranch('20261020-jjy/gits/jjy-o2o') === null)
  check(
    '组键同时写入（换页面后仍能继承）',
    JSON.parse(storage.store.get('mdreader.defaultBranch.v1'))['@20260917-微服务/gits'] === 'test2.0_merge20240312',
    storage.store.get('mdreader.defaultBranch.v1'),
  )
  const meta = (repo) => ({ repo, branches: ['ck-dev-1020', 'test2.0_merge20240312'], currentBranch: 'ck-dev-1020' })
  check('兄弟模块打开时用继承来的分支', api.pickOpenBranch(meta('20260917-微服务/gits/order')) === 'test2.0_merge20240312')
  check(
    '继承来的分支不存在时回退本地',
    api.pickOpenBranch({ repo: '20260917-微服务/gits/order', branches: ['ck-dev-1020'], currentBranch: 'ck-dev-1020' }) ===
      'ck-dev-1020',
  )
}

console.log('\n[4] 固化链接（pin 到 commit）不能当成分支')
const mdSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
const linksSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'gitlinks.js'), 'utf8')
check('Host 区分 ref 类型', /async function refKind/.test(linksSource) && /refKind: kind/.test(linksSource))
check('pinned commit 不写 data-branch', /refKind === 'branch'\) anchor\.dataset\.branch = hit\.ref/.test(mdSource))
check('pinned commit 记到 data-refCommit', /anchor\.dataset\.refCommit = hit\.ref/.test(mdSource))
check('sha 兜底判为 commit', /\^\[0-9a-f\]\{7,40\}/.test(mdSource))
check(
  'applyGitTarget 不把非分支当分支',
  /looksLikeCommit = !!branch && !\(view\.branches \|\| \[\]\)\.includes\(branch\)/.test(gitSource),
)
check(
  '弹窗按锚定提交打开（并跳过分支记忆）',
  /if \(requestBranch \|\| requestCommit \|\| requestRefCommit\) return/.test(modalSource) &&
    /applyTarget\(null, requestRefCommit\)/.test(modalSource),
)
check('链接把 refCommit 带进请求', /refCommit\b/.test(appSource) && /refCommit: options\.refCommit \|\| ''/.test(appSource))
check('标签页也会应用锚定提交', /tab\.commit \|\| tab\.refCommit/.test(codeSource))
check('构建产物包含钉住提交的支持', bundle.includes('refCommit'))
/* ------------------------------------------------------------- wiring */
console.log('\n[3] 接线：打开即用、手动切换才记忆')
check('打开文件时按优先级选分支', /view\.branch = pickOpenBranch\(meta\)/.test(gitSource))
check(
  '选中的不是本地分支时要加载该分支内容',
  /view\.branch !== view\.currentBranch[\s\S]{0,400}selectGitBranch\(key, path, view\.branch, refresh\)/.test(gitSource),
)
check('手动切换分支会写入记忆', /selectGitBranch\(key, path, branch, bump, true\)/.test(gitSource))
check(
  '跳转链接带的分支不覆盖记忆',
  /async function applyGitTarget[\s\S]{0,1400}selectGitBranch\(key, path, effectiveBranch, refresh\)/.test(gitSource) &&
    !/async function applyGitTarget[\s\S]{0,1400}selectGitBranch\([^)]*true\)/.test(gitSource),
)
check('弹窗与标签页共用同一套逻辑（同一个 useGitView）', /function useGitView/.test(gitSource))
check(
  '弹窗每次打开都重新决定分支（缓存视图不能沿用旧分支）',
  /React\.useEffect\(\(\) => \{[\s\S]{0,200}applyDefaultBranch\('modal:' \+ displayPath/.test(modalSource),
)
check(
  '请求自带分支/提交时以请求为准',
  /if \(requestBranch \|\| requestCommit \|\| requestRefCommit\) return[\s\S]{0,200}applyDefaultBranch/.test(modalSource),
)
check(
  '每次普通打开都丢弃该路径的缓存视图（带分支的显式打开除外）',
  /if \(!options\.branch && !options\.commit[\s\S]{0,80}resetGitView\(value\)/.test(appSource),
)
check('构建产物包含记忆功能', bundle.includes('mdreader.defaultBranch.v1') && bundle.includes('pickOpenBranch'))

console.log(failures ? `\n${failures} check(s) failed` : `\nall ${checks} branch memory checks passed`)
if (failures) process.exitCode = 1
