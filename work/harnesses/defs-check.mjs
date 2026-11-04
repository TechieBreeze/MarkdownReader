/**
 * Round-7 Ctrl+click definition harness (22-defs.js single-target flow).
 *
 * Replaces the old candidate-panel assertions: the rewritten 22-defs.js resolves
 * ONE definition per click (v2 /api/def contract) and navigates straight there.
 * Verifies, without a browser:
 *   - hljs-class → kind mapping (method / type / constant / variable / not-a-token);
 *   - caret word extraction and 1-based code-text column (2-char gutter stripped);
 *   - deleted diff rows (`.mdr-git-del`) and line-number-column clicks never jump;
 *   - the v2 request body {path,line,col,name,kind,text,branch,commit};
 *   - one POST /api/def per Ctrl+click, failure → toast, busy guard;
 *   - the old candidate chooser is gone and both code views wire the new flow.
 *
 * Usage: node work/harnesses/defs-check.mjs
 * Exit code: 0 all checks pass, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const CLIENT = path.join(ROOT, 'plugin', 'client.js')

/* ------------------------------------------------------------- fake DOM */

function classListOf(element) {
  const read = () => String(element.className || '').split(/\s+/).filter(Boolean)
  return {
    add(...names) {
      element.className = [...new Set([...read(), ...names])].join(' ')
    },
    remove(...names) {
      element.className = read().filter((name) => !names.includes(name)).join(' ')
    },
    contains(name) {
      return read().includes(name)
    },
  }
}

function createElement(tag, className = '') {
  const element = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    className,
    id: '',
    textContent: '',
    style: {},
    dataset: {},
    childNodes: [],
    parentElement: null,
    listeners: {},
    classList: null,
    appendChild(child) {
      this.childNodes.push(child)
      child.parentElement = this
      return child
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child)
      if (index >= 0) this.childNodes.splice(index, 1)
      child.parentElement = null
    },
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this)
    },
    contains(node) {
      let current = node
      while (current) {
        if (current === this) return true
        current = current.parentElement
      }
      return false
    },
    querySelector(selector) {
      const className = String(selector || '').startsWith('.') ? String(selector).slice(1) : ''
      if (!className) return null
      const search = (node) => {
        for (const child of node.childNodes || []) {
          if (child.nodeType !== 1) continue
          if (child.classList.contains(className)) return child
          const hit = search(child)
          if (hit) return hit
        }
        return null
      }
      return search(this)
    },
    addEventListener(type, handler) {
      const list = this.listeners[type] || (this.listeners[type] = [])
      list.push(handler)
    },
    removeEventListener(type, handler) {
      const list = this.listeners[type]
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    closest(selector) {
      const parts = String(selector || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      const matches = (element) =>
        parts.some((part) =>
          part.startsWith('.') ? element.classList.contains(part.slice(1)) : String(element.tagName).toLowerCase() === part.toLowerCase(),
        )
      let current = this
      while (current) {
        if (matches(current)) return current
        current = current.parentElement
      }
      return null
    },
    getAttribute(name) {
      if (name === 'data-line') return this.dataset.line == null ? '' : String(this.dataset.line)
      return ''
    },
    dispatch(type, event) {
      const ev = Object.assign(
        {
          target: this,
          defaultPrevented: false,
          stopped: false,
          preventDefault() {
            ev.defaultPrevented = true
          },
          stopPropagation() {
            ev.stopped = true
          },
        },
        event || {},
      )
      const list = [...(this.listeners[type] || [])]
      for (const handler of list) handler(ev)
      return ev
    },
  }
  element.classList = classListOf(element)
  return element
}

function textNode(text) {
  return { nodeType: 3, textContent: String(text), parentElement: null }
}

function appendText(parent, text) {
  const node = textNode(text)
  parent.appendChild(node)
  return node
}

