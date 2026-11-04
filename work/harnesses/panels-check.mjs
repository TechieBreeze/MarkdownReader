/**
 * Temporary harness for the panels slice (27-sync.js + 28-gitgraph.js).
 *
 * Not part of the plugin and not committed (workspace tmp/ is gitignored).
 * Loads the concatenated client sources with a tiny fake React + fake fetch so
 * the two panels' data flow / render tree / interactions can be verified
 * without a browser.
 *
 * Usage: node tmp/panels-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const ORDER = [
  '00-core.js',
  '10-markdown.js',
  '12-mermaid.js',
  '15-git.js',
  '20-code.js',
  '22-defs.js',
  '24-modal.js',
  '25-search.js',
  '27-sync.js',
  '28-gitgraph.js',
  '30-tree.js',
  '40-tabs.js',
  '45-json.js',
  '50-app.js',
]
const HOST = 'http://127.0.0.1:8799/markdown-reader'

/* ----------------------------------------------------------- fake React */

function createReact() {
  let cells = []
  let hookIndex = 0
  let dirty = false
  let effectQueue = []

  const shallowEqual = (a, b) => {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
    return true
  }
  const ensure = (index, factory) => {
    if (!(index in cells)) cells[index] = factory()
    return cells[index]
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props == null ? {} : props, children }
    },
    useState(initial) {
      const index = hookIndex++
      const cell = ensure(index, () => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }))
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(value, cell.value)) {
          cell.value = value
          dirty = true
        }
      }
      return [cell.value, setValue]
    },
    useRef(initial) {
      const index = hookIndex++
      return ensure(index, () => ({ current: initial }))
    },
    useEffect(effect, deps) {
      const index = hookIndex++
      const cell = ensure(index, () => ({ kind: 'effect', deps: undefined, cleanup: null }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.deps = deps
        effectQueue.push({ cell, effect })
      }
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const cell = ensure(index, () => ({ kind: 'callback', deps: undefined, fn }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.deps = deps
        cell.fn = fn
      }
      return cell.fn
    },
    useMemo(fn, deps) {
      const index = hookIndex++
      const cell = ensure(index, () => ({ kind: 'memo', deps: undefined, value: undefined }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.value = fn()
        cell.deps = deps
      }
      return cell.value
    },
  }

  return {
    React,
    reset() {
      cells = []
      hookIndex = 0
      dirty = false
      effectQueue = []
    },
    beginRender() {
      hookIndex = 0
      dirty = false
      effectQueue = []
    },
    runEffects() {
      const queue = effectQueue
      effectQueue = []
      for (const { cell, effect } of queue) {
        if (typeof cell.cleanup === 'function') {
          try {
            cell.cleanup()
          } catch {
            /* ignore */
          }
          cell.cleanup = null
        }
        const cleanup = effect()
        cell.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
    },
    isDirty() {
      return dirty
    },
  }
}

const flushAsync = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Render whenever state changed during `ms`, for tests that hit the real Host. */
async function settleFor(Component, props, react, ms) {
  const start = Date.now()
  let tree = renderOnceWith(react, Component, props)
  while (Date.now() - start < ms) {
    await sleep(20)
    await flushAsync()
    if (react.isDirty()) tree = renderOnceWith(react, Component, props)
  }
  return tree
}

const renderOnceWith = (react, Component, props) => {
  react.beginRender()
  const tree = Component(props)
  react.runEffects()
  return tree
}

async function mount(Component, props, react) {
  react.reset()
  let tree = renderOnceWith(react, Component, props)
  await flushAsync()
  for (let i = 0; i < 60; i += 1) {
    if (!react.isDirty()) return tree
    tree = renderOnceWith(react, Component, props)
    await flushAsync()
  }
  throw new Error('component did not settle')
}

async function settle(Component, props, react) {
  let tree = renderOnceWith(react, Component, props)
  await flushAsync()
  for (let i = 0; i < 60; i += 1) {
    if (!react.isDirty()) return tree
    tree = renderOnceWith(react, Component, props)
    await flushAsync()
  }
  throw new Error('component did not settle after interaction')
}

/* -------------------------------------------------------- tree helpers */

function walk(node, visit) {
  if (node == null || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ kind: 'text', value: String(node) })
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object' || node.type == null) return
  visit({ kind: 'element', node })
  for (const child of node.children || []) walk(child, visit)
}

function textOf(node) {
  let out = ''
  walk(node, (entry) => {
    if (entry.kind === 'text') out += entry.value
  })
  return out
}

function allElements(tree) {
  const list = []
  walk(tree, (entry) => {
    if (entry.kind === 'element') list.push(entry.node)
  })
  return list
}

function classNameOf(node) {
  return String((node && node.props && node.props.className) || '')
}

function byClass(tree, token) {
  return allElements(tree).filter((node) => classNameOf(node).split(/\s+/).includes(token))
}

function byType(tree, type) {
  return allElements(tree).filter((node) => node.type === type)
}

function buttonWithText(tree, text) {
  return byType(tree, 'button').find((node) => textOf(node).includes(text))
}

function clickNode(node) {
  if (!node || typeof node.props.onClick !== 'function') throw new Error('node is not clickable')
  node.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {}, currentTarget: {} })
}

