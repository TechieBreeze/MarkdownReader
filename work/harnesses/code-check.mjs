/**
 * Temporary harness for the code-view slice (20-code.js / 15-git.js / 22-defs.js
 * / 24-modal.js). Not part of the plugin, not committed (tmp/).
 *
 * Verifies WITHOUT a browser:
 *   1. the ported whole-file highlighter (multi-line comments/strings, Java/Kotlin
 *      type/method/variable post-passes, per-line span balance, palette classes)
 *   2. the CodeBody jump logic (explicit jump vs scroll memory, late content,
 *      already-open tab new line, persistent .hit highlight, deleted diff rows)
 *   3. the git-adapted-link helper (branch / commit view applied via fake /api/git/*)
 *   4. static wiring checks (tab back button, modal request branch/commit, no timers)
 *
 * Usage: node tmp/code-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const ORDER = ['00-core.js', '15-git.js', '20-code.js', '22-defs.js', '24-modal.js']

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
  const runCleanups = () => {
    for (const cell of cells) {
      if (cell && typeof cell.cleanup === 'function') {
        try {
          cell.cleanup()
        } catch {
          /* ignore */
        }
        cell.cleanup = null
      }
    }
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
    useReducer(reducer, initial) {
      const index = hookIndex++
      const cell = ensure(index, () => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }))
      const dispatch = (action) => {
        const value = reducer(cell.value, action)
        if (!Object.is(value, cell.value)) {
          cell.value = value
          dirty = true
        }
      }
      return [cell.value, dispatch]
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
      runCleanups()
      cells = []
      hookIndex = 0
      dirty = false
      effectQueue = []
    },
    unmount() {
      runCleanups()
      cells = []
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flushAsync = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/* ------------------------------------------------------------ fake DOM */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' }
function decodeEntities(text) {
  return String(text).replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (m, name) => ENTITIES[name])
}

function makeTextNode(text, parent) {
  return { nodeType: 3, textContent: text, parentNode: parent, previousSibling: null }
}
function makeElement(className, parent) {
  const node = { nodeType: 1, className, childNodes: [], parentNode: parent, previousSibling: null }
  Object.defineProperty(node, 'textContent', {
    get() {
      return node.childNodes.map((child) => child.textContent).join('')
    },
  })
  return node
}
function appendChild(parent, child) {
  const siblings = parent.childNodes
  child.previousSibling = siblings.length ? siblings[siblings.length - 1] : null
  siblings.push(child)
}

/** hljs output is spans + escaped text only; a tiny parser is enough here. */
function parseHlHtml(html) {
  const root = { nodeType: 11, childNodes: [], textContent: '' }
  const stack = [root]
  const pushText = (text) => {
    if (!text) return
    appendChild(stack[stack.length - 1], makeTextNode(decodeEntities(text), stack[stack.length - 1]))
  }
  const re = /<span\b([^>]*)>|<\/span>/gi
  let last = 0
  let match
  while ((match = re.exec(html)) !== null) {
    pushText(html.slice(last, match.index))
    if (match[0].startsWith('</')) {
      if (stack.length > 1) stack.pop()
    } else {
      const cls = /class="([^"]*)"/.exec(match[1])
      const parent = stack[stack.length - 1]
      const element = makeElement(cls ? cls[1] : '', parent)
      appendChild(parent, element)
      stack.push(element)
    }
    last = re.lastIndex
  }
  pushText(html.slice(last))
  return root
}

function makeTemplate() {
  return {
    content: null,
    set innerHTML(value) {
      this.content = parseHlHtml(String(value))
    },
    get innerHTML() {
      return ''
    },
  }
}

/* ------------------------------------------------------- fake globals */

function installBrowserGlobals() {
  const store = new Map()
  globalThis.window = globalThis.window || {}
  globalThis.localStorage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
  }
  const headChildren = []
  globalThis.document = {
    head: {
      appendChild(element) {
        headChildren.push(element)
      },
    },
    createElement(tag) {
      if (tag === 'template') return makeTemplate()
      if (tag === 'style') return { id: '', textContent: '', style: {} }
      throw new Error(`unexpected document.createElement(${tag})`)
    },
    getElementById(id) {
      return headChildren.find((element) => element.id === id) || null
    },
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
  return { store, headChildren }
}

/* ------------------------------------------------------- load sources */

function loadModule() {
  const parts = ORDER.map((file) => {
    const full = path.join(SRC, file)
    if (!fs.existsSync(full)) throw new Error(`missing client source: ${file}`)
    return `// ---- ${file} ----\n${fs.readFileSync(full, 'utf8')}`
  })
  const factory = new Function(
    'require',
    `const React = require('react');
const h = React.createElement;
${parts.join('\n')}
return {
  highlightByLine, highlightLinesCached, highlightCodeHtml, highlightLineHtml, isJavaKtLang, enhanceJavaKtTypes,
  hljsLangNormalized, renderFenceCodeHtml, ensureFenceCss, FENCE_CSS, FENCE_CSS_ID,
  CodeBody, CodeView, CodeModalInner, useCodeRows, applyGitTarget, gitViewFor, gitViewKey, ensureGitViewReady,
  selectGitBranch, selectGitCommit, GIT_CSS, GIT_LINE_H, GIT_V_THRESHOLD, langForPath,
  isImportPathText,
};`,
  )
  return factory((name) => {
    if (name === 'react') return react.React
    throw new Error(`unexpected require: ${name}`)
  })
}

/* ------------------------------------------------------------ rendering */

const refElements = new Map()

function makeFakeElement() {
  return {
    scrollTop: 0,
    clientHeight: 600,
    scrollHeight: 40000,
    scrollWidth: 1200,
    clientWidth: 1200,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false
      },
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
  }
}

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