/** Build one rendered code row: `.mdr-cl[data-line] > .mdr-cl-code > [2-char gutter][token…]`. */
function buildRow(options) {
  const { line = 1, className = 'mdr-cl', gutter = '  ', tokens = [], root = null } = options
  const row = createElement('div', className)
  row.dataset.line = String(line)
  const code = createElement('span', 'mdr-cl-code')
  row.appendChild(code)
  appendText(code, gutter)
  const built = []
  for (const token of tokens) {
    if (token.spanClass) {
      const span = createElement('span', token.spanClass)
      span.textContent = token.text
      const node = appendText(span, token.text)
      code.appendChild(span)
      built.push({ ...token, span, node })
    } else {
      const node = appendText(code, token.text)
      built.push({ ...token, span: null, node })
    }
  }
  if (root) root.appendChild(row)
  return { row, code, tokens: built }
}

function createDocument() {
  const body = createElement('body')
  const doc = {
    body,
    head: createElement('head'),
    caretPoint: () => null,
    rangePoint: () => null,
    byId: [],
    listeners: {},
    createElement(tag) {
      return createElement(tag)
    },
    getElementById(id) {
      const search = (node) => {
        for (const child of node.childNodes || []) {
          if (child.nodeType !== 1) continue
          if (child.id === id) return child
          const hit = search(child)
          if (hit) return hit
        }
        return null
      }
      return search(body)
    },
    querySelector() {
      return null
    },
    addEventListener(type, handler) {
      const list = doc.listeners[type] || (doc.listeners[type] = [])
      list.push(handler)
    },
    removeEventListener() {},
    caretPositionFromPoint() {
      return doc.caretPoint()
    },
    caretRangeFromPoint() {
      return doc.rangePoint()
    },
    execCommand() {
      return false
    },
    createRange() {
      return { selectNodeContents() {} }
    },
  }
  return doc
}

/* --------------------------------------------------------- environment */

const document_ = createDocument()
globalThis.document = document_
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} }
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })

let fetchCalls = []
let fetchResponder = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init })
  return fetchResponder(String(url), init)
}

function loadModule() {
  const source = (fileNames) =>
    fileNames
      .map((name) => {
        const full = path.join(SRC, name)
        if (!fs.existsSync(full)) throw new Error(`missing client source: ${name}`)
        return `// ---- ${name} ----\n${fs.readFileSync(full, 'utf8')}`
      })
      .join('\n')
  const factory = new Function(
    `const React = null; const h = null;\n${source(['00-core.js', '22-defs.js'])}\nreturn {
  definitionHitAt, definitionRequestBody, requestDefinition, setupDefinitionClick,
  defKindFromClass, canJumpInFile, defWordFromTextNode, defCodeColumn,
  definitionHitAt,
};`,
  )
  return factory()
}

const mod = loadModule()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let failures = 0
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 400)}`}`)
  }
}

function toastText() {
  const node = document_.getElementById('mdr-toast')
  return node ? node.textContent : ''
}

