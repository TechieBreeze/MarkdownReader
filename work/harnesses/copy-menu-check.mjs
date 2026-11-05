/**
 * Fake-DOM harness for round 7's path right-click copy menu (00-core.js).
 *
 * Covers, without a browser:
 *   - the shared path context-menu affordance: right-click a path label opens
 *     「复制路径」/「复制文件名」, positioning, Escape / outside-click / inside-click
 *     close behaviour;
 *   - the three-step clipboard ladder: navigator.clipboard -> execCommand ->
 *     "select it and press Ctrl+C" (the http:// origin path);
 *   - the toast status line (`#mdr-toast`): message, ok/err class, reuse and
 *     auto-hide;
 *   - pathOfElement precedence (data-path/data-mdr-path -> title minus `:line`
 *     -> textContent) and the whitespace guard that keeps non-path labels from
 *     opening the menu.
 *
 * Usage: node work/harnesses/copy-menu-check.mjs
 * Exit code: 0 all checks pass, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')
const CORE = path.join(SRC, '00-core.js')
const CLIENT = path.join(ROOT, 'plugin', 'client.js')

/* ------------------------------------------------------------- fake DOM */

function createClassList(element) {
  const read = () => String(element.className || '').split(/\s+/).filter(Boolean)
  const write = (names) => {
    element.className = [...new Set(names)].join(' ')
  }
  return {
    add(...names) {
      write([...read(), ...names])
    },
    remove(...names) {
      write(read().filter((name) => !names.includes(name)))
    },
    contains(name) {
      return read().includes(name)
    },
    toggle(name, force) {
      const has = read().includes(name)
      const on = force === undefined ? !has : !!force
      if (on && !has) write([...read(), name])
      if (!on && has) write(read().filter((item) => item !== name))
      return on
    },
    toString() {
      return read().join(' ')
    },
  }
}

function createElement(tag, doc) {
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    ownerDocument: doc || null,
    id: '',
    className: '',
    textContent: '',
    title: '',
    type: '',
    value: '',
    selected: false,
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[String(name)] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, String(name)) ? this.attrs[String(name)] : null
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.push(child)
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
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
    contains(node) {
      let current = node
      while (current) {
        if (current === this) return true
        current = current.parentNode
      }
      return false
    },
    closest(selector) {
      const classes = String(selector || '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('.'))
        .map((part) => part.slice(1))
      let current = this
      while (current) {
        if (current.classList && classes.some((name) => current.classList.contains(name))) return current
        current = current.parentNode
      }
      return null
    },
    select() {
      this.selected = true
      if (this.ownerDocument) this.ownerDocument.selection = this
    },
    getBoundingClientRect() {
      return { width: 180, height: 90, left: 0, top: 0, right: 180, bottom: 90 }
    },
    dispatch(type, event) {
      const ev = Object.assign({ target: this }, event || {})
      const list = [...(this.listeners[type] || [])]
      for (const handler of list) handler(ev)
      return ev
    },
  }
  element.classList = createClassList(element)
  return element
}

function findById(node, id, out = null) {
  if (out) return out
  if (!node || typeof node !== 'object') return out
  if (node.id === id) return node
  for (const child of node.children || []) {
    const hit = findById(child, id, out)
    if (hit) return hit
  }
  return out
}

function findByClass(node, className, out = null) {
  if (out) return out
  if (!node || typeof node !== 'object') return out
  if (String(node.className || '').split(/\s+/).includes(className)) return node
  for (const child of node.children || []) {
    const hit = findByClass(child, className, out)
    if (hit) return hit
  }
  return out
}

function findByTag(node, tagName, out = null) {
  if (out) return out
  if (!node || typeof node !== 'object') return out
  if (String(node.tagName || '').toUpperCase() === String(tagName).toUpperCase()) return node
  for (const child of node.children || []) {
    const hit = findByTag(child, tagName, out)
    if (hit) return hit
  }
  return out
}

