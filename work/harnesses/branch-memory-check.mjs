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

/* ------------------------------------------------------------- wiring */

console.log('\n[3] 接线：打开即用、手动切换才记忆')
const bundle = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')
check('打开文件时按优先级选分支', /view\.branch = pickOpenBranch\(meta\)/.test(gitSource))
check(
  '选中的不是本地分支时要加载该分支内容',
  /view\.branch !== view\.currentBranch[\s\S]{0,400}selectGitBranch\(key, path, view\.branch, refresh\)/.test(gitSource),
)
check('手动切换分支会写入记忆', /selectGitBranch\(key, path, branch, bump, true\)/.test(gitSource))
check(
  '跳转链接带的分支不覆盖记忆',
  /applyGitTarget[\s\S]{0,900}selectGitBranch\(key, path, branch, refresh\)/.test(gitSource) &&
    !/applyGitTarget[\s\S]{0,900}selectGitBranch\(key, path, branch, refresh, true\)/.test(gitSource),
)
check('弹窗与标签页共用同一套逻辑（同一个 useGitView）', /function useGitView/.test(gitSource))
check(
  '弹窗每次打开都重新决定分支（缓存视图不能沿用旧分支）',
  /React\.useEffect\(\(\) => \{[\s\S]{0,200}applyDefaultBranch\('modal:' \+ displayPath/.test(modalSource),
)
check('请求自带分支/提交时以请求为准', /if \(requestBranch \|\| requestCommit\) return[\s\S]{0,160}applyDefaultBranch/.test(modalSource))
check(
  '新开的标签页丢弃该路径的缓存视图',
  /resetGitView\(value\)/.test(appSource) && /!tabExists[\s\S]{0,80}resetGitView/.test(appSource),
)
check('构建产物包含记忆功能', bundle.includes('mdreader.defaultBranch.v1') && bundle.includes('pickOpenBranch'))

console.log(failures ? `\n${failures} check(s) failed` : `\nall ${checks} branch memory checks passed`)
if (failures) process.exitCode = 1
