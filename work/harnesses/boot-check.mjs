/**
 * Temporary boot smoke test for the generated plugin client.js: loads the real
 * bundle with a fake `window.__ModuleLoader__`, fake React and browser globals,
 * then runs the factory + apply() so any top-level ReferenceError / TDZ / missing
 * global across the concatenated src-client parts fails loudly here instead of
 * in the user's browser. Not part of the plugin (tmp/).
 *
 * Usage: node tmp/boot-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLIENT = path.join(ROOT, 'plugin', 'client.js')

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
  setItem: (key, value) => store.set(String(key), String(value)),
  removeItem: (key) => store.delete(String(key)),
  clear: () => store.clear(),
}
globalThis.document = {
  body: { appendChild() {}, removeChild() {} },
  head: { appendChild() {}, removeChild() {} },
  createElement() {
    return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} }
  },
  querySelector() {
    return null
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'offline' }) })

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = fakeWindow

const source = fs.readFileSync(CLIENT, 'utf8')
// The generated bundle is a script that calls window.__ModuleLoader__.load({...}).
new Function('window', 'document', source)(fakeWindow, globalThis.document)

if (!captured) throw new Error('client.js did not call __ModuleLoader__.load')
if (typeof captured.factory !== 'function') throw new Error('client.js factory missing')

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

const exported = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require in bundle: ${name}`)
})
if (!exported || typeof exported.apply !== 'function') throw new Error('factory did not return apply()')

const registered = []
exported.inject.forEach((service) => {
  if (service !== 'slots') throw new Error(`unexpected injection: ${service}`)
})
exported.apply({
  slots: {
    inject(name, callback) {
      callback()
    },
    register(target, component) {
      registered.push({ target, component })
    },
  },
})

if (registered.length < 2) throw new Error(`expected at least 2 slot registrations, got ${registered.length}`)
console.log(`boot ok: factory evaluated, apply() registered ${registered.length} slots`)
for (const entry of registered) console.log('  ·', JSON.stringify(entry.target))

/**
 * The self-reload must NEVER fire while the on-disk bundle is newer than the
 * bundle the Harness has REGISTERED: a reload in that window boots the stale
 * bundle URL, the client import fails and the app shows the crash dialog
 * (observed twice on 2026-11-13, every time right after `node plugin/build.mjs`).
 */
const apiSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'api.js'), 'utf8')
const coreSource = fs.readFileSync(path.join(ROOT, 'plugin', 'src-client', '00-core.js'), 'utf8')
const failures = []
const expect = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL ${name}`)
  }
}
console.log('\n[reload guard]')
expect('/api/client-build reports the REGISTERED build', /registered:\s*ACTIVATION_BUILD/.test(apiSource))
expect('the registered build is captured at activation', /const ACTIVATION_BUILD = /.test(apiSource))
expect('the client waits for registered === served', /registeredNow\s*=\s*registered === server/.test(coreSource))
expect('the client requires a second sighting', /reloadSeen\.build !== server/.test(coreSource))
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nreload guard ok')
}