function createDocument() {
  const doc = {
    body: null,
    head: null,
    listeners: {},
    execCommands: [],
    execResult: true,
    selection: null,
    createElement(tag) {
      return createElement(tag, doc)
    },
    getElementById(id) {
      return findById(doc.body, id)
    },
    querySelector(selector) {
      const sel = String(selector || '').trim()
      if (!sel) return null
      if (sel.startsWith('.')) return findByClass(doc.body, sel.slice(1))
      if (sel.startsWith('#')) return findById(doc.body, sel.slice(1))
      return findByTag(doc.body, sel)
    },
    addEventListener(type, handler) {
      const list = doc.listeners[type] || (doc.listeners[type] = [])
      list.push(handler)
    },
    removeEventListener(type, handler) {
      const list = doc.listeners[type]
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    execCommand(command) {
      doc.execCommands.push(command)
      return doc.execResult
    },
    dispatch(type, event) {
      const ev = Object.assign({ preventDefault() { ev.defaultPrevented = true }, stopPropagation() { ev.propagationStopped = true }, defaultPrevented: false, propagationStopped: false }, event || {})
      const list = [...(doc.listeners[type] || [])]
      for (const handler of list) handler(ev)
      return ev
    },
  }
  doc.body = createElement('body', doc)
  doc.head = createElement('head', doc)
  return doc
}

/* --------------------------------------------------------- environment */

let currentDocument = null

function setClipboard(clipboard) {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true })
}

function installEnvironment(doc) {
  currentDocument = doc
  globalThis.document = doc
  globalThis.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
  }
  setClipboard(undefined)
}

function loadCore() {
  const source = fs.readFileSync(CORE, 'utf8')
  const factory = new Function(
    `const React = null; const h = null;\n${source}\nreturn { copyText, copyTextFallback, copyWithFeedback, toast, pathMenuTarget, pathMenuOpen, pathMenuClose, pathOfElement, PATH_MENU_SELECTOR };`,
  )
  return factory()
}

/* ---------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
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

function menuOf(doc) {
  return doc.body.children.find((element) => element.classList.contains('mdr-ctx')) || null
}

function toastOf(doc) {
  return doc.getElementById('mdr-toast')
}

function makePathLabel(doc, className, attrs, text) {
  const label = doc.createElement('span')
  label.className = className
  label.textContent = text || ''
  for (const [key, value] of Object.entries(attrs || {})) label.setAttribute(key, value)
  doc.body.appendChild(label)
  return label
}

async function openMenu(doc, label, x = 100, y = 120) {
  const event = doc.dispatch('contextmenu', { target: label, clientX: x, clientY: y })
  await sleep(5)
  return event
}

function clickMenuItem(doc, label) {
  const menu = menuOf(doc)
  if (!menu) throw new Error('menu not open')
  const button = menu.children.find((element) => element.textContent === label)
  if (!button) throw new Error(`menu item not found: ${label}`)
  button.dispatch('click', { stopPropagation() {} })
  return button
}

/* =========================================== [0] built bundle freshness */

{
  console.log('\n[0] built client.js is current and contains the round-7 menu')
  const stat = fs.existsSync(CLIENT) ? fs.statSync(CLIENT) : null
  check('plugin/client.js exists', !!stat)
  const srcNames = fs.readdirSync(SRC).filter((name) => name.endsWith('.js'))
  const newestSource = Math.max(...srcNames.map((name) => fs.statSync(path.join(SRC, name)).mtimeMs))
  check(
    'client.js is newer than every src-client source (run node plugin/build.mjs)',
    !!stat && stat.mtimeMs >= newestSource,
    stat ? `client=${new Date(stat.mtimeMs).toISOString()} newestSrc=${new Date(newestSource).toISOString()}` : 'missing',
  )
  const bundle = stat ? fs.readFileSync(CLIENT, 'utf8') : ''
  for (const marker of ['复制路径', '复制文件名', 'pathMenuOpen', 'copyTextFallback', 'copyWithFeedback', 'mdr-ctx']) {
    check(`bundle contains ${marker}`, bundle.includes(marker))
  }
}

/* ======================================================== [1] selector list */