function resetToast() {
  const node = document_.getElementById('mdr-toast')
  if (node && node.parentElement) node.parentElement.removeChild(node)
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

/* ================================================== [1] hljs class -> kind */

{
  console.log('\n[1] defKindFromClass (hljs class → Host kind)')
  check('function_ -> method', mod.defKindFromClass('hljs-title function_', 'a/A.java') === 'method')
  check('hljs-type -> type', mod.defKindFromClass('hljs-type', 'a/A.java') === 'type')
  check('class_ -> type', mod.defKindFromClass('hljs-title class_', 'a/A.vue') === 'type')
  check('hljs-constant (java) -> constant', mod.defKindFromClass('hljs-constant', 'a/A.java') === 'constant')
  check('hljs-constant (web) -> variable', mod.defKindFromClass('hljs-constant', 'a/A.js') === 'variable')
  check('hljs-variable -> variable', mod.defKindFromClass('hljs-variable', 'a/A.java') === 'variable')
  check('web plain class -> variable', mod.defKindFromClass('hljs-property', 'a/A.vue') === 'variable')
  check('web string is not a token', mod.defKindFromClass('hljs-string', 'a/A.js') === '')
  check('java keyword is not a token', mod.defKindFromClass('hljs-keyword', 'a/A.java') === '')
  check('empty class -> not a token', mod.defKindFromClass('', 'a/A.java') === '')
  check('canJumpInFile java/web only', mod.canJumpInFile('a/A.java') && mod.canJumpInFile('a/A.js') && mod.canJumpInFile('a/A.vue') && mod.canJumpInFile('a/A.ts'))
  check('canJumpInFile md false', mod.canJumpInFile('docs/a.md') === false)
}

/* ====================================================== [2] word extraction */

{
  console.log('\n[2] defWordFromTextNode (caret → identifier)')
  const text = 'public void click(Foo bar) {'
  const node = textNode(text)
  const wordAt = (offset) => mod.defWordFromTextNode(node, offset)
  const at = (token) => text.indexOf(token)
  check('first token', (() => {
    const hit = wordAt(2)
    return hit && hit.name === 'public' && hit.start === 0
  })(), wordAt(2))
  check('keyword token', (() => {
    const hit = wordAt(at('void') + 1)
    return hit && hit.name === 'void' && hit.start === at('void')
  })(), wordAt(at('void') + 1))
  check('method name token', (() => {
    const hit = wordAt(at('click') + 2)
    return hit && hit.name === 'click' && hit.start === at('click')
  })(), wordAt(at('click') + 2))
  check('type token', (() => {
    const hit = wordAt(at('Foo') + 1)
    return hit && hit.name === 'Foo' && hit.start === at('Foo')
  })(), wordAt(at('Foo') + 1))
  check('click just after a word still means that word', (() => {
    const hit = wordAt(at('bar') + 3)
    return hit && hit.name === 'bar'
  })(), wordAt(at('bar') + 3))
  check('non-identifier text -> null', mod.defWordFromTextNode(textNode('+ +'), 1) === null)
  check('digit-leading token -> null', mod.defWordFromTextNode(textNode('1.5 + 2'), 1) === null)
  check('null node -> null', mod.defWordFromTextNode(null, 0) === null)
}

/* ===================================================== [3] hit detection */

function caretTo(node, offset) {
  document_.caretPoint = () => (node ? { offsetNode: node, offset } : null)
}

{
  console.log('\n[3] definitionHitAt (click → {name,kind,line,col} or null)')

  // 3a) Java method token with an hljs span + gutter offset.
  const root = createElement('div', 'mdr-cl-body')
  const methodRow = buildRow({
    line: 42,
    root,
    tokens: [{ spanClass: 'hljs-title function_', text: 'getUserId' }],
  })
  const methodToken = methodRow.tokens[0]
  caretTo(methodToken.node, 2)
  let hit = mod.definitionHitAt(root, { target: methodToken.span, clientX: 1, clientY: 1 }, 'gits/user/A.java')
  check('method hit detected', !!hit && hit.name === 'getUserId' && hit.kind === 'method' && hit.line === 42, hit)
  check('column strips the 2-char gutter', !!hit && hit.col === 1, hit && hit.col)
  const prefixed = buildRow({
    line: 43,
    root,
    tokens: [{ text: 'public void ' }, { spanClass: 'hljs-title function_', text: 'getUserId' }],
  })
  caretTo(prefixed.tokens[1].node, 0)
  hit = mod.definitionHitAt(root, { target: prefixed.tokens[1].span }, 'gits/user/A.java')
  check('column accounts for tokens before the hit', !!hit && hit.col === 13, hit && hit.col)

  // 3b) deleted diff row is never jumpable.
  const deletedRow = buildRow({
    line: 7,
    className: 'mdr-cl mdr-git-del',
    root,
    tokens: [{ spanClass: 'hljs-variable', text: 'oldField' }],
  })
  caretTo(deletedRow.tokens[0].node, 1)
  check('deleted diff row -> null', mod.definitionHitAt(root, { target: deletedRow.tokens[0].span }, 'gits/user/A.java') === null)

  // 3c) line-number column click (no .mdr-cl-code) does nothing.
  caretTo(null)
  check('line-number column -> null', mod.definitionHitAt(root, { target: methodRow.row }, 'gits/user/A.java') === null)

  // 3d) web identifier with no hljs span resolves as variable via caret.
  const webRoot = createElement('div', 'mdr-cl-body')
  const webRow = buildRow({ line: 5, root: webRoot, tokens: [{ text: 'todayYmd' }] })
  caretTo(webRow.tokens[0].node, 3)
  hit = mod.definitionHitAt(webRoot, { target: webRow.code, clientX: 1, clientY: 1 }, 'docs/demo/app.js')
  check('web plain identifier -> variable', !!hit && hit.name === 'todayYmd' && hit.kind === 'variable' && hit.line === 5, hit)
  check('web column without a span', !!hit && hit.col === 1, hit && hit.col)

  // 3e) non-jumpable keyword span -> null (no request).
  const keywordRow = buildRow({ line: 9, root, tokens: [{ spanClass: 'hljs-keyword', text: 'return' }] })
  caretTo(keywordRow.tokens[0].node, 1)
  check('keyword span -> null', mod.definitionHitAt(root, { target: keywordRow.tokens[0].span }, 'gits/user/A.java') === null)

  // 3f) caret API unavailable -> hljs span fallback still resolves.
  document_.caretPoint = () => null
  document_.rangePoint = () => null
  hit = mod.definitionHitAt(root, { target: methodToken.span }, 'gits/user/A.java')
  check('span fallback without caret API', !!hit && hit.name === 'getUserId' && hit.kind === 'method' && hit.line === 42, hit)

  // 3g) row outside the view root is ignored.
  const detachedRow = buildRow({ line: 3, tokens: [{ spanClass: 'hljs-variable', text: 'x' }] })
  document_.caretPoint = () => ({ offsetNode: detachedRow.tokens[0].node, offset: 0 })
  check('row outside root -> null', mod.definitionHitAt(root, { target: detachedRow.tokens[0].span }, 'gits/user/A.java') === null)
}

/* =================================================== [4] request body */

{
  console.log('\n[4] definitionRequestBody (v2 contract)')
  const source = { path: 'gits/user/A.java', text: 'LINE1\nLINE2\nLINE3', branch: 'dev', commit: 'abc123' }
  const body = mod.definitionRequestBody(source, { name: 'cookiePO', kind: 'variable', line: 3, col: 7 })
  check('body is non-null', !!body)
  check('body path/line/col/name/kind', !!body && body.path === source.path && body.line === 3 && body.col === 7 && body.name === 'cookiePO' && body.kind === 'variable', body)
  check('body carries rendered text', !!body && body.text === source.text)
  check('body carries branch/commit', !!body && body.branch === 'dev' && body.commit === 'abc123')
  check('defaults kind to variable', (() => {
    const value = mod.definitionRequestBody({ path: 'a/B.java', text: '' }, { name: 'x', line: 1, col: 1 })
    return value && value.kind === 'variable' && value.branch === null && value.commit === null
  })())
  check('missing name -> null', mod.definitionRequestBody(source, { line: 1, col: 1 }) === null)
  check('missing path -> null', mod.definitionRequestBody({ text: 'x' }, { name: 'a', line: 1, col: 1 }) === null)
}

/* ============================================ [5] requestDefinition + toast */

{
  console.log('\n[5] requestDefinition (one Host call, failures toast)')
  resetToast()
  fetchCalls = []
  fetchResponder = async () => jsonResponse({ ok: true, file: 'gits/user/B.java', line: 9, kind: 'type', defName: 'B', impl: null })
  let result = await mod.requestDefinition({ path: 'gits/user/A.java', text: 'A' }, { name: 'B', kind: 'type', line: 1, col: 1 })
  check('success returns payload', !!result && result.file === 'gits/user/B.java' && result.line === 9, result)
  check('one POST to /api/def', fetchCalls.length === 1 && fetchCalls[0].url.includes('/api/def'), fetchCalls.map((call) => call.url))
  const sentBody = JSON.parse(fetchCalls[0].init.body)
  check('POST body is the v2 shape', sentBody.path === 'gits/user/A.java' && sentBody.name === 'B' && sentBody.line === 1 && sentBody.col === 1 && sentBody.text === 'A', sentBody)

  resetToast()
  fetchResponder = async () => jsonResponse({ ok: false, file: null, line: 0, error: '未找到定义' })
  result = await mod.requestDefinition({ path: 'gits/user/A.java', text: 'A' }, { name: 'nope', kind: 'variable', line: 1, col: 1 })
  check('missing target returns null', result === null)
  check('missing target toasts 未找到定义', toastText().includes('未找到定义'), toastText())

  resetToast()
  fetchResponder = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: '外部/框架方法，无本地定义' }) })
  result = await mod.requestDefinition({ path: 'gits/user/A.java', text: 'A' }, { name: 'baseMapper', kind: 'variable', line: 1, col: 1 })
  check('Host error returns null', result === null)
  check('Host error message toasted', toastText().includes('外部/框架方法'), toastText())
}