function attachRefs(tree) {
  walk(tree, (entry) => {
    if (entry.kind !== 'element') return
    const ref = entry.node.props && entry.node.props.ref
    if (!ref || typeof ref !== 'object') return
    if (!refElements.has(ref)) refElements.set(ref, makeFakeElement())
    ref.current = refElements.get(ref)
  })
}

function* elements(tree) {
  const list = []
  walk(tree, (entry) => {
    if (entry.kind === 'element') list.push(entry.node)
  })
  yield* list
}

function innerHtmlOf(tree) {
  let html = ''
  for (const node of elements(tree)) {
    const danger = node.props && node.props.dangerouslySetInnerHTML
    if (danger && typeof danger.__html === 'string') html += danger.__html
  }
  return html
}

let lastTree = null

/** The rendered `.mdr-code-body` element node (for invoking its onScroll). */
function bodyNodeOf(tree) {
  return [...elements(tree)].find((node) => String((node.props && node.props.className) || '').includes('mdr-code-body'))
}

/** Render `Component(props)` until no state updates are pending. */
async function mount(Component, props) {
  react.reset()
  refElements.clear()
  let tree = renderOnce(Component, props)
  await flushAsync()
  for (let i = 0; i < 120; i += 1) {
    if (!react.isDirty()) {
      lastTree = tree
      return tree
    }
    tree = renderOnce(Component, props)
    await flushAsync()
  }
  throw new Error('component did not settle')
}

/** Re-render with new props (same mounted instance) until settled. */
async function rerender(Component, props) {
  let tree = renderOnce(Component, props)
  await flushAsync()
  for (let i = 0; i < 120; i += 1) {
    if (!react.isDirty()) {
      lastTree = tree
      return tree
    }
    tree = renderOnce(Component, props)
    await flushAsync()
  }
  throw new Error('component did not settle after rerender')
}