{
  console.log('\n[1] path selector coverage (all round-7 affordance targets)')
  const doc = createDocument()
  installEnvironment(doc)
  const mod = loadCore()
  const selector = String(mod.PATH_MENU_SELECTOR || '')
  const expected = [
    '.mdr-code-path',
    '.mdr-cmodal-path',
    '.mdr-html-path',
    '.mdr-image-name',
    '.mdr-search-path',
    '.mdr-tr',
    '.mdr-tab',
  ]
  for (const cls of expected) check(`selector includes ${cls}`, selector.includes(cls), selector)
}

/* ============================================================ [2] open menu */

let doc
let mod
{
  console.log('\n[2] contextmenu opens 复制路径 / 复制文件名')
  doc = createDocument()
  installEnvironment(doc)
  mod = loadCore()
  const label = makePathLabel(doc, 'mdr-code-path', { title: 'docs/需求/登录Token滑动续期特性设计说明书.md' }, 'docs/需求/登录Token滑动续期特性设计说明书.md')
  const event = await openMenu(doc, label)
  check('contextmenu preventDefault called', event.defaultPrevented === true)
  const menu = menuOf(doc)
  check('menu rendered in body', !!menu)
  check('menu role=menu', !!menu && menu.getAttribute('role') === 'menu', menu && menu.getAttribute('role'))
  check('menu has two items', !!menu && menu.children.length === 2, menu && menu.children.length)
  const [copyPath, copyName] = menu ? menu.children : []
  check('item labels', copyPath.textContent === '复制路径' && copyName.textContent === '复制文件名', [copyPath && copyPath.textContent, copyName && copyName.textContent])
  check('item titles carry path / filename', copyPath.title === 'docs/需求/登录Token滑动续期特性设计说明书.md' && copyName.title === '登录Token滑动续期特性设计说明书.md', [copyPath.title, copyName.title])
  check('items are buttons', copyPath.tagName === 'BUTTON' && copyName.tagName === 'BUTTON')
  check('menu positioned at click', menu.style.left === '100px' && menu.style.top === '120px', [menu.style.left, menu.style.top])
}

/* ======================================================= [3] copy actions */

{
  console.log('\n[3] 复制路径 / 复制文件名 writes clipboard, confirms INSIDE the menu (no toast)')
  const writes = []
  setClipboard({
    writeText(text) {
      writes.push(text)
      return Promise.resolve()
    },
  })
  const label = makePathLabel(doc, 'mdr-code-path', { title: 'gits/user/src/main/java/com/pvh/user/model/po/UserCookiePO.java' }, 'UserCookiePO.java')
  await openMenu(doc, label)
  clickMenuItem(doc, '复制路径')
  await flush()
  check('复制路径 writes the path', writes[0] === 'gits/user/src/main/java/com/pvh/user/model/po/UserCookiePO.java', writes)
  const menuAfterCopy = menuOf(doc)
  check('复制路径 keeps the menu open for the confirmation', !!menuAfterCopy)
  check(
    '复制路径 confirms in the menu item',
    !!menuAfterCopy && menuAfterCopy.children[0].textContent === '复制路径 ✓' && menuAfterCopy.children[0].classList.contains('mdr-ctx-ok'),
    menuAfterCopy && menuAfterCopy.children[0].textContent,
  )
  check('复制路径 shows NO toast (no overlay on the Harness window)', !toastOf(doc), toastOf(doc) && toastOf(doc).textContent)
  await sleep(1000)
  check('menu closes after the confirmation', !menuOf(doc))

  await openMenu(doc, label)
  clickMenuItem(doc, '复制文件名')
  await flush()
  check('复制文件名 writes the basename', writes[1] === 'UserCookiePO.java', writes)
  check(
    '复制文件名 confirms in the menu item',
    menuOf(doc) && menuOf(doc).children[1].textContent === '复制文件名 ✓',
    menuOf(doc) && menuOf(doc).children[1].textContent,
  )
  check('复制文件名 shows NO toast', !toastOf(doc))
  await sleep(1000)
}

/* ============================================= [4] pathOfElement precedence */