/* =========================================== [6] setupDefinitionClick */

{
  console.log('\n[6] setupDefinitionClick (Ctrl+click → one v2 request → onJump)')
  resetToast()

  /** A view root + a clickable Java method row. */
  function makeView(rootPath = 'gits/user/A.java') {
    const root = createElement('div', 'mdr-cl-body')
    const built = buildRow({ line: 12, root, tokens: [{ spanClass: 'hljs-title function_', text: 'renewExpirationTime' }] })
    caretTo(built.tokens[0].node, 4)
    return { root, built, source: { path: rootPath, text: 'SRC', branch: '', commit: '', line: 0 } }
  }

  const view = makeView()
  fetchCalls = []
  fetchResponder = async () => jsonResponse({ ok: true, file: 'gits/user/UserCookieMapper.java', line: 12, kind: 'method', defName: 'renewExpirationTime', impl: null })
  const jumps = []
  const dispose = mod.setupDefinitionClick(view.root, () => view.source, (result, source) => jumps.push({ result, source }))
  const event = { ctrlKey: true, metaKey: false, altKey: false, clientX: 10, clientY: 10, preventDefault() { event.defaultPrevented = true }, stopPropagation() { event.stopped = true } }
  event.target = view.built.tokens[0].span
  await view.root.dispatch('click', event)
  await flush()
  check('ctrl+click sends one request', fetchCalls.length === 1, fetchCalls.length)
  check('request carries line/col/name/kind', (() => {
    const body = JSON.parse(fetchCalls[0].init.body)
    return body.line === 12 && body.col === 1 && body.name === 'renewExpirationTime' && body.kind === 'method' && body.path === 'gits/user/A.java'
  })(), JSON.parse(fetchCalls[0].init.body))
  check('onJump called with result', jumps.length === 1 && jumps[0].result.file === 'gits/user/UserCookieMapper.java', jumps)
  check('event preventDefault called', event.defaultPrevented === true && event.stopped === true)

  // Plain click / Alt+click never request.
  fetchCalls = []
  jumps.length = 0
  await view.root.dispatch('click', { target: view.built.tokens[0].span, ctrlKey: false, metaKey: false, altKey: false })
  await flush()
  check('plain click sends nothing', fetchCalls.length === 0 && jumps.length === 0, fetchCalls.length)
  await view.root.dispatch('click', { target: view.built.tokens[0].span, ctrlKey: true, metaKey: false, altKey: true })
  await flush()
  check('alt+ctrl click sends nothing', fetchCalls.length === 0, fetchCalls.length)

  // Deleted diff row never requests.
  const deleted = buildRow({ line: 4, className: 'mdr-cl mdr-git-del', root: view.root, tokens: [{ spanClass: 'hljs-variable', text: 'oldThing' }] })
  caretTo(deleted.tokens[0].node, 1)
  await view.root.dispatch('click', { target: deleted.tokens[0].span, ctrlKey: true, metaKey: false, altKey: false })
  await flush()
  check('deleted row sends nothing', fetchCalls.length === 0, fetchCalls.length)

  // Busy guard: a second Ctrl+click while the first request is in flight is dropped.
  caretTo(view.built.tokens[0].node, 4)
  let release = null
  fetchCalls = []
  jumps.length = 0
  fetchResponder = async () => new Promise((resolve) => {
    release = () => resolve(jsonResponse({ ok: true, file: 'gits/user/C.java', line: 3, kind: 'method', defName: 'c', impl: null }))
  })
  const first = view.root.dispatch('click', { target: view.built.tokens[0].span, ctrlKey: true, metaKey: false, altKey: false })
  await flush()
  await view.root.dispatch('click', { target: view.built.tokens[0].span, ctrlKey: true, metaKey: false, altKey: false })
  await flush()
  check('busy guard drops the second click', fetchCalls.length === 1, fetchCalls.length)
  release()
  await first
  await flush()
  check('busy guard releases for the next click', jumps.length === 1, jumps.length)

  dispose()

  // getSource throwing or returning null never throws out of the handler.
  fetchCalls = []
  const guardView = makeView()
  mod.setupDefinitionClick(guardView.root, () => null, () => { throw new Error('must not be called') })
  let threw = false
  try {
    await guardView.root.dispatch('click', { target: guardView.built.tokens[0].span, ctrlKey: true })
  } catch {
    threw = true
  }
  check('null source does not throw', !threw && fetchCalls.length === 0)
}