/* ------------------------------------------------------------ assertions */

let failures = 0
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

/* ------------------------------------------------------- loading sources */

const parts = ORDER.map((file) => {
  const full = path.join(SRC, file)
  if (!fs.existsSync(full)) throw new Error(`missing client source: ${file}`)
  return `// ---- ${file} ----\n${fs.readFileSync(full, 'utf8')}`
})

const makeModule = new Function(
  'require',
  `const React = require('react');
const h = React.createElement;
${parts.join('\n')}
return { SyncPanel, GitGraphModal, gitGraphLayout, gitGraphReachable, gitGraphResolveRepo, gitGraphResolveHead, gitGraphCopyText };`,
)

const react = createReact()
const mod = makeModule((name) => {
  if (name === 'react') return react.React
  throw new Error(`unexpected require: ${name}`)
})
const {
  SyncPanel,
  GitGraphModal,
  gitGraphLayout,
  gitGraphReachable,
  gitGraphResolveRepo,
  gitGraphResolveHead,
} = mod

/* ------------------------------------------------------------------ APIs */

function installFetch(routes) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    calls.push({ url: text, init })
    let payload
    for (const route of routes) {
      if (text.includes(route.match)) {
        payload = typeof route.payload === 'function' ? route.payload(text, init) : route.payload
        break
      }
    }
    if (payload === undefined) payload = { ok: true }
    return { ok: true, status: 200, json: async () => payload }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

function installClipboardDocument() {
  const previous = globalThis.document
  globalThis.document = {
    body: { appendChild() {}, removeChild() {} },
    createElement() {
      return {
        style: {},
        value: '',
        setAttribute() {},
        select() {},
        setSelectionRange() {},
      }
    },
    execCommand() {
      return true
    },
  }
  return {
    restore() {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    },
  }
}

/* ------------------------------------------------------- pure logic tests */

function commit(hash, parents, extra = {}) {
  return {
    hash,
    short: hash.slice(0, 7),
    parents,
    author: extra.author || 'tester',
    date: extra.date || '2026-11-04 10:00',
    subject: extra.subject || `subject ${hash}`,
    refs: extra.refs || [],
  }
}