{
  console.log('\n[4] pathOfElement: data-path > title(:line) > text; whitespace rejected')
  check('data-mdr-path wins over title', mod.pathOfElement(makePathLabel(doc, 'mdr-tr', { 'data-mdr-path': 'src/Main.java', title: 'ignored/title.txt' }, 'ignored')) === 'src/Main.java')
  check('data-path wins over title', mod.pathOfElement(makePathLabel(doc, 'mdr-tr', { 'data-path': 'src/Other.java', title: 'x' }, 'x')) === 'src/Other.java')
  check('title trailing :line stripped', mod.pathOfElement(makePathLabel(doc, 'mdr-code-path', { title: 'src/Demo.java:42' }, 'Demo.java')) === 'src/Demo.java')
  check('title multiline keeps first line', mod.pathOfElement(makePathLabel(doc, 'mdr-code-path', { title: 'src/Demo.java\nsome hint' }, 'Demo.java')) === 'src/Demo.java')
  check('textContent fallback', mod.pathOfElement(makePathLabel(doc, 'mdr-code-path', {}, 'docs/a.md')) === 'docs/a.md')

  const spaced = makePathLabel(doc, 'mdr-code-path', { title: 'docs/需求 说明.md' }, 'docs/需求 说明.md')
  const noMenuBefore = menuOf(doc)
  const spacedEvent = doc.dispatch('contextmenu', { target: spaced, clientX: 50, clientY: 60 })
  check('whitespace path ignored (no preventDefault)', spacedEvent.defaultPrevented === false)
  check('whitespace path opens no menu', menuOf(doc) === noMenuBefore)

  const nonTarget = doc.createElement('span')
  nonTarget.className = 'mdr-brand'
  nonTarget.textContent = 'Markdown Reader'
  doc.body.appendChild(nonTarget)
  const brandEvent = doc.dispatch('contextmenu', { target: nonTarget, clientX: 50, clientY: 60 })
  check('non-path target ignored', brandEvent.defaultPrevented === false && !menuOf(doc))
}

/* ==================================== [4b] tree row / tab strip targets */

{
  console.log('\n[4b] tree row (.mdr-tr) and tab (.mdr-tab) open the same two-item menu')
  const writes = []
  setClipboard({ writeText: (text) => { writes.push(text); return Promise.resolve() } })

  const treeRow = makePathLabel(doc, 'mdr-tr', { 'data-mdr-path': 'docs/梳理/00-业务全景导读.md' }, '00-业务全景导读.md')
  await openMenu(doc, treeRow)
  const treeMenu = menuOf(doc)
  check('tree row opens 2-item menu', !!treeMenu && treeMenu.children.length === 2, treeMenu && treeMenu.children.length)
  check(
    'tree row menu labels',
    !!treeMenu && treeMenu.children[0].textContent === '复制路径' && treeMenu.children[1].textContent === '复制文件名',
    treeMenu && treeMenu.children.map((item) => item.textContent),
  )
  clickMenuItem(doc, '复制路径')
  await flush()
  check('tree row copies full path', writes[0] === 'docs/梳理/00-业务全景导读.md', writes)

  const tab = makePathLabel(doc, 'mdr-tab', { 'data-mdr-path': 'gits/user/src/main/java/com/pvh/user/model/po/UserCookiePO.java' }, 'UserCookiePO.java')
  await openMenu(doc, tab)
  const tabMenu = menuOf(doc)
  check('tab opens 2-item menu', !!tabMenu && tabMenu.children.length === 2, tabMenu && tabMenu.children.length)
  const tabName = tabMenu.children.find((item) => item.textContent === '复制文件名')
  check('tab menu exposes 复制文件名', !!tabName)
  clickMenuItem(doc, '复制文件名')
  await flush()
  check('tab copies filename', writes[1] === 'UserCookiePO.java', writes)
}

/* ======================================================== [5] close behaviour */