/* ================================================= [7] source contract */

{
  console.log('\n[7] source contract (single-target; no candidate chooser)')
  const defsSource = fs.readFileSync(path.join(SRC, '22-defs.js'), 'utf8')
  const codeSource = fs.readFileSync(path.join(SRC, '20-code.js'), 'utf8')
  const modalSource = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
  check('22-defs has no candidate chooser', !/DefinitionChooser/.test(defsSource) && !/candidates/.test(defsSource))
  check('22-defs posts the v2 /api/def body', /postJson\('\/api\/def'/.test(defsSource) && /definitionRequestBody/.test(defsSource))
  check('22-defs guards deleted diff rows', defsSource.includes('.mdr-git-del'))
  check('code tab wires setupDefinitionClick', /setupDefinitionClick\(/.test(codeSource))
  check('code modal wires setupDefinitionClick', /setupDefinitionClick\(/.test(modalSource))
  check('tabs pass text/branch/commit', /text: defText/.test(codeSource) && /branch:/.test(codeSource) && /commit:/.test(codeSource))
  check('click delay is not the old 2.4s timer', !/2400/.test(defsSource + codeSource))
  // The built bundle must be current (the same rule as the other round-7 harness).
  const clientStat = fs.statSync(CLIENT)
  const newest = Math.max(
    ...fs
      .readdirSync(SRC)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.statSync(path.join(SRC, name)).mtimeMs),
  )
  check('plugin/client.js is up to date', clientStat.mtimeMs >= newest, `${new Date(clientStat.mtimeMs).toISOString()} vs ${new Date(newest).toISOString()}`)
  const bundle = fs.readFileSync(CLIENT, 'utf8')
  check('bundle contains single-target def flow', bundle.includes('definitionRequestBody') && bundle.includes('setupDefinitionClick'))
}

/* ============================================================== summary */

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`${failures} defs check(s) failed`)
  process.exitCode = 1
}