function testLayout() {
  console.log('\n[1] gitGraphLayout fixtures')
  const linear = [commit('aa1', ['bb2']), commit('bb2', ['cc3']), commit('cc3', [])]
  const linearLayout = gitGraphLayout(linear)
  check('linear rows', linearLayout.rows.length === 3)
  check('linear lanes all 0', linearLayout.rows.every((row) => row.lane === 0))
  check('linear laneCount 1', linearLayout.laneCount === 1)
  check('linear edges 2', linearLayout.edges.length === 2)

  // Merge commit m -> (a, b); a -> root; b -> root.
  const merge = [commit('m000', ['a111', 'b222']), commit('a111', ['r333']), commit('b222', ['r333']), commit('r333', [])]
  const mergeLayout = gitGraphLayout(merge)
  check('merge rows 4', mergeLayout.rows.length === 4)
  check('merge root lane = first child lane', mergeLayout.rows[3].lane === 0)
  check('merge second parent gets own lane', mergeLayout.rows[2].lane === 1)
  check('merge laneCount 2', mergeLayout.laneCount === 2)
  check('merge edge count 4', mergeLayout.edges.length === 4)
  const crossEdge = mergeLayout.edges.find((edge) => edge.hash === 'b222' && edge.parent === 'r333')
  check('merge cross edge lanes', !!crossEdge && crossEdge.lane === 1 && crossEdge.parentLane === 0)
  check('all edges go downward', mergeLayout.edges.every((edge) => edge.parentRow > edge.row))
  check(
    'edges reference existing rows',
    mergeLayout.edges.every((edge) => mergeLayout.rowOf.has(edge.parent) && mergeLayout.rowOf.has(edge.hash)),
  )

  const reach = gitGraphReachable(merge, 'b222')
  check('reachable from b222', reach.size === 2 && reach.has('b222') && reach.has('r333'))
  check('reachable from m000', gitGraphReachable(merge, 'm000').size === 4)
  check('reachable unknown head', gitGraphReachable(merge, 'zzz').size === 0)

  // A parent outside the loaded window must not produce a dangling edge.
  const truncated = [commit('bb1', ['gone']), commit('gone', [])]
  check('missing parent edge skipped', gitGraphLayout(truncated).edges.length === 1)

  // Branch refs are abbreviated; resolveHead must map them to full hashes.
  check('resolveHead exact', gitGraphResolveHead(merge, 'm000') === 'm000')
  check('resolveHead abbreviation', gitGraphResolveHead(merge, 'm00') === 'm000')
  check('resolveHead unknown', gitGraphResolveHead(merge, 'nope') === '')
}

function testResolveRepo() {
  console.log('\n[2] gitGraphResolveRepo')
  const repos = [
    { repo: 'a/b', path: 'a/b', name: 'b' },
    { repo: 'a/b/c', path: 'a/b/c', name: 'c' },
  ]
  check('longest repo prefix wins', gitGraphResolveRepo(repos, 'a/b/c/x.md').query === 'a/b/c')
  check('repo path itself', gitGraphResolveRepo(repos, 'a/b').query === 'a/b')
  check('unknown path queried directly', gitGraphResolveRepo(repos, 'x/y.md').query === 'x/y.md')
  check('empty path -> first repo', gitGraphResolveRepo(repos, '').query === 'a/b')
  check('no repos -> empty query', gitGraphResolveRepo([], '').query === '')
}

async function testRealGraph() {
  console.log('\n[3] real Host graph data (core repo, 200 commits)')
  let payload
  try {
    const response = await fetch(
      `${HOST}/api/git/graph?path=${encodeURIComponent('20260917-微服务/gits/core')}&limit=200`,
    )
    payload = await response.json()
  } catch (error) {
    console.log(`  skip  standalone server not reachable: ${error.message}`)
    return
  }
  const commits = Array.isArray(payload.commits) ? payload.commits : []
  check('real commits returned', commits.length > 100, commits.length)
  const layout = gitGraphLayout(commits)
  check('real rows == commits', layout.rows.length === commits.length)
  check('real laneCount bounded', layout.laneCount >= 1 && layout.laneCount <= 16, layout.laneCount)
  check('real edges downward', layout.edges.every((edge) => edge.parentRow > edge.row))
  check('real edges resolve', layout.edges.every((edge) => layout.rowOf.has(edge.parent)))
  const head = payload.branches && payload.branches[0]
  if (head) {
    const reachable = gitGraphReachable(commits, gitGraphResolveHead(commits, head.hash))
    check('real branch abbreviation resolves', gitGraphResolveHead(commits, head.hash) !== '', head.hash)
    check('real reachability non-trivial', reachable.size > 1, reachable.size)
  }
  console.log(`  info  commits=${commits.length} lanes=${layout.laneCount} edges=${layout.edges.length}`)
}