function renderOnce(Component, props) {
  react.beginRender()
  const tree = Component(props)
  attachRefs(tree)
  react.runEffects()
  return tree
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

/* ------------------------------------------------------------------ main */

const browser = installBrowserGlobals()
// Load the real vendored highlight.js so the highlighter is tested for real.
{
  const code = fs.readFileSync(path.join(ROOT, 'plugin', 'vendor', 'highlight.min.js'), 'utf8')
  const getHljs = new Function('window', 'self', 'navigator', `${code}\nreturn hljs;`)
  globalThis.window.hljs = getHljs(globalThis.window, globalThis.window, { userAgent: 'node' })
}
const react = createReact()
const mod = loadModule()

const stripTags = (html) => decodeEntities(String(html).replace(/<\/?span[^>]*>/g, ''))
const spanBalance = (html) => {
  let depth = 0
  const re = /<span\b[^>]*>|<\/span>/g
  let m
  while ((m = re.exec(html)) !== null) depth += m[0].startsWith('</') ? -1 : 1
  return depth
}

/* ------------------------------------------------------ 1. highlighter */

function testHighlighter() {
  console.log('\n[1] ported whole-file highlighter')
  const java = [
    'package com.pvh.demo;',
    '',
    'import java.util.List;',
    'import java.util.Map;',
    '',
    '/**',
    ' * 多行注释 第一行',
    ' * 第二行 <tag> & 实体',
    ' */',
    'public class DemoService {',
    '    private static final int MAX_COUNT = 10;',
    '    private String name = "hello";',
    '    public void send(String userId, Long orderId) {',
    '        JSONObject result = JSONObject.parseObject(body);',
    '        List<OutputDTO<Long>> list = new ArrayList<>();',
    '        Map<Long, Boolean> flags = new HashMap<>();',
    '        sendCouponDTO.setCustomerId(customerPO.getId());',
    '        if (userId != null) {',
    '            return;',
    '        }',
    '    }',
    '}',
  ].join('\n')
  const lines = mod.highlightByLine(java, 'java')
  const sourceLines = java.split('\n')
  check('line count preserved', lines.length === sourceLines.length, `${lines.length} vs ${sourceLines.length}`)
  check(
    'every line text roundtrips (entities/tags safe)',
    lines.every((html, i) => stripTags(html) === sourceLines[i]),
    lines.findIndex((html, i) => stripTags(html) !== sourceLines[i]),
  )
  check('no unbalanced span per line', lines.every((html) => spanBalance(html) === 0))
  check(
    'multi-line comment lines all carry hljs-comment',
    [5, 6, 7, 8].every((i) => lines[i].includes('hljs-comment')),
    [5, 6, 7, 8].map((i) => lines[i]).join(' | '),
  )
  check('comment keeps <tag> & entities as text', stripTags(lines[7]).includes('第二行 <tag> & 实体'))
  check('class keyword highlighted', lines[9].includes('hljs-keyword') && stripTags(lines[9]).includes('class'))
  // MAX_COUNT in a declaration is already an hljs-variable (stock Java grammar);
  // a bare ALL-CAPS reference outside any span is what the post-pass turns into
  // hljs-constant (the user-visible "enum value/constant is white" bug).
  const constantLine = mod.highlightByLine('        if (count > MAX_LIMIT) {', 'java')[0]
  check('unwrapped ALL CAPS constant gets hljs-constant', constantLine.includes('hljs-constant">MAX_LIMIT'), constantLine)
  check('declared ALL CAPS constant still coloured', lines[10].includes('MAX_COUNT') && (lines[10].includes('hljs-variable">MAX_COUNT') || lines[10].includes('hljs-constant"')), lines[10])
  check('String literal highlighted', lines[11].includes('hljs-string'))
  // params: types + names inside the single hljs-params span
  const paramsLine = lines[12]
  check(
    'param types highlighted inside hljs-params',
    paramsLine.includes('hljs-params') &&
      /<span class="hljs-params[^"]*">[\s\S]*hljs-params[^"]*hljs-type[^"]*">String/.test(paramsLine),
    paramsLine,
  )
  check('param name highlighted as variable', paramsLine.includes('hljs-variable">userId') || paramsLine.includes('hljs-variable">orderId'), paramsLine)
  // static call site: JSONObject type (x2), parseObject as function, vars
  const jsonLine = lines[13]
  check('static call site class name highlighted as type', (jsonLine.match(/hljs-type">JSONObject/g) || []).length >= 2, jsonLine)
  check('method call name highlighted as function_', jsonLine.includes('hljs-title function_">parseObject'), jsonLine)
  check('declared variable highlighted', jsonLine.includes('hljs-variable">result'), jsonLine)
  check('argument identifier highlighted', jsonLine.includes('hljs-variable">body'), jsonLine)
  check('import path class name highlighted as type', lines[2].includes('hljs-type">List'), lines[2])
  // generics
  const genericsLine = lines[14]
  check('generic head List highlighted', genericsLine.includes('hljs-type">List'), genericsLine)
  check('nested generic OutputDTO highlighted', genericsLine.includes('hljs-type">OutputDTO'), genericsLine)
  check('variable list highlighted', genericsLine.includes('hljs-variable">list') || genericsLine.includes('hljs-variable">list<'), genericsLine)
  const mapLine = lines[15]
  check('generic args Long/Boolean highlighted', mapLine.includes('hljs-type">Long') && mapLine.includes('hljs-type">Boolean'), mapLine)
  const chain = lines[16]
  check('field chain variable sendCouponDTO', chain.includes('hljs-variable">sendCouponDTO'), chain)
  check('setter call highlighted as function_', chain.includes('hljs-title function_">setCustomerId'), chain)
  check('nested call highlighted as function_', chain.includes('hljs-title function_">getId'), chain)
  check('no nested spans (no double wrapping)', lines.every((html) => !/<span[^>]*><span[^>]*>[^<]*<\/span><\/span>/.test(html.replace(/<span class="hljs-params[^"]*">/g, ''))))

  // multi-line string (JS template literal)
  const js = ['const text = `line one', 'line two`;', 'const other = 1;'].join('\n')
  const jsLines = mod.highlightByLine(js, 'javascript')
  check('JS template literal line 1 in string span', jsLines[0].includes('hljs-string'), jsLines[0])
  check('JS template literal line 2 in string span', jsLines[1].includes('hljs-string'), jsLines[1])
  check('JS line text roundtrip', jsLines.every((html, i) => stripTags(html) === js.split('\n')[i]))

  // Kotlin
  const kotlin = ['fun send(userId: String, orderId: Long?): Boolean {', '    val name = "x"', '    return true', '}'].join('\n')
  const ktLines = mod.highlightByLine(kotlin, 'kotlin')
  check('kotlin type String highlighted', ktLines[0].includes('String') && (ktLines[0].includes('hljs-type">String') || ktLines[0].includes('hljs-params')), ktLines[0])
  check('kotlin Boolean return type highlighted', ktLines[0].includes('hljs-type">Boolean') || ktLines[0].includes('hljs-built_in">Boolean'), ktLines[0])
  check('kotlin fun/val keywords highlighted', ktLines[0].includes('hljs-keyword') && ktLines[1].includes('hljs-keyword'))
  check('kotlin text roundtrip', ktLines.every((html, i) => stripTags(html) === kotlin.split('\n')[i]))

  // cache by content hash
  const a = mod.highlightLinesCached(java, 'java')
  const b = mod.highlightLinesCached(java, 'java')
  check('highlight cache returns same array for same content', a === b)
  const c = mod.highlightLinesCached(java, 'kotlin')
  check('cache key includes language', c !== a)
  const d = mod.highlightLinesCached(`${java} `, 'java')
  check('cache key includes content', d !== a)

  // palette
  const css = mod.GIT_CSS.toLowerCase()
  for (const color of ['#569cd6', '#ce9178', '#6a9955', '#b5cea8', '#4ec9b0', '#dcdcaa', '#9cdcfe', '#d16969']) {
    check(`palette color ${color}`, css.includes(color))
  }
  check('jump-hover hover rule present', css.includes('.jump-hover span.hljs-title.function_:hover'))
  check('deleted diff row hover disabled', css.includes('.mdr-cl.mdr-git-del span:hover'))
  check('persistent hit rule present', css.includes('.mdr-cl.hit{background'))
}

/* --------------------------------------------------- 2. CodeBody jumps */

const LINE_H = 20
function rowsOf(count, kind) {
  return Array.from({ length: count }, (_, i) => ({ no: i + 1, kind: kind || 'plain', text: `line ${i + 1}` }))
}

async function mountBody(props) {
  refElements.clear()
  const tree = await mount(mod.CodeBody, props)
  const entry = [...refElements.values()][0] || null
  return { tree, body: entry }
}

let bodyElement = null

async function testJumps() {
  console.log('\n[2] CodeBody jump / scroll memory / persistent highlight')

  const rows = rowsOf(2000)
  const base = {
    rows,
    lang: 'java',
    diffMode: false,
    targetLine: 1500,
    viewKey: 'v1',
    scrollKey: 'demo/Hello.java',
    contentReady: true,
  }
  // 0) a FRESH open with a line always jumps, even when scroll memory has a
  //    position for that file (the "Ctrl+click did not jump" complaint).
  localStorage.setItem('mdreader.plugin.codescroll.v1', JSON.stringify({ 'seed/Seeded.java': 5000 }))
  const expectedTop = 1499 * LINE_H - Math.floor((600 - LINE_H) / 2)
  let tree0 = await mount(mod.CodeBody, { ...base, scrollKey: 'seed/Seeded.java', freshOpen: true })
  const element0 = [...refElements.values()][0]
  check('fresh open explicit jump beats seeded scroll memory', element0.scrollTop === expectedTop, element0.scrollTop)

  // 1) explicit jump wins over a saved scroll position
  let tree = await mount(mod.CodeBody, base)
  const element = [...refElements.values()][0]
  const jumpTop = element.scrollTop
  check('explicit jump scrolls to target line', jumpTop === expectedTop, jumpTop)
  let html = innerHtmlOf(tree)
  check('target row has persistent hit class', html.includes('class="mdr-cl hit" data-line="1500"'), html.slice(0, 200))
  check('virtual window rendered (large file)', html.includes('top:'), 'no absolute rows')

  // 2) remount same view (switch away/back): restore remembered position, keep highlight
  react.unmount()
  tree = await mount(mod.CodeBody, base)
  const element2 = [...refElements.values()][0]
  check('remount restores remembered scroll instead of re-jumping', element2.scrollTop === jumpTop, `${element2.scrollTop} vs ${jumpTop}`)
  check('highlight persists on remount', innerHtmlOf(tree).includes('class="mdr-cl hit" data-line="1500"'))

  // 3) already-open tab receives a NEW line -> jump wins
  tree = await rerender(mod.CodeBody, { ...base, targetLine: 1800, viewKey: 'v2' })
  const element3 = [...refElements.values()][0]
  check('new line request jumps again', element3.scrollTop === 1799 * LINE_H - Math.floor((600 - LINE_H) / 2), element3.scrollTop)
  check('new line is the highlighted row', innerHtmlOf(tree).includes('data-line="1800"') && innerHtmlOf(tree).includes('class="mdr-cl hit" data-line="1800"'))

  // 3b) reopening the same link (same line) is still explicit: jump not memory
  {
    const reopen = { ...base, targetLine: 800, scrollKey: 'reopen/Reopen.java', viewKey: 'r1' }
    const tree1 = await mount(mod.CodeBody, { ...reopen, freshOpen: true })
    const el1 = [...refElements.values()][0]
    el1.scrollTop = 111
    bodyNodeOf(tree1).props.onScroll()
    await sleep(320)
    react.unmount()
    // reopen the same code link: explicit jump must beat the 111 memory
    await mount(mod.CodeBody, { ...reopen, freshOpen: true })
    const reopened = [...refElements.values()][0]
    check('reopened same-line link jumps over remembered position', reopened.scrollTop === 799 * LINE_H - Math.floor((600 - LINE_H) / 2), reopened.scrollTop)
    // switch away/back (no fresh open): restore the user's 222 position
    reopened.scrollTop = 222
    bodyNodeOf(lastTree).props.onScroll()
    await sleep(320)
    react.unmount()
    await mount(mod.CodeBody, reopen)
    const remounted = [...refElements.values()][0]
    check('tab switch remount still restores the remembered position', remounted.scrollTop === 222, remounted.scrollTop)
  }

  // 4) late content: while contentReady=false no jump, then jump when ready
  let tree4 = await mount(mod.CodeBody, { ...base, rows: [{ no: 1, kind: 'plain', text: '' }], targetLine: 700, scrollKey: 'late/Late.java', contentReady: false })
  let element4 = [...refElements.values()][0]
  check('jump deferred while content is loading', element4.scrollTop === 0, element4.scrollTop)
  tree4 = await rerender(mod.CodeBody, { ...base, targetLine: 700, scrollKey: 'late/Late.java', contentReady: true })
  element4 = [...refElements.values()][0]
  check('jump applied once content is ready', element4.scrollTop === 699 * LINE_H - Math.floor((600 - LINE_H) / 2), element4.scrollTop)

  // 5) deleted diff rows: target line maps to the added row, never the deleted one
  const diffRows = [
    { no: 1, kind: 'plain', text: 'a' },
    { no: 5, kind: 'del', text: 'old deleted' },
    { no: 5, kind: 'add', text: 'new added' },
    { no: 6, kind: 'plain', text: 'b' },
  ]
  const tree5 = await mount(mod.CodeBody, {
    rows: diffRows,
    lang: 'java',
    diffMode: true,
    targetLine: 5,
    viewKey: 'd1',
    scrollKey: 'diff/Demo.java',
    contentReady: true,
  })
  const html5 = innerHtmlOf(tree5)
  check('diff target highlight lands on added row', /class="mdr-cl mdr-git-add hit" data-line="5"/.test(html5), html5)
  check('deleted row is not highlighted', !/class="mdr-cl mdr-git-del hit"/.test(html5), html5)
  // Diff markers must survive the jump itself (round-7 regression guard for the
  // original's 798442f): the rendered jump target keeps its add/del rows.
  check(
    'diff add/del markers kept after jump',
    (html5.match(/mdr-git-(?:add|del|ctx)/g) || []).length >= 2,
    (html5.match(/mdr-git-(?:add|del|ctx)/g) || []).length,
  )

  // 6) round-7 single-target definition flow: the old candidate chooser is gone,
  //    each Ctrl+click sends one v2 /api/def request and deleted diff rows stay
  //    non-jumpable (behaviour is covered in work/harnesses/defs-check.mjs).
  const defsSource = fs.readFileSync(path.join(SRC, '22-defs.js'), 'utf8')
  check('ctrl+click skips deleted diff rows', defsSource.includes('.mdr-git-del') && /definitionHitAt|setupDefinitionClick/.test(defsSource))
  check('defs sends one v2 /api/def request', /postJson\('\/api\/def'/.test(defsSource) && /definitionRequestBody/.test(defsSource))
  check('defs candidate chooser removed (single-target jump)', !/DefinitionChooser/.test(defsSource) && !/candidates/.test(defsSource))

  // 7) persistent highlight has no expiry timer
  const codeSource = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
  check('no 2.4s highlight timer in tab code', !/2400/.test(codeSource))
  check('no setHitLine state machinery', !/setHitLine/.test(codeSource))
}

function markBody() {
  const refs = [...refElements.keys()]
  if (refs.length) refs[0].current.__isBody = true
  bodyElement = refs.length ? refs[0].current : null
}

/* --------------------------------------------------- 3. git adapted link */

function installFetch(routes) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    let payload
    for (const route of routes) {
      if (text.includes(route.match)) {
        payload = typeof route.payload === 'function' ? route.payload(text) : route.payload
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

async function testGitTarget() {
  console.log('\n[3] git-adapted link -> branch/commit view (fake /api/git/*)')
  const branches = ['main', 'dev']
  const metaCurrent = {
    ok: true,
    repo: 'r',
    branch: 'main',
    currentBranch: 'main',
    branches,
    commits: [{ hash: 'm1', short: 'm1', author: 'a', date: 'd', subject: 'main commit' }],
  }
  const metaDev = {
    ok: true,
    repo: 'r',
    branch: 'dev',
    currentBranch: 'main',
    branches,
    commits: [{ hash: 'd1', short: 'd1', author: 'a', date: 'd', subject: 'dev commit' }],
  }
  const fake = installFetch([
    { match: '/api/git/meta', payload: (url) => (url.includes('branch=dev') ? metaDev : url.includes('branch=nope') ? metaCurrent : metaCurrent) },
    {
      match: '/api/git/file',
      payload: (url) => {
        if (url.includes('commit=dev')) return { ok: true, content: 'DEV FILE CONTENT' }
        if (url.includes('commit=abc1234')) return { ok: true, content: 'COMMIT FILE CONTENT' }
        return { ok: false, error: 'not found' }
      },
    },
    {
      match: '/api/git/diff',
      payload: {
        ok: true,
        hunks: [{ old_start: 1, new_start: 1, lines: [{ type: '+', text: 'added', old_no: null, new_no: 1 }] }],
      },
    },
  ])

  let refreshes = 0
  const refresh = () => {
    refreshes += 1
  }

  // branch view
  await mod.applyGitTarget({ kind: 'code', path: 'src/Demo.java' }, 'dev', null, refresh)
  let view = mod.gitViewFor('src/Demo.java')
  check('branch applied to view', view.branch === 'dev', view.branch)
  check('branch refetched commits', view.commits.length === 1 && view.commits[0].hash === 'd1', JSON.stringify(view.commits))
  check('branch refetched branch file', view.branchContent === 'DEV FILE CONTENT')
  check('branch view not in commit diff mode', view.commit === null)
  check('view re-rendered after branch load', refreshes > 0)
  check('git bar visible for repo file', view.git === true)

  // commit view (commit wins)
  await mod.applyGitTarget({ kind: 'code', path: 'src/Commit.java' }, null, 'abc1234', refresh)
  view = mod.gitViewFor('src/Commit.java')
  check('commit applied to view', view.commit === 'abc1234', view.commit)
  check('commit diff hunks loaded', view.hunks.length === 1 && view.hunks[0].lines[0].type === '+')
  check('commit version file loaded', Array.isArray(view.fileLines) && view.fileLines[0] === 'COMMIT FILE CONTENT', JSON.stringify(view.fileLines))

  // commit + branch together: branch first, then the commit view
  fake.calls.length = 0
  await mod.applyGitTarget({ kind: 'code', path: 'src/Both.java', gitKey: 'modal:src/Both.java' }, 'dev', 'abc1234', refresh)
  view = mod.gitViewFor('modal:src/Both.java')
  check('both: branch list fetched for branch name', fake.calls.some((url) => url.includes('/api/git/meta') && url.includes('branch=dev')))
  check('both: commit view applied last', view.commit === 'abc1234', view.commit)
  check('both: modal view key isolated from tab view key', mod.gitViewFor('src/Both.java') !== view)

  // invalid branch falls back to the resolved branch from meta
  await mod.applyGitTarget({ kind: 'code', path: 'src/Fallback.java' }, 'nope', null, refresh)
  view = mod.gitViewFor('src/Fallback.java')
  check('invalid branch resolves to meta branch', view.branch === 'main', view.branch)
  check('invalid branch shows a hint instead of blank', typeof view.hint === 'string' && view.hint.includes('不存在此文件'), view.hint)

  // non-git file: bar hidden, no throw
  const fake2 = installFetch([{ match: '/api/git/meta', payload: { ok: false, error: 'not git' } }])
  await mod.applyGitTarget({ kind: 'code', path: 'docs/Plain.md' }, 'dev', null, refresh)
  view = mod.gitViewFor('docs/Plain.md')
  check('non-git file keeps git bar hidden', view.git === false)
  fake2.restore()
  fake.restore()
}

function textOf(node) {
  let out = ''
  walk(node, (entry) => {
    if (entry.kind === 'text') out += entry.value
  })
  return out
}

/** Find child-function-component elements by their function identity. */
function childProps(tree, type) {
  const found = []
  for (const node of elements(tree)) {
    if (node.type === type) found.push(node.props)
  }
  return found
}

/* --------------------------------------------- 5. CodeView / modal wiring */

async function testViewAndModal() {
  console.log('\n[5] CodeView header/back + code modal 开成标签页')
  const branches = ['main', 'dev']
  const fake = installFetch([
    {
      match: '/api/git/meta',
      payload: (url) => ({
        ok: true,
        repo: 'r',
        branch: url.includes('branch=dev') ? 'dev' : 'main',
        currentBranch: 'main',
        branches,
        commits: [{ hash: url.includes('branch=dev') ? 'd1' : 'm1', short: 'x', author: 'a', date: 'd', subject: 's' }],
      }),
    },
    { match: '/api/git/file', payload: (url) => ({ ok: true, content: url.includes('commit=dev') ? 'BRANCH LINE 1\nBRANCH LINE 2\nBRANCH LINE 3' : 'WORKSPACE 1\nWORKSPACE 2\nWORKSPACE 3' }) },
    { match: '/api/git/diff', payload: { ok: true, hunks: [] } },
    {
      match: '/api/code',
      payload: (url) => {
        const match = /[?&]path=([^&]+)/.exec(url)
        const filePath = match ? decodeURIComponent(match[1]) : 'src/Demo.java'
        return { ok: true, path: filePath, lang: 'java', content: 'WORKSPACE 1\nWORKSPACE 2\nWORKSPACE 3', lineCount: 3 }
      },
    },
  ])

  const tab = { id: 'code:src/Demo.java', kind: 'code', path: 'src/Demo.java', content: 'WORKSPACE 1\nWORKSPACE 2\nWORKSPACE 3', lang: 'java', line: 3, branch: 'dev' }
  const opened = []
  const backCalls = []
  let tree = await mount(mod.CodeView, { tab: { ...tab, navFrom: 'md:docs/a.md' }, onOpen: (p, l) => opened.push([p, l]), onBack: () => backCalls.push(1) })
  // the git-adapted branch must be applied on open
  await sleep(30)
  await flushAsync()
  const view = mod.gitViewFor('src/Demo.java')
  check('CodeView applied tab.branch on open', view.branch === 'dev' && view.branchContent != null, `${view.branch}`)
  const bodyProps = childProps(tree, mod.CodeBody)
  check('CodeBody receives the tab jump line', bodyProps.length === 1 && bodyProps[0].targetLine === 3, JSON.stringify(bodyProps[0] && bodyProps[0].targetLine))
  check('CodeBody receives contentReady once content is in', bodyProps[0].contentReady === true)
  check('CodeBody gets jump-hover for java', bodyProps[0].jumpHover === true)
  check('CodeBody gets per-file scroll key', bodyProps[0].scrollKey === 'src/Demo.java')
  const backButtons = [...elements(tree)].filter((node) => node.type === 'button' && textOf(node).includes('← 返回'))
  check('code tab header shows ← 返回 when onBack + navFrom', backButtons.length === 1 && backCalls.length === 0)
  backButtons[0].props.onClick()
  check('back button calls onBack', backCalls.length === 1)

  // no navFrom -> no back button (plain code tab keeps its old header)
  tree = await mount(mod.CodeView, { tab: { ...tab, branch: '', navFrom: '' }, onOpen: () => {} })
  const backWithout = [...elements(tree)].filter((node) => node.type === 'button' && textOf(node).includes('← 返回'))
  check('no back button without navFrom/onBack', backWithout.length === 0)

  // ---------------- code modal ----------------
  let openedTab = null
  const modalTree = await mount(mod.CodeModalInner, {
    request: { path: 'src/Demo.java', line: 2, branch: 'dev' },
    onClose: () => {},
    onOpenTab: (target) => {
      openedTab = target
    },
    onOpen: () => {},
  })
  await sleep(30)
  await flushAsync()
  const modalBody = childProps(modalTree, mod.CodeBody)
  check('modal CodeBody receives request line', modalBody.length === 1 && modalBody[0].targetLine === 2, modalBody[0] && modalBody[0].targetLine)
  check('modal CodeBody gets jump-hover for java', modalBody[0] && modalBody[0].jumpHover === true)
  const modalView = mod.gitViewFor('modal:src/Demo.java')
  check('modal applies request branch in its own git view', modalView.branch === 'dev' && modalView.branchContent != null, modalView.branch)
  const tabButtons = [...elements(modalTree)].filter((node) => node.type === 'button' && textOf(node).includes('开成标签页'))
  check('modal has 开成标签页 button', tabButtons.length === 1)
  tabButtons[0].props.onClick()
  check('开成标签页 carries path+line+branch', !!openedTab && openedTab.path === 'src/Demo.java' && openedTab.line === 2 && openedTab.branch === 'dev', JSON.stringify(openedTab))
  check('开成标签页 does not carry a stale commit', !openedTab || !openedTab.commit, JSON.stringify(openedTab))

  // request carrying a commit -> modal diff view + 开成标签页 carries commit
  let openedCommitTab = null
  const commitTree = await mount(mod.CodeModalInner, {
    request: { path: 'src/Other.java', line: 1, commit: 'abc1234' },
    onClose: () => {},
    onOpenTab: (target) => {
      openedCommitTab = target
    },
    onOpen: () => {},
  })
  await sleep(30)
  await flushAsync()
  const commitView = mod.gitViewFor('modal:src/Other.java')
  check('modal applies request commit', commitView.commit === 'abc1234', commitView.commit)
  const commitTabButtons = [...elements(commitTree)].filter((node) => node.type === 'button' && textOf(node).includes('开成标签页'))
  commitTabButtons[0].props.onClick()
  check('开成标签页 carries the commit', !!openedCommitTab && openedCommitTab.commit === 'abc1234', JSON.stringify(openedCommitTab))

  fake.restore()
}

/* ------------------------------------------------------ 4. static wiring */

function testStaticWiring() {
  console.log('\n[4] static wiring (needs browser visual check)')
  const code = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
  const modal = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
  const git = fs.readFileSync(path.join(SRC, '15-git.js'), 'utf8')

  check('CodeView accepts onBack prop', code.includes('const { tab, onOpen, onBack } = props'))
  check('back button shown only when tab.navFrom', code.includes('typeof onBack === \'function\' && tab.navFrom'))
  check('back button label', code.includes("'← 返回'"))
  check('git target applied on tab open', code.includes('applyGitTarget({ id: tab.id, kind: \'code\', path: tab.path }, tab.branch, tab.commit'))
  check('jump-hover gate on Java/Kotlin lang', code.includes('jumpHover: isJavaKtLang(lang)'))
  check('CodeBody applies jump-hover container class', code.includes("' jump-hover'"))
  check('modal applies request branch/commit', modal.includes('requestBranch') && modal.includes('requestCommit') && modal.includes('gitActions.applyTarget'))
  check('modal git view key isolated', modal.includes("gitKey: 'modal:' + displayPath"))
  check('modal 开成标签页 carries branch/commit', modal.includes('target.commit = gitView.commit') && modal.includes('target.branch = gitView.branch'))
  check('modal highlight persistent (CodeBody targetLine only)', !/2400/.test(modal))
  check('git bar reflects jump commit outside log', git.includes('(跳转提交)'))
  check('branch switch refetches meta with branch', git.includes("'/api/git/meta', { path, branch }"))
  check('branch switch refetches branch file', git.includes("commit: effective"))
  check('applyGitTarget exists', git.includes('async function applyGitTarget'))
}

/* ------------------------------------------- 6. real-file before/after stats */

function testRealFiles() {
  const raw = process.env.CODE_CHECK_REAL_FILES || ''
  const files = raw
    .split(';')
    .map((one) => one.trim())
    .filter(Boolean)
  if (!files.length) {
    console.log('\n[6] real-file stats skipped (set CODE_CHECK_REAL_FILES=a.java;b.java)')
    return
  }
  console.log('\n[6] real service files: per-line hljs vs ported whole-file pipeline')
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const sourceLines = text.split('\n')
    const newLines = mod.highlightByLine(text, 'java')
    check(`${path.basename(file)}: line count preserved`, newLines.length === sourceLines.length)
    check(
      `${path.basename(file)}: line texts roundtrip`,
      newLines.every((html, i) => stripTags(html) === sourceLines[i]),
    )
    check(
      `${path.basename(file)}: md fence output === code-view output`,
      mod.renderFenceCodeHtml(text, 'java') === newLines.join('\n'),
    )
    // lines that carry identifiers but got no colour at all
    let oldBare = 0
    let newBare = 0
    let continuation = 0
    let continuationColoured = 0
    let totalIds = 0
    let oldCoveredIds = 0
    let newCoveredIds = 0
    const ID_RE = /\b[A-Za-z_$][\w$]*\b/g
    // "old" = the plugin's PREVIOUS engine: one independent hljs pass per line,
    // no Java/Kotlin post-passes. That is exactly the reported bug.
    const oldPerLineHtml = (line) => {
      try {
        return window.hljs.highlight(line, { language: 'java', ignoreIllegals: true }).value
      } catch {
        return ''
      }
    }
    const coveredIds = (html) => {
      let count = 0
      const re = /<span[^>]*>([\s\S]*?)<\/span>/g
      let match
      while ((match = re.exec(html)) !== null) {
        const inner = decodeEntities(match[1].replace(/<[^>]*>/g, ''))
        count += (inner.match(ID_RE) || []).length
      }
      return count
    }
    let inBlock = false
    for (let i = 0; i < sourceLines.length; i += 1) {
      const line = sourceLines[i]
      const trimmed = line.trim()
      const hadCommentStart = /\/\*/.test(line)
      const isContinuation = inBlock
      if (hadCommentStart && !/\*\//.test(line)) inBlock = true
      else if (isContinuation && /\*\//.test(line)) inBlock = false
      if (isContinuation && trimmed && trimmed !== '*') {
        continuation += 1
        const oldHtml = oldPerLineHtml(line)
        if (newLines[i].includes('hljs-comment') && !oldHtml.includes('hljs-comment')) continuationColoured += 1
      }
      if (!trimmed || trimmed.length < 4 || !/[A-Za-z]/.test(trimmed)) continue
      if (/^[{}();,]+$/.test(trimmed)) continue
      const oldHtml = oldPerLineHtml(line)
      if (!oldHtml.includes('<span')) oldBare += 1
      if (!newLines[i].includes('<span')) newBare += 1
      totalIds += (trimmed.match(ID_RE) || []).length
      oldCoveredIds += coveredIds(oldHtml)
      newCoveredIds += coveredIds(newLines[i])
    }
    console.log(
      `  · ${path.basename(file)}: lines=${sourceLines.length} zero-highlight old=${oldBare} new=${newBare} ` +
        `multiline-comment continuation lines=${continuation} fixed-by-whole-file=${continuationColoured}`,
    )
    console.log(
      `  · ${path.basename(file)}: identifier colour coverage old=${oldCoveredIds}/${totalIds} new=${newCoveredIds}/${totalIds}`,
    )
    check(`${path.basename(file)}: whole-file pipeline reduces uncoloured lines`, newBare < oldBare || newBare === 0, `${newBare} vs ${oldBare}`)
    check(
      `${path.basename(file)}: whole-file pipeline colours more identifiers`,
      newCoveredIds > oldCoveredIds,
      `${newCoveredIds} vs ${oldCoveredIds}`,
    )
    if (continuation) {
      check(`${path.basename(file)}: every multi-line comment continuation line is coloured`, continuationColoured === continuation, `${continuationColoured}/${continuation}`)
    }
  }
}

/* ---------------------------------- 7. md fenced code blocks (fence pipeline) */

const escapeHtmlForTest = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function testFences() {
  console.log('\n[7] md fenced code blocks == code-view pipeline')
  const norm = mod.hljsLangNormalized
  const normChecks = [
    ['java', 'java'],
    ['JAVA', 'java'],
    ['.java', 'java'],
    ['kt', 'kotlin'],
    ['kts', 'kotlin'],
    ['js', 'javascript'],
    ['jsx', 'javascript'],
    ['ts', 'typescript'],
    ['vue', 'xml'],
    ['svelte', 'xml'],
    ['html', 'xml'],
    ['svg', 'xml'],
    ['py', 'python'],
    ['yml', 'yaml'],
    ['sh', 'bash'],
    ['shell', 'bash'],
    ['properties', 'ini'],
    ['bat', 'bash'],
    ['cmd', 'bash'],
    ['jsonc', 'json'],
    ['patch', 'diff'],
    ['mermaid', ''],
    ['text', ''],
    ['plaintext', ''],
    ['no-such-lang', ''],
    ['', ''],
  ]
  for (const [input, expected] of normChecks) {
    const actual = norm(input)
    check(`hljsLangNormalized(${JSON.stringify(input)}) -> ${expected || "''"}`, actual === expected, actual)
  }

  const java = [
    'package com.pvh.demo;',
    '',
    '/**',
    ' * 多行注释 第一行',
    ' * 第二行 <tag> & 实体',
    ' */',
    'public class DemoService {',
    '    private static final int MAX_COUNT = 10;',
    '    public void send(String userId, Long orderId) {',
    '        JSONObject result = JSONObject.parseObject(body);',
    '        List<OutputDTO<Long>> list = new ArrayList<>();',
    '        sendCouponDTO.setCustomerId(customerPO.getId());',
    '    }',
    '}',
  ].join('\n')
  const cases = [
    ['java', 'Demo.java', java],
    [
      'vue',
      'Comp.vue',
      '<template>\n  <div class="a">{{ msg }}</div>\n</template>\n<script>\nexport default { data() { return { msg: "hi" } } }\n</script>',
    ],
    ['json', 'data.json', '{\n  "a": 1,\n  "list": [true, null, "x"],\n  "nested": {"k": "v"}\n}'],
    ['js', 'app.js', 'const x = `multi\nline ${y}`;\nfunction run(a) { return a + 1; }'],
    ['kt', 'Main.kt', 'fun send(userId: String, orderId: Long?): Boolean {\n    val name = "x"\n    return true\n}'],
    ['properties', 'app.properties', 'server.port=8080\nspring.name=demo'],
    ['bat', 'run.bat', '@echo off\necho hi'],
    ['xml', 'pom.xml', '<?xml version="1.0"?>\n<root attr="v"><child>text</child></root>'],
  ]
  for (const [hint, file, source] of cases) {
    const fence = mod.renderFenceCodeHtml(source, hint)
    const codeView = mod.highlightByLine(source, mod.langForPath(file)).join('\n')
    check(`fence \`\`\`${hint} output === code view ${file}`, fence === codeView, `${fence.slice(0, 120)} != ${codeView.slice(0, 120)}`)
    check(`fence \`\`\`${hint} text roundtrip`, fence.split('\n').every((html, i) => stripTags(html) === source.split('\n')[i]))
  }

  // multi-line constructs
  const commentFence = mod.renderFenceCodeHtml('/**\n * one\n * two\n */\nclass A {}', 'java').split('\n')
  check('fence multi-line comment rows all coloured', [0, 1, 2, 3].every((i) => commentFence[i].includes('hljs-comment')), commentFence.join(' | '))
  const jsFence = mod.renderFenceCodeHtml('const s = `line1\nline2`;\nconst n = 1;', 'js').split('\n')
  check('fence multi-line string kept in string span', jsFence[0].includes('hljs-string') && jsFence[1].includes('hljs-string'))

  // Java/Kotlin post passes inside a fence
  const jf = mod.renderFenceCodeHtml('JSONObject result = JSONObject.parseObject(body);', 'java')
  check('fence java type post-pass', jf.includes('hljs-type">JSONObject'), jf)
  check('fence java method post-pass', jf.includes('hljs-title function_">parseObject'), jf)
  check('fence java variable post-pass', jf.includes('hljs-variable">result'), jf)
  const kf = mod.renderFenceCodeHtml('fun send(userId: String): Boolean { return true }', 'kt')
  check('fence kotlin type post-pass', kf.includes('hljs-type">String') || kf.includes('hljs-params'), kf)

  // unknown language / mermaid -> escaped plain text, never throws
  const raw = '<script>alert("x") & y</script>\nline2'
  check('unknown language returns escaped text', mod.renderFenceCodeHtml(raw, 'no-such-lang') === escapeHtmlForTest(raw))
  check('mermaid fence returns escaped text (handled before pipeline)', mod.renderFenceCodeHtml('graph TD\nA-->B', 'mermaid') === escapeHtmlForTest('graph TD\nA-->B'))
  check('no raw tags survive unknown language', !mod.renderFenceCodeHtml(raw, 'zzz').includes('<script>'))
  const known = mod.renderFenceCodeHtml(raw, 'js')
  check('known language keeps text roundtrip with < & "', stripTags(known) === raw)

  // one-time md-scoped palette injection (APP_CSS has no post-pass classes)
  browser.headChildren.length = 0
  mod.ensureFenceCss()
  check('fence palette style injected once', browser.headChildren.length === 1 && browser.headChildren[0].id === mod.FENCE_CSS_ID)
  mod.ensureFenceCss()
  check('fence palette injection idempotent', browser.headChildren.length === 1)
  const css = browser.headChildren[0].textContent
  for (const color of ['#569cd6', '#ce9178', '#6a9955', '#b5cea8', '#4ec9b0', '#dcdcaa', '#9cdcfe', '#d16969']) {
    check(`fence palette ${color}`, css.includes(color))
  }
  check('fence palette covers hljs-constant', css.includes('.hljs-constant{color:#b5cea8'))
  check('fence palette covers param types', css.includes('.hljs-params.hljs-type{color:#4ec9b0'))
  check('fence palette scoped to md fences', css.includes('.mdr-md pre code'))

  // synchronous and fine for a single block
  const big = Array.from({ length: 300 }, (_, i) => `public void method${i}(String a${i}) { call${i}(a${i}); }`).join('\n')
  const started = Date.now()
  const bigHtml = mod.renderFenceCodeHtml(big, 'java')
  const elapsed = Date.now() - started
  check('300-line fence block highlighted synchronously', bigHtml.length > 0 && bigHtml.split('\n').length === 300)
  check('300-line fence block fast enough', elapsed < 2000, `${elapsed}ms`)
  console.log(`  · 300-line java fence: ${elapsed}ms`)
}

async function main() {
  testHighlighter()
  await testJumps()
  await testGitTarget()
  await testViewAndModal()
  testStaticWiring()
  testFences()
  testRealFiles()
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) {
    console.log(`FAILURES: ${failures}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('harness crashed:', error)
  process.exitCode = 1
})
