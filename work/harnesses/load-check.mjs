/**
 * Smoke-load the generated plugin/client.js (not the sources) with a fake
 * module loader + fake React: catches top-level runtime errors in the built
 * artifact and verifies the module contract (id + factory -> inject/apply).
 *
 * Temporary harness (workspace tmp/ is gitignored).
 * Usage: node tmp/load-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '..', 'plugin', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'plugin', 'package.json'), 'utf8'))

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

new Function('window', source)(fakeWindow)

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

console.log(`built client.js (${(source.length / 1024).toFixed(1)} KB chars)`)
check('module loader invoked', !!captured)
check('module id matches package name', captured && captured.id === pkg.name, captured && captured.id)
check('factory is a function', captured && typeof captured.factory === 'function')
let exportsObject = null
try {
  exportsObject = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
} catch (error) {
  console.log(`  FAIL factory threw: ${error && error.stack}`)
  failures += 1
}
check('factory returns inject', !!exportsObject && Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'))
check('factory returns apply', !!exportsObject && typeof exportsObject.apply === 'function')
check('component sources concatenated', source.includes('function HtmlTabView') && source.includes('function ImageView'))
check('html view present in built bundle', source.includes('HTML 渲染预览') && source.includes('/api/html?path='))
check('image view present in built bundle', source.includes('/api/raw?path='))

console.log(failures ? `\n${failures} check(s) failed` : '\nall load checks passed')
if (failures) process.exitCode = 1