async function testRealGraphComponent() {
  console.log('\n[3b] GitGraphModal · real 200-commit graph through the component')
  let payload
  try {
    const response = await fetch(
      `${HOST}/api/git/graph?path=${encodeURIComponent('20260917-微服务/gits/core')}&limit=200`,
    )
    payload = await response.json()
  } catch (error) {
    console.log(`  skip  standalone server not reachable: ${error.message}`)
    return
  }
  const repo = { repo: '20260917-微服务/gits/core', name: 'core', path: '20260917-微服务/gits/core' }
  const fake = installFetch([
    { match: '/api/git/repos', payload: { ok: true, repos: [repo] } },
    { match: '/api/git/graph', payload },
  ])
  try {
    const props = { path: '', onClose() {}, onOpen() {} }
    let tree = await mount(GitGraphModal, props, react)
    const rows = byClass(tree, 'mdr-gitgraph-row')
    check('real component rows', rows.length === payload.commits.length, `${rows.length}/${payload.commits.length}`)
    check('real component dots', byClass(tree, 'mdr-gitgraph-dot').length === payload.commits.length)
    check('real component edges', byClass(tree, 'mdr-gitgraph-edge').length > 200)
    check('real component no NaN', !/NaN/.test(textOf(tree)))
    check('real component current branch', textOf(tree).includes(payload.current))

    const branch = payload.branches[0]
    const chip = byType(tree, 'button').find((node) => textOf(node).includes(branch.name))
    clickNode(chip)
    tree = await settle(GitGraphModal, props, react)
    const expected = gitGraphReachable(payload.commits, gitGraphResolveHead(payload.commits, branch.hash)).size
    const highlighted = byClass(tree, 'mdr-gitgraph-row').filter((node) => classNameOf(node).includes('on')).length
    check('real branch chip highlight count', highlighted === expected, `${highlighted}/${expected}`)

    clickNode(byClass(tree, 'mdr-gitgraph-row')[0])
    tree = await settle(GitGraphModal, props, react)
    check('real commit detail opens', byClass(tree, 'mdr-gitgraph-detail').length === 1)
  } finally {
    fake.restore()
  }
}