{
  console.log('\n[5] menu close: Escape / outside mousedown / inside mousedown')
  const label = makePathLabel(doc, 'mdr-code-path', { title: 'docs/a.md' }, 'docs/a.md')

  await openMenu(doc, label)
  const escapeEvent = doc.dispatch('keydown', { key: 'Escape' })
  check('Escape closes menu', !menuOf(doc))
  check('Escape preventDefault called', escapeEvent.defaultPrevented === true)

  await openMenu(doc, label)
  doc.dispatch('mousedown', { target: doc.body })
  check('outside mousedown closes menu', !menuOf(doc))

  await openMenu(doc, label)
  const menu = menuOf(doc)
  doc.dispatch('mousedown', { target: menu.children[0] })
  check('inside mousedown keeps menu', !!menuOf(doc))

  // Opening a second menu replaces the first (never two stacked menus).
  await openMenu(doc, label, 300, 300)
  check('reopen keeps a single menu', doc.body.children.filter((element) => element.classList.contains('mdr-ctx')).length === 1)

  // Clamp: clicking near the right/bottom edge keeps the menu on screen.
  await openMenu(doc, label, 1270, 790)
  const clamped = menuOf(doc)
  check('menu clamped horizontally', clamped.style.left === '1092px', clamped.style.left)
  check('menu clamped vertically', clamped.style.top === '702px', clamped.style.top)
}

/* ==================================================== [6] clipboard ladder */

{
  console.log('\n[6] clipboard ladder: clipboard -> execCommand -> manual prompt')
  const writes = []
  setClipboard({ writeText: (text) => { writes.push(text); return Promise.resolve() } })
  check('clipboard success returns true', (await mod.copyText('hello')) === true)
  check('clipboard success writes text', writes[0] === 'hello', writes)
  check('clipboard success skips execCommand', doc.execCommands.length === 0, doc.execCommands)

  setClipboard({ writeText: () => Promise.reject(new Error('denied')) })
  doc.execCommands = []
  doc.execResult = true
  const beforeFallbackChildren = doc.body.children.length
  check('clipboard reject falls back to execCommand', (await mod.copyText('fallback')) === true)
  check('fallback uses execCommand copy', doc.execCommands.includes('copy'), doc.execCommands)
  check('fallback textarea removed from body', doc.body.children.length === beforeFallbackChildren, doc.body.children.length)

  setClipboard(undefined)
  doc.execCommands = []
  doc.execResult = false
  check('no clipboard + execCommand false -> false', (await mod.copyText('manual')) === false)
  check('copyWithFeedback reports err', (await mod.copyWithFeedback('manual')) === 'err')
  check('copyWithFeedback shows no toast', !toastOf(doc))

  setClipboard(undefined)
  doc.execCommands = []
  doc.execResult = true
  check('copyWithFeedback reports ok', (await mod.copyWithFeedback('manual-ok')) === 'ok')
  check('copyWithFeedback still shows no toast', !toastOf(doc))

  check('copyWithFeedback reports empty for an empty value', (await mod.copyWithFeedback('')) === 'empty')
  check('copyText empty resolves false', (await mod.copyText('')) === false)
}

/* ============================================================== [7] toast */

{
  console.log('\n[7] toast: anchored inside the panel, singleton, auto-hide')
  // The panel root is the toast host, so the status line never lands on the
  // bottom layer of the Harness window.
  const panel = doc.createElement('div')
  panel.className = 'mdr-root'
  doc.body.appendChild(panel)
  mod.toast('第一条', 'ok')
  await flush()
  const first = toastOf(doc)
  check('toast is mounted inside the panel root', !!first && first.parentNode === panel, first && first.parentNode && first.parentNode.className)
  mod.toast('第二条', 'err')
  await flush()
  const second = toastOf(doc)
  check('toast node reused', first === second)
  check('toast shows latest message', second.textContent === '第二条', second.textContent)
  check('toast err class', second.classList.contains('err') && second.classList.contains('show'), second.className)
  await sleep(2750)
  check('toast auto-hides after 2.6s', !toastOf(doc).classList.contains('show'), toastOf(doc).className)
  panel.remove()
}

/* ============================================================ [8] summary */

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`${failures} copy-menu check(s) failed`)
  process.exitCode = 1
}