async function testRealSyncPanel() {
  console.log('\n[3c] SyncPanel · real Host endpoint through the component (state-agnostic)')
  const props = { onClose() {} }
  const realFetch = globalThis.fetch
  let status = null
  try {
    const response = await realFetch('http://127.0.0.1:8799/api/sync/status')
    status = await response.json()
  } catch (error) {
    console.log(`  skip  real sync endpoint not reachable: ${error.message}`)
    return
  }
  if (!status || status.ok === false) {
    console.log('  skip  real sync endpoint returned no status')
    return
  }
  check(
    'real sync status shape',
    typeof status.configured === 'boolean' && typeof status.repo === 'string' && Array.isArray(status.commits),
    JSON.stringify(status).slice(0, 200),
  )
  // fetchJson() uses same-origin relative URLs (fine in the browser); in Node
  // resolve them against the standalone Host origin before delegating.
  globalThis.fetch = (url, init) => realFetch(new URL(String(url), 'http://127.0.0.1:8799').href, init)
  try {
    let tree = await mount(SyncPanel, props, react)
    tree = await settleFor(SyncPanel, props, react, 1500)
    const text = textOf(tree)
    const repoName = String(status.repo || '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || ''
    check('real panel repo rendered', !repoName || text.includes(repoName), repoName)
    check('real panel branch rendered', !status.branch || text.includes(status.branch), status.branch)
    // The plugin checkout this harness runs against now HAS an origin remote
    // (git@github.com:TechieBreeze/MarkdownReader.git) and an unclean tree, so the
    // previous "must be 未配置同步远程仓库" assertions were stale (bound to an old
    // checkout state), NOT a product regression. Assert the component mirrors
    // whatever the real endpoint reports instead of hard-coding that state.
    if (status.configured === false) {
      check('real panel not-configured reason rendered', text.includes('未配置同步远程仓库'), text.slice(0, 160))
      check('real panel not-configured how-to rendered', text.includes('syncRepo') || text.includes('git remote add origin'))
    } else {
      check('real panel configured state rendered', !text.includes('未配置同步远程仓库'), text.slice(0, 120))
    }
    const initialPull = buttonWithText(tree, '拉取更新')
    check(
      'real pull disabled until fetched updates exist',
      !!initialPull && initialPull.props.disabled === true,
      initialPull && initialPull.props.disabled,
    )
    const checkButton = buttonWithText(tree, '检查更新')
    check('real check button rendered', !!checkButton)
    clickNode(checkButton)
    tree = await settleFor(SyncPanel, props, react, 2500)
    const after = textOf(tree)
    check(
      'real check keeps the same configured state',
      status.configured === false ? after.includes('未配置同步远程仓库') : after.includes(repoName),
      repoName || '(not configured)',
    )
    check('real check keeps the panel rendered', after.includes('检查更新') && !!buttonWithText(tree, '拉取更新'))
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ----------------------------------------------------- SyncPanel tests */

const NOT_CONFIGURED = {
  ok: true,
  configured: false,
  repo: 'code/agent-workspace/x',
  branch: 'master',
  current: 'master',
  remote: '',
  behind: 0,
  ahead: 0,
  dirty: false,
  fetched: false,
  commits: [],
  reason: '未配置同步远程仓库：可在插件 config 里设置 syncRepo / syncBranch，或给插件所在 git 仓库添加 origin 远程',
}

function configuredStatus(fetched) {
  return {
    ok: true,
    configured: true,
    repo: 'code/agent-workspace/x',
    branch: 'master',
    current: 'master',
    remote: 'https://example.com/x.git',
    behind: fetched ? 2 : 0,
    ahead: fetched ? 1 : 0,
    dirty: false,
    fetched,
    reason: '',
    commits: fetched
      ? [
          {
            hash: '1111111aaaa',
            short: '1111111',
            author: 'Alice',
            date: '2026-11-04 12:00',
            subject: 'feat: first new commit',
          },
          {
            hash: '2222222bbbb',
            short: '2222222',
            author: 'Bob',
            date: '2026-11-04 11:00',
            subject: 'fix: second new commit',
          },
        ]
      : [],
  }
}

async function testSyncPanelNotConfigured() {
  console.log('\n[4] SyncPanel · not configured')
  const fake = installFetch([{ match: '/api/sync/status', payload: NOT_CONFIGURED }])
  try {
    let closed = 0
    const tree = await mount(SyncPanel, { onClose: () => (closed += 1) }, react)
    const text = textOf(tree)
    check('title rendered', text.includes('检查更新'))
    check('not configured status line', text.includes('未配置同步远程仓库'))
    check('reason + how-to shown', text.includes('syncRepo') && text.includes('git remote add origin'))
    check('check button rendered', !!buttonWithText(tree, '检查更新'))
    const pullButton = buttonWithText(tree, '拉取更新')
    check('pull button rendered + disabled', !!pullButton && pullButton.props.disabled === true)
    check('initial load without fetch', fake.calls.length === 1 && !fake.calls[0].url.includes('fetch=1'))

    clickNode(buttonWithText(tree, '检查更新'))
    const tree2 = await settle(SyncPanel, { onClose: () => (closed += 1) }, react)
    check('check triggers fetch=1', fake.calls.some((call) => call.url.includes('/api/sync/status?fetch=1')))
    check('not configured persists after check', textOf(tree2).includes('未配置同步远程仓库'))
    check('no pull POST attempted', !fake.calls.some((call) => call.url.includes('/api/sync/pull')))
    const overlay = byClass(tree2, 'mdr-overlay')[0]
    let overlayClosed = false
    if (overlay && typeof overlay.props.onClick === 'function') {
      overlay.props.onClick({ stopPropagation() {} })
      overlayClosed = closed === 1
    }
    check('overlay close wired', overlayClosed)
  } finally {
    fake.restore()
  }
}

async function testSyncPanelPull() {
  console.log('\n[5] SyncPanel · updates available + pull')
  const fake = installFetch([
    { match: '/api/sync/status?fetch=1', payload: configuredStatus(true) },
    { match: '/api/sync/status', payload: configuredStatus(false) },
    {
      match: '/api/sync/pull',
      payload: {
        ok: true,
        changed: true,
        before: 'aaa',
        after: 'bbb',
        note: '已更新。Client 代码刷新页面生效；Host 代码需在插件管理器里把 bundle 禁用再启用',
        status: configuredStatus(false),
      },
    },
  ])
  try {
    const props = { onClose() {} }
    let tree = await mount(SyncPanel, props, react)
    check('initial status line', textOf(tree).includes('已读取本地状态'))
    check('pull disabled before check', buttonWithText(tree, '拉取更新').props.disabled === true)

    clickNode(buttonWithText(tree, '检查更新'))
    tree = await settle(SyncPanel, props, react)
    const text = textOf(tree)
    check('update status line', text.includes('有 2 个新提交可拉取'))
    check('behind/ahead pills', text.includes('落后 2 条') && text.includes('领先 1 条'))
    check('pending commit list header', text.includes('待拉取提交') && text.includes('共 2 条'))
    check('pending commits rendered', text.includes('feat: first new commit') && text.includes('fix: second new commit'))
    check('pull enabled with updates', buttonWithText(tree, '拉取更新').props.disabled === false)

    clickNode(buttonWithText(tree, '拉取更新'))
    tree = await settle(SyncPanel, props, react)
    const pulledText = textOf(tree)
    check(
      'pull POST issued',
      fake.calls.some((call) => call.url.includes('/api/sync/pull') && call.init && call.init.method === 'POST'),
    )
    check('pull note shown', pulledText.includes('已更新'))
    check('refresh reminder shown', pulledText.includes('刷新页面') && pulledText.includes('禁用再启用'))
  } finally {
    fake.restore()
  }
}

async function testSyncPanelPullRefused() {
  console.log('\n[6] SyncPanel · pull refused on dirty tree')
  const dirtyStatus = {
    ...configuredStatus(true),
    behind: 1,
    dirty: true,
    commits: [{ short: '3333333', hash: '3333333c', author: 'C', date: '2026-11-04 10:00', subject: 'third' }],
  }
  const fake = installFetch([
    { match: '/api/sync/status?fetch=1', payload: dirtyStatus },
    { match: '/api/sync/status', payload: { ...dirtyStatus, fetched: false, behind: 0, commits: [] } },
    {
      match: '/api/sync/pull',
      payload: { ok: false, error: '插件目录有未提交的本地改动，已取消拉取（避免覆盖）', status: dirtyStatus },
    },
  ])
  try {
    const props = { onClose() {} }
    let tree = await mount(SyncPanel, props, react)
    clickNode(buttonWithText(tree, '检查更新'))
    tree = await settle(SyncPanel, props, react)
    check('dirty warning shown', textOf(tree).includes('本地有未提交改动'))
    check('pull still clickable so backend can refuse', buttonWithText(tree, '拉取更新').props.disabled === false)
    clickNode(buttonWithText(tree, '拉取更新'))
    tree = await settle(SyncPanel, props, react)
    const text = textOf(tree)
    check('backend refusal surfaced', text.includes('拉取更新失败') && text.includes('未提交的本地改动'))
  } finally {
    fake.restore()
  }
}

/* -------------------------------------------------- GitGraphModal tests */

const REPOS = [
  { repo: 'proj/web', name: 'web', path: 'proj/web' },
  { repo: 'proj/core', name: 'core', path: 'proj/core' },
]

function graphFixture() {
  return {
    ok: true,
    repo: 'proj/web',
    name: 'web',
    current: 'main',
    branches: [
      { name: 'main', hash: 'm000000' },
      { name: 'feature', hash: 'b222222' },
    ],
    commits: [
      commit('m000000', ['a111111', 'b222222'], {
        author: 'Alice',
        subject: 'Merge branch feature into main',
        refs: ['main'],
      }),
      commit('a111111', ['r333333'], { author: 'Alice', subject: 'feat: main line change' }),
      commit('b222222', ['r333333'], { author: 'Bob', subject: 'feat: feature line change', refs: ['feature'] }),
      commit('r333333', [], { author: 'Carol', subject: 'chore: root commit' }),
    ],
  }
}

function coreFixture() {
  return {
    ok: true,
    repo: 'proj/core',
    name: 'core',
    current: 'master',
    branches: [{ name: 'master', hash: 'c000000' }],
    commits: [commit('c000000', [], { author: 'Dan', subject: 'core: only commit', refs: ['master'] })],
  }
}

async function testGitGraphModal() {
  console.log('\n[7] GitGraphModal · render + interactions')
  const fake = installFetch([
    { match: '/api/git/repos', payload: { ok: true, repos: REPOS } },
    {
      match: '/api/git/graph',
      payload: (url) => (url.includes('path=proj%2Fcore') ? coreFixture() : graphFixture()),
    },
  ])
  const clipboard = installClipboardDocument()
  try {
    let closed = 0
    const props = { path: 'proj/web/src/app.ts', onClose: () => (closed += 1), onOpen() {} }
    let tree = await mount(GitGraphModal, props, react)
    const text = textOf(tree)
    check('modal title', text.includes('Git 版本树'))
    check('repo picker rendered', byType(tree, 'select').length === 1)
    check(
      'initial graph query uses path repo',
      fake.calls.some((call) => call.url.includes('/api/git/graph') && call.url.includes('path=proj%2Fweb')),
    )
    check('repo name shown', text.includes('web') && text.includes('proj/web'))
    check('branch chips shown', text.includes('全部提交') && text.includes('main') && text.includes('feature'))
    check('commits rendered', text.includes('Merge branch feature into main') && text.includes('feat: feature line change'))
    check('graph rows count', byClass(tree, 'mdr-gitgraph-row').length === 4)
    check('svg rendered', byType(tree, 'svg').length === 1)
    check('dots rendered', byClass(tree, 'mdr-gitgraph-dot').length === 4)
    check('edges rendered', byClass(tree, 'mdr-gitgraph-edge').length === 4)
    check('merge dot is diamond', byType(tree, 'rect').some((node) => classNameOf(node).includes('mdr-gitgraph-dot')))
    check('stats text', text.includes('4 提交') && text.includes('2 分支'))
    check('current branch hint', text.includes('当前分支 main'))
    check('detail hidden initially', byClass(tree, 'mdr-gitgraph-detail').length === 0)

    // Select a commit row -> detail panel.
    clickNode(byClass(tree, 'mdr-gitgraph-row')[0])
    tree = await settle(GitGraphModal, props, react)
    const detail = byClass(tree, 'mdr-gitgraph-detail')[0]
    check('detail shown after row click', !!detail)
    const detailText = textOf(detail || { children: [] })
    check(
      'detail has hash/author/date/subject',
      detailText.includes('m000000') &&
        detailText.includes('Alice') &&
        detailText.includes('2026-11-04 10:00') &&
        detailText.includes('Merge branch feature into main'),
    )
    check('detail has two parents', byClass(tree, 'mdr-gitgraph-parent').length === 2)
    check('selected row marked', byClass(tree, 'mdr-gitgraph-row').some((node) => classNameOf(node).includes('selected')))

    // Copy hash (fallback path via fake document).
    clickNode(buttonWithText(tree, '复制 hash'))
    tree = await settle(GitGraphModal, props, react)
    check('copy feedback', textOf(tree).includes('已复制 hash'))

    // Parent jump.
    clickNode(byClass(tree, 'mdr-gitgraph-parent')[0])
    tree = await settle(GitGraphModal, props, react)
    check('parent jump selects parent', textOf(tree).includes('feat: main line change'))

    // Branch chip highlight.
    clickNode(byType(tree, 'button').find((node) => textOf(node).includes('feature')))
    tree = await settle(GitGraphModal, props, react)
    check(
      'branch filter highlights reachable rows',
      byClass(tree, 'mdr-gitgraph-row').filter((node) => classNameOf(node).includes('on')).length === 2,
    )
    check(
      'branch filter dims others',
      byClass(tree, 'mdr-gitgraph-row').filter((node) => classNameOf(node).includes('dim')).length === 2,
    )
    check('branch filter hint', textOf(tree).includes('已高亮 2 个提交'))
    clickNode(byType(tree, 'button').find((node) => textOf(node).includes('feature')))
    tree = await settle(GitGraphModal, props, react)
    check(
      'branch filter toggles off',
      byClass(tree, 'mdr-gitgraph-row').filter((node) => classNameOf(node).includes('dim')).length === 0,
    )

    // Repo switching.
    byType(tree, 'select')[0].props.onChange({ target: { value: 'proj/core' } })
    tree = await settle(GitGraphModal, props, react)
    check(
      'repo switch graph query',
      fake.calls.some((call) => call.url.includes('/api/git/graph') && call.url.includes('path=proj%2Fcore')),
    )
    check('repo switch commits shown', textOf(tree).includes('core: only commit'))

    // Overlay close.
    byClass(tree, 'mdr-overlay')[0].props.onClick({ stopPropagation() {} })
    check('overlay close wired', closed === 1)
  } finally {
    clipboard.restore()
    fake.restore()
  }
}

async function testGitGraphEmpty() {
  console.log('\n[8] GitGraphModal · empty repos + repos failure')
  const fake = installFetch([{ match: '/api/git/repos', payload: { ok: true, repos: [] } }])
  try {
    const tree = await mount(GitGraphModal, { path: '', onClose() {}, onOpen() {} }, react)
    const text = textOf(tree)
    check('empty repos state', text.includes('没有找到 git 仓库'))
    check('no graph request without repo', !fake.calls.some((call) => call.url.includes('/api/git/graph')))
  } finally {
    fake.restore()
  }

  const failing = installFetch([{ match: '/api/git/repos', payload: { ok: false, error: 'boom' } }])
  try {
    const tree = await mount(GitGraphModal, { path: '', onClose() {}, onOpen() {} }, react)
    const text = textOf(tree)
    check('repos failure surfaced', text.includes('仓库列表加载失败'))
    check('retry button rendered', !!buttonWithText(tree, '重试'))
  } finally {
    failing.restore()
  }
}

async function main() {
  console.log('Markdown Reader panels harness')
  testLayout()
  testResolveRepo()
  await testRealGraph()
  await testRealGraphComponent()
  await testRealSyncPanel()
  await testSyncPanelNotConfigured()
  await testSyncPanelPull()
  await testSyncPanelPullRefused()
  await testGitGraphModal()
  await testGitGraphEmpty()
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error('\nharness crashed:', error)
  process.exitCode = 1
})
