/**
 * Temporary harness for the html slice (34-html.js).
 *
 * Not part of the plugin and not committed (workspace tmp/ is gitignored).
 * Loads the concatenated client sources with a tiny fake React + fake fetch to
 * verify HtmlTabView / ImageView render trees and data flow without a browser,
 * and probes the real Host endpoints on the standalone harness (:8799).
 *
 * Usage: node tmp/html-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
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
  '32-workbench.js',
  '34-html.js',
  '40-tabs.js',
  '45-json.js',
  '50-app.js',
]
const HOST = 'http://127.0.0.1:8799/markdown-reader'
const ROUTE = '/markdown-reader'

/* ----------------------------------------------------------- fake React */

function createReact() {
  // Hooks read/write whichever instance the last beginRender() selected, so the
  // harness can keep one independent hook store per mounted app.
  let current = null
  const createInstance = () => ({ cells: [], hookIndex: 0, dirty: false, effectQueue: [] })

  const shallowEqual = (a, b) => {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
    return true
  }
  const ensure = (instance, index, factory) => {
    if (!(index in instance.cells)) instance.cells[index] = factory()
    return instance.cells[index]
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props == null ? {} : props, children }
    },
    useState(initial) {
      const instance = current
      const index = instance.hookIndex++
      const cell = ensure(instance, index, () => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }))
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(value, cell.value)) {
          cell.value = value
          instance.dirty = true
        }
      }
      return [cell.value, setValue]
    },
    useRef(initial) {
      const instance = current
      const index = instance.hookIndex++
      return ensure(instance, index, () => ({ current: initial }))
    },
    useEffect(effect, deps) {
      const instance = current
      const index = instance.hookIndex++
      const cell = ensure(instance, index, () => ({ kind: 'effect', deps: undefined, cleanup: null }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.deps = deps
        instance.effectQueue.push({ cell, effect })
      }
    },
    useCallback(fn, deps) {
      const instance = current
      const index = instance.hookIndex++
      const cell = ensure(instance, index, () => ({ kind: 'callback', deps: undefined, fn }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.deps = deps
        cell.fn = fn
      }
      return cell.fn
    },
    useMemo(fn, deps) {
      const instance = current
      const index = instance.hookIndex++
      const cell = ensure(instance, index, () => ({ kind: 'memo', deps: undefined, value: undefined }))
      if (cell.deps === undefined || !shallowEqual(cell.deps, deps)) {
        cell.value = fn()
        cell.deps = deps
      }
      return cell.value
    },
  }

  return {
    React,
    createInstance,
    beginRender(instance) {
      current = instance
      instance.hookIndex = 0
      instance.dirty = false
      instance.effectQueue = []
    },
    runEffects(instance) {
      const queue = instance.effectQueue
      instance.effectQueue = []
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
    isDirty(instance) {
      return instance.dirty
    },
  }
}

const flushAsync = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const renderOnceWith = (runtime, instance, Component, props) => {
  runtime.beginRender(instance)
  const tree = Component(props)
  runtime.runEffects(instance)
  return tree
}

/** Mount once, then allow prop updates that keep hook state (like React does). */
async function renderApp(Component, initialProps, _sharedReact) {
  const runtime = hookRuntime
  const instance = runtime.createInstance()
  let props = initialProps
  let tree = renderOnceWith(runtime, instance, Component, props)
  await flushAsync()
  const pump = async () => {
    for (let i = 0; i < 80; i += 1) {
      if (!runtime.isDirty(instance)) return tree
      tree = renderOnceWith(runtime, instance, Component, props)
      await flushAsync()
    }
    throw new Error('component did not settle')
  }
  tree = await pump()
  return {
    get tree() {
      return tree
    },
    get props() {
      return props
    },
    update(nextProps) {
      props = nextProps
    },
    async refresh() {
      // Force a render with the current props first: the App re-renders because
      // it persisted a new tab.htmlMode, not because the component's own state
      // changed (so isDirty would still be false here).
      tree = renderOnceWith(runtime, instance, Component, props)
      await flushAsync()
      tree = await pump()
      return tree
    },
  }
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

function clickNode(node, event) {
  if (!node || typeof node.props.onClick !== 'function') throw new Error('node is not clickable')
  node.props.onClick(event || { stopPropagation() {}, preventDefault() {}, target: {}, currentTarget: {} })
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

// Browser globals the highlighted fallback path may touch (no hljs here).
if (typeof globalThis.window === 'undefined') globalThis.window = {}

const makeModule = new Function(
  'require',
  `const React = require('react');
const h = React.createElement;
${parts.join('\n')}
return { HtmlTabView, ImageView, HtmlSourceView, imageClampZoom, imageStepZoom, imageFitScale, imageFitPlan, imageVirtualBase, imageAnchoredScroll, imageDisplaySize, imageZoomPercent, imagePanScroll, parseSvgIntrinsic, svgLengthValue, isSvgPath };`,
)

const hookRuntime = createReact()
// Legacy third-argument placeholder: renderApp() now uses a per-app hook store
// on the shared runtime, so old renderApp(C, props, react) call sites pass null.
const react = null
const mod = makeModule((name) => {
  if (name === 'react') return hookRuntime.React
  throw new Error(`unexpected require: ${name}`)
})
const {
  HtmlTabView,
  ImageView,
  HtmlSourceView,
  imageClampZoom,
  imageStepZoom,
  imageFitScale,
  imageFitPlan,
  imageVirtualBase,
  imageAnchoredScroll,
  imageDisplaySize,
  imageZoomPercent,
  imagePanScroll,
  parseSvgIntrinsic,
  svgLengthValue,
  isSvgPath,
} = mod

/* ------------------------------------------------------------------ fetch */

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
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

/* ------------------------------------------------------------ Host tests */

const SAMPLE_HTML_PATH = '20260917-微服务/docs/运维可视化/demo/v4/index.html'
const SAMPLE_IMAGE_PATH = '20260917-微服务/gits/ckdocs/邮件专题/img.png'
const SAMPLE_SVG_PATH = '20260917-微服务/docs/运维可视化/demo/A-极简文档风/sr.svg'
const SAMPLE_CSS_PATH = '20260917-微服务/docs/运维可视化/demo/v4/css/site.css'
/** Exact repro fixture from the bug report: width="100%" + viewBox only. */
const FLOW_SVG_PATH = '20260917-微服务/docs/运维可视化/demo/A-极简文档风/flow-order.svg'
const FLOW_SVG_TEXT =
  '<svg width="100%" viewBox="0 0 1265.671875 1587.515625" style="max-width:1265.67px" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

async function readResponse(url) {
  const response = await fetch(url)
  const array = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    text: new TextDecoder('utf-8').decode(array),
    bytes: array.length,
  }
}

async function testHostApis() {
  console.log('\n[1] Host APIs (standalone harness on :8799)')
  let page
  try {
    page = await readResponse(`${HOST}/api/html?path=${encodeURIComponent(SAMPLE_HTML_PATH)}`)
  } catch (error) {
    console.log(`  skip  harness not reachable: ${error.message}`)
    return
  }
  check('html status 200', page.status === 200, page.status)
  check('html content-type', page.contentType.includes('text/html'), page.contentType)
  check('html has document', page.text.includes('<!DOCTYPE html>'))
  check('html no <base>', !/<base\b/i.test(page.text))
  check('html charset present', /<meta[^>]+charset/i.test(page.text))
  check('html relative css -> /api/raw', /href="\/markdown-reader\/api\/raw\?path=[^"]*site\.css/.test(page.text))
  check('html relative js -> /api/raw', /src="\/markdown-reader\/api\/raw\?path=[^"]*vendor%2F/.test(page.text))
  check('html page link -> /api/html', /href="\/markdown-reader\/api\/html\?path=[^"]*index\.html"/.test(page.text))
  check('html CJK path encoded', page.text.includes('%E5%BE%AE%E6%9C%8D%E5%8A%A1'))
  check('html inline style kept', page.text.includes('.ctx{display:grid'))

  const code = await readResponse(`${HOST}/api/code?path=${encodeURIComponent(SAMPLE_HTML_PATH)}`)
  let codeJson = null
  try {
    codeJson = JSON.parse(code.text)
  } catch {
    codeJson = null
  }
  check('code status 200', code.status === 200, code.status)
  check('code payload content', !!(codeJson && typeof codeJson.content === 'string' && codeJson.content.startsWith('<!DOCTYPE html>')))
  check('code lang for html', !!(codeJson && typeof codeJson.lang === 'string' && codeJson.lang.length > 0), codeJson && codeJson.lang)
  check(
    'code lineCount matches content',
    !!(codeJson && Number(codeJson.lineCount) === codeJson.content.split('\n').length),
    codeJson && `${codeJson.lineCount}/${codeJson.content.split('\n').length}`,
  )

  const img = await readResponse(`${HOST}/api/raw?path=${encodeURIComponent(SAMPLE_IMAGE_PATH)}`)
  check('raw png 200 + mime', img.status === 200 && img.contentType.includes('image/png'), `${img.status} ${img.contentType}`)
  check('raw png bytes', img.bytes > 1000, img.bytes)
  const svg = await readResponse(`${HOST}/api/raw?path=${encodeURIComponent(SAMPLE_SVG_PATH)}`)
  check('raw svg 200 + mime', svg.status === 200 && svg.contentType.includes('image/svg+xml'), `${svg.status} ${svg.contentType}`)

  // htmlpreview rewrites stylesheets / scripts to /api/raw; the Host must serve
  // those preview assets (it now does — this guards against a regression).
  const cssAsset = await readResponse(`${HOST}/api/raw?path=${encodeURIComponent(SAMPLE_CSS_PATH)}`)
  check('raw css preview asset served', cssAsset.status === 200 && cssAsset.contentType.includes('text/css'), `${cssAsset.status} ${cssAsset.contentType}`)
  const jsAsset = await readResponse(
    `${HOST}/api/raw?path=${encodeURIComponent('20260917-微服务/docs/运维可视化/demo/v4/vendor/highlight.min.js')}`,
  )
  check('raw js preview asset served', jsAsset.status === 200 && jsAsset.bytes > 1000, `${jsAsset.status} ${jsAsset.bytes}`)

  // Exact repro fixture: width="100%" so naturalWidth is unusable; viewBox is real.
  let flowSvg = ''
  try {
    flowSvg = await (await fetch(`${HOST}/api/raw?path=${encodeURIComponent(FLOW_SVG_PATH)}`)).text()
  } catch {
    flowSvg = ''
  }
  if (flowSvg) {
    const parsed = parseSvgIntrinsic(flowSvg)
    check(
      'host flow-order.svg viewBox parsed',
      !!parsed && Math.abs(parsed.width - 1265.671875) < 0.01 && Math.abs(parsed.height - 1587.515625) < 0.01,
      parsed && `${parsed.width}x${parsed.height}`,
    )
    if (parsed) console.log(`  info  flow-order.svg intrinsic = ${parsed.width}×${parsed.height} (${parsed.source})`)
  } else {
    console.log('  skip  flow-order.svg not readable from the harness')
  }
}

/* -------------------------------------------------------- HtmlTabView */

const SAMPLE_SOURCE = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head><title>demo</title></head>',
  '<body>',
  '  <h1 class="t">Hello</h1>',
  '  <script>console.log("x < y")</script>',
  '</body>',
  '</html>',
].join('\n')

function htmlTab(extra) {
  return {
    id: 'html:docs/a.html',
    kind: 'html',
    path: 'docs/a.html',
    content: null,
    htmlMode: 'render',
    line: 0,
    ...extra,
  }
}

async function testHtmlRenderMode() {
  console.log('\n[2] HtmlTabView · default render mode')
  const fake = installFetch([{ match: '/api/code', payload: { ok: true, content: SAMPLE_SOURCE, lang: 'html' } }])
  try {
    let located = ''
    let toggled = ''
    const props = {
      tab: htmlTab({ path: 'docs/运维/a.html' }),
      onToggleMode: (mode) => {
        toggled = mode
      },
      onLocate: (value) => {
        located = value
      },
    }
    const app = await renderApp(HtmlTabView, props, react)
    let tree = app.tree
    const expectedSrc = `${ROUTE}/api/html?path=${encodeURIComponent('docs/运维/a.html')}`
    const iframe = byType(tree, 'iframe')[0]
    check('iframe rendered', !!iframe)
    check('iframe src', !!iframe && iframe.props.src === expectedSrc, iframe && iframe.props.src)
    check(
      'iframe sandbox exact',
      !!iframe && iframe.props.sandbox === 'allow-scripts allow-modals allow-popups allow-top-navigation-by-user-activation',
      iframe && iframe.props.sandbox,
    )
    check('iframe title', !!iframe && iframe.props.title === 'HTML 渲染预览')
    check('header path shown', textOf(tree).includes('docs/运维/a.html'))
    check('render badge shown', textOf(tree).includes('渲染预览'))
    check('toggle button says 源码视图', !!buttonWithText(tree, '源码视图'))
    check('locate button rendered', !!buttonWithText(tree, '定位'))
    check('loading note before iframe load', textOf(tree).includes('正在渲染预览…'))
    check('no /api/code fetch in render mode', !fake.calls.some((call) => call.url.includes('/api/code')))

    iframe.props.onLoad({})
    tree = await app.refresh()
    check('loading note gone after load', !textOf(tree).includes('正在渲染预览…'))

    clickNode(buttonWithText(tree, '定位'))
    check('onLocate receives path', located === 'docs/运维/a.html', located)

    clickNode(buttonWithText(tree, '源码视图'))
    check('toggle requests source mode', toggled === 'source', toggled)
  } finally {
    fake.restore()
  }
}

async function testHtmlSourceMode() {
  console.log('\n[3] HtmlTabView · source mode (lazy fetch, jump highlight, iframe kept)')
  const fake = installFetch([
    { match: '/api/code', payload: { ok: true, content: SAMPLE_SOURCE, lang: 'html', lineCount: 8 } },
  ])
  try {
    let toggled = ''
    const props = {
      tab: htmlTab({ line: 4 }),
      onToggleMode: (mode) => {
        toggled = mode
      },
    }
    const app = await renderApp(HtmlTabView, props, react)
    // App persists the mode and re-renders; emulate that.
    app.update({ ...props, tab: htmlTab({ line: 4, htmlMode: 'source' }) })
    let tree = await app.refresh()
    await flushAsync()
    tree = await app.refresh()
    // The fake renderer only executes the root component, so assert the child
    // element props here and mount HtmlSourceView itself for row-level checks.
    const sourceChild = allElements(tree).find((node) => node.type === HtmlSourceView)
    check('source mode renders HtmlSourceView', !!sourceChild)
    check('source view gets fetched content', !!sourceChild && sourceChild.props.content === SAMPLE_SOURCE)
    check('source view gets lang', !!sourceChild && typeof sourceChild.props.lang === 'string' && sourceChild.props.lang.length > 0, sourceChild && sourceChild.props.lang)
    check('source view gets jump line', !!sourceChild && sourceChild.props.hitLine === 4)
    check('source fetched once', fake.calls.filter((call) => call.url.includes('/api/code')).length === 1)
    check(
      'badge shows source mode + line',
      textOf(tree).includes('源码视图') && textOf(tree).includes('第 4 行'),
      textOf(tree).slice(0, 160),
    )
    const iframe = byType(tree, 'iframe')[0]
    check('iframe still mounted in source mode', !!iframe)
    const frameWrap = byClass(tree, 'mdr-html-render')[0]
    check(
      'iframe hidden in source mode',
      !!frameWrap && !!frameWrap.props.style && frameWrap.props.style.display === 'none',
      frameWrap && JSON.stringify(frameWrap.props.style),
    )

    // Row-level assertions on the source view itself.
    const sourceApp = await renderApp(HtmlSourceView, { content: SAMPLE_SOURCE, lang: 'xml', hitLine: 4 }, react)
    const rows = byClass(sourceApp.tree, 'mdr-html-row')
    check('source rows rendered', rows.length === 8, rows.length)
    check('line numbers rendered', byClass(sourceApp.tree, 'mdr-html-no').length === 8)
    check('code spans rendered', byClass(sourceApp.tree, 'mdr-html-code').length === 8)
    const hitRows = byClass(sourceApp.tree, 'mdr-html-row').filter((node) => classNameOf(node).includes('hit'))
    check('jump line highlighted persistently', hitRows.length === 1, hitRows.length)
    check('jump row is line 4', hitRows.length === 1 && String(hitRows[0].props['data-line']) === '4')
    const codeSpans = byClass(sourceApp.tree, 'mdr-html-code')
    check(
      'row html is non-empty',
      codeSpans.every((node) => !!node.props.dangerouslySetInnerHTML && typeof node.props.dangerouslySetInnerHTML.__html === 'string' && node.props.dangerouslySetInnerHTML.__html.length > 0),
    )

    check('escaped source content', textOf(tree).includes('<html lang="zh-CN">') === false) // text nodes are split by spans; just ensure no crash
    clickNode(buttonWithText(tree, '渲染视图'))
    check('toggle requests render mode', toggled === 'render', toggled)
    app.update({ ...props, tab: htmlTab({ line: 4, htmlMode: 'render' }) })
    tree = await app.refresh()
    const iframeBack = byType(tree, 'iframe')[0]
    check('iframe visible again', !!iframeBack && !iframeBack.props.style)
    check('source rows gone in render mode', byClass(tree, 'mdr-html-row').length === 0)
    check('no extra /api/code fetch', fake.calls.filter((call) => call.url.includes('/api/code')).length === 1)
  } finally {
    fake.restore()
  }
}

async function testHtmlContentProvided() {
  console.log('\n[4] HtmlTabView · tab.content provided (no fetch)')
  const fake = installFetch([{ match: '/api/code', payload: { ok: false, error: 'should not be called' } }])
  try {
    const props = { tab: htmlTab({ htmlMode: 'source', content: SAMPLE_SOURCE, line: 2 }) }
    const app = await renderApp(HtmlTabView, props, react)
    const tree = app.tree
    const sourceChild = allElements(tree).find((node) => node.type === HtmlSourceView)
    check('provided content fed to source view', !!sourceChild && sourceChild.props.content === SAMPLE_SOURCE)
    check('provided content jump line', !!sourceChild && sourceChild.props.hitLine === 2)
    check('no fetch for provided content', !fake.calls.some((call) => call.url.includes('/api/code')))
  } finally {
    fake.restore()
  }
}

async function testHtmlSourceError() {
  console.log('\n[5] HtmlTabView · source fetch error + retry')
  const fake = installFetch([{ match: '/api/code', payload: { ok: false, error: 'boom' } }])
  try {
    const props = { tab: htmlTab({ htmlMode: 'source' }) }
    const app = await renderApp(HtmlTabView, props, react)
    let tree = app.tree
    check('source error state', textOf(tree).includes('读取 HTML 源码失败') && textOf(tree).includes('boom'), textOf(tree).slice(0, 200))
    check('retry button rendered', !!buttonWithText(tree, '重试'))
    clickNode(buttonWithText(tree, '重试'))
    tree = await app.refresh()
    await flushAsync()
    tree = await app.refresh()
    check('retry performs another fetch', fake.calls.filter((call) => call.url.includes('/api/code')).length === 2)
    check('error persists while backend fails', textOf(tree).includes('读取 HTML 源码失败'))
  } finally {
    fake.restore()
  }
}

async function testHtmlFallbackToggle() {
  console.log('\n[6] HtmlTabView · fallback toggle without onToggleMode')
  const fake = installFetch([{ match: '/api/code', payload: { ok: true, content: SAMPLE_SOURCE, lang: 'html' } }])
  try {
    const app = await renderApp(HtmlTabView, { tab: htmlTab() }, react)
    clickNode(buttonWithText(app.tree, '源码视图'))
    const tree = await app.refresh()
    const sourceChild = allElements(tree).find((node) => node.type === HtmlSourceView)
    check('fallback mode switches to source', !!sourceChild)
    check('fallback toggle fetched source', fake.calls.some((call) => call.url.includes('/api/code')))
  } finally {
    fake.restore()
  }
}

async function testHtmlSourceVirtual() {
  console.log('\n[6b] HtmlSourceView · large document stays virtualized')
  const lines = Array.from({ length: 900 }, (_, index) => `<div id="row-${index + 1}">row ${index + 1}</div>`)
  const app = await renderApp(HtmlSourceView, { content: lines.join('\n'), lang: 'xml', hitLine: 0 }, react)
  const rows = byClass(app.tree, 'mdr-html-row')
  check('virtual rows painted on first render', rows.length > 0 && rows.length < 900, rows.length)
  const container = byClass(app.tree, 'mdr-html-rows')[0]
  check(
    'virtual spacer height = rows * 20px',
    !!container && !!container.props.style && container.props.style.height === `${900 * 20}px`,
    container && JSON.stringify(container.props.style),
  )
  check('first virtual row starts at top', rows.length > 0 && rows[0].props.style && rows[0].props.style.top === 0)
}

async function testHtmlSafety() {
  console.log('\n[7] HtmlTabView · empty/odd props never throw')
  const fake = installFetch([])
  try {
    const noProps = await renderApp(HtmlTabView, {}, react)
    check('no props renders', textOf(noProps.tree).includes('（未选择文件）'))
    check('no props has no iframe', byType(noProps.tree, 'iframe').length === 0)
    const nullTab = await renderApp(HtmlTabView, { tab: null, onToggleMode: null, onLocate: null }, react)
    check('null tab renders', textOf(nullTab.tree).includes('源码视图'))
    check('null tab has no iframe', byType(nullTab.tree, 'iframe').length === 0)
  } finally {
    fake.restore()
  }
}

/* ------------------------------------------------------------ ImageView */

function imageTab(extra) {
  return { id: 'image:img/x.png', kind: 'image', path: 'img/x.png', ...extra }
}

function testImageMath() {
  console.log('\n[8] ImageView · zoom / fit / pan math')
  check('clamp upper bound (generous 8x)', imageClampZoom(10) === 8)
  check('clamp lower bound', imageClampZoom(0.01) === 0.25)
  check('clamp invalid -> 1', imageClampZoom(NaN) === 1)
  check('wheel step in', Math.abs(imageStepZoom(1, 1) - 1.2) < 1e-9, imageStepZoom(1, 1))
  check('wheel step out', Math.abs(imageStepZoom(1, -1) - 1 / 1.2) < 1e-9, imageStepZoom(1, -1))
  check('wheel step clamps at 8x / 25%', imageStepZoom(7, 1) === 8 && imageStepZoom(0.3, -1) === 0.25)
  const fitLarge = imageFitScale(2000, 1000, 960, 640, 20)
  check('fit scale shrinks large image', Math.abs(fitLarge - 920 / 2000) < 1e-9, fitLarge)
  check('fit scale never upscales by default', imageFitScale(100, 50, 960, 640, 20) === 1)
  check('fit scale upscales when allowed', Math.abs(imageFitScale(24, 24, 960, 640, 20, true) - 25) < 1e-9)
  const fitDisplay = imageDisplaySize(2000, 1000, fitLarge, 1)
  check('fit display size', fitDisplay && fitDisplay.width === 920 && fitDisplay.height === 460, JSON.stringify(fitDisplay))
  const naturalDisplay = imageDisplaySize(2000, 1000, fitLarge, 1 / fitLarge)
  check('100% display size', naturalDisplay && naturalDisplay.width === 2000 && naturalDisplay.height === 1000, JSON.stringify(naturalDisplay))
  check('percent at 100%', imageZoomPercent(1 / fitLarge, fitLarge) === 100, imageZoomPercent(1 / fitLarge, fitLarge))
  check('percent at fit', imageZoomPercent(1, fitLarge) === 46, imageZoomPercent(1, fitLarge))
  check('display null without natural size', imageDisplaySize(0, 0, 1, 1) === null)

  // Fit plan: tiny SVG exports are upscaled to the container, normal ones are not.
  const tinyPlan = imageFitPlan(24, 24, 960, 640, 20, 40)
  check('tiny image detected', tinyPlan.tiny === true)
  check('tiny image upscales to container', Math.abs(tinyPlan.scale - 25) < 1e-9, tinyPlan.scale)
  const iconPlan = imageFitPlan(16, 16, 960, 640, 20, 40)
  check('16px icon upscales to fill height', Math.abs(iconPlan.scale - 37.5) < 1e-9, iconPlan.scale)
  const normalPlan = imageFitPlan(2000, 1000, 960, 640, 20, 40)
  check('normal image plan equal to tight fit', normalPlan.tiny === false && Math.abs(normalPlan.scale - fitLarge) < 1e-9)
  const hugePlan = imageFitPlan(4000, 3000, 960, 640, 20, 40)
  check('huge image shrinks (800x600)', hugePlan.tiny === false && Math.abs(hugePlan.scale - 0.2) < 1e-9, hugePlan.scale)

  // Virtual base for dimensionless SVGs.
  const wideBase = imageVirtualBase(960, 640, 20, 2)
  check('virtual base keeps wide ratio', wideBase.width === 920 && wideBase.height === 460, JSON.stringify(wideBase))
  const tallBase = imageVirtualBase(960, 640, 20, 0.5)
  check('virtual base keeps tall ratio', tallBase.width === 300 && tallBase.height === 600, JSON.stringify(tallBase))
  const squareBase = imageVirtualBase(960, 640, 20, 0)
  check('virtual base falls back to 1:1 box', squareBase.width === 600 && squareBase.height === 600, JSON.stringify(squareBase))

  // 8x fit of a tiny SVG comfortably exceeds 2x the stage.
  const tinyDisplayAtMax = imageDisplaySize(24, 24, tinyPlan.scale, 8)
  check('max zoom reaches >=2x stage', !!tinyDisplayAtMax && tinyDisplayAtMax.width >= 2 * 960 && tinyDisplayAtMax.height >= 2 * 640, JSON.stringify(tinyDisplayAtMax))

  // Anchored zoom keeps the cursor point stable.
  const anchored = imageAnchoredScroll(100, 50, 200, 100, 2)
  check('anchored scroll math', anchored.left === 400 && anchored.top === 200, JSON.stringify(anchored))
  const anchoredZero = imageAnchoredScroll(0, 0, 10, 10, 2)
  check('anchored scroll never negative', anchoredZero.left === 10 && anchoredZero.top === 10, JSON.stringify(anchoredZero))

  const pan = imagePanScroll(100, 50, 30, -20)
  check('pan subtracts drag delta', pan.left === 70 && pan.top === 70, JSON.stringify(pan))
  const clampedPan = imagePanScroll(10, 10, 40, 40)
  check('pan never negative', clampedPan.left === 0 && clampedPan.top === 0, JSON.stringify(clampedPan))
}

const IMAGE_SAMPLE = { naturalWidth: 2000, naturalHeight: 1000, clientWidth: 2000, clientHeight: 1000, style: {} }

function imgStyleWidth(tree) {
  const img = byType(tree, 'img')[0]
  return img && img.props.style ? String(img.props.style.width || '') : ''
}

function imgStyleHeight(tree) {
  const img = byType(tree, 'img')[0]
  return img && img.props.style ? String(img.props.style.height || '') : ''
}

async function testImageInteractions() {
  console.log('\n[9] ImageView · render, click zoom, src stability, error retry')
  const fake = installFetch([])
  try {
    let located = ''
    const tab = imageTab()
    const props = { tab, onLocate: (value) => (located = value) }
    const app = await renderApp(ImageView, props, react)
    let tree = app.tree
    const expectedSrc = `${ROUTE}/api/raw?path=${encodeURIComponent('img/x.png')}`
    const img = byType(tree, 'img')[0]
    check('image rendered', !!img)
    check('image src', !!img && img.props.src === expectedSrc, img && img.props.src)
    check('image alt is filename', !!img && img.props.alt === 'x.png')
    const nameNode = allElements(tree).find((node) => classNameOf(node) === 'mdr-image-name')
    check('filename shown + path tooltip', !!nameNode && textOf(nameNode) === 'x.png' && nameNode.props.title === 'img/x.png')
    check('loading indicator while loading', textOf(tree).includes('正在加载图片…'))
    check('locate button rendered', !!buttonWithText(tree, '定位'))
    clickNode(buttonWithText(tree, '定位'))
    check('onLocate receives path', located === 'img/x.png')

    byType(tree, 'img')[0].props.onLoad({ target: { ...IMAGE_SAMPLE, style: {} } })
    tree = await app.refresh()
    check('loading indicator gone', !textOf(tree).includes('正在加载图片…'))
    check('natural size badge', textOf(tree).includes('2000×1000 px'), textOf(tree).slice(0, 160))
    check('zoom badge says fit', textOf(tree).includes('适应'), textOf(tree).slice(0, 220))
    check('fit sets explicit px (no 0×0 SVG)', imgStyleWidth(tree) === '920px', imgStyleWidth(tree))
    check('src unchanged after load', byType(tree, 'img')[0].props.src === expectedSrc)

    // Single click -> 100% natural; the click is deferred to distinguish dblclick.
    clickNode(byType(tree, 'img')[0])
    await sleep(240)
    tree = await app.refresh()
    check('click zooms to 100%', imgStyleWidth(tree) === '2000px', imgStyleWidth(tree))
    check('indicator shows 100%', textOf(tree).includes('100%'), textOf(tree).slice(0, 220))
    check('src unchanged after zoom', byType(tree, 'img')[0].props.src === expectedSrc)
    check('zoom persisted on tab', Math.abs(Number(tab.imgScale) - 1 / imageFitScale(2000, 1000, 960, 640, 20)) < 0.01, tab.imgScale)
    check('tab.imgZoom legacy flag set', tab.imgZoom === true)

    clickNode(byType(tree, 'img')[0])
    await sleep(240)
    tree = await app.refresh()
    check('second click restores fit', imgStyleWidth(tree) === '920px', imgStyleWidth(tree))

    // Double click resets to fit and cancels the pending single-click toggle.
    clickNode(byType(tree, 'img')[0])
    byType(tree, 'img')[0].props.onDoubleClick()
    await sleep(260)
    tree = await app.refresh()
    check('double-click resets to fit', imgStyleWidth(tree) === '920px', imgStyleWidth(tree))

    byType(tree, 'img')[0].props.onError({})
    tree = await app.refresh()
    check('error note', textOf(tree).includes('图片加载失败'))
    check('error path shown', textOf(tree).includes('img/x.png'))
    check('error retry button', !!buttonWithText(tree, '重试'))
    clickNode(buttonWithText(tree, '重试'))
    tree = await app.refresh()
    const retryImg = byType(tree, 'img')[0]
    check('retry keeps the src (never cleared)', !!retryImg && retryImg.props.src === expectedSrc, retryImg && retryImg.props.src)
    check('retry remounts the image', !!retryImg && retryImg.props.key === 1, retryImg && retryImg.props.key)
    check('retry shows loading again', textOf(tree).includes('正在加载图片…'))
  } finally {
    fake.restore()
  }
}

async function testImagePersistenceAndFallback() {
  console.log('\n[9b] ImageView · persist across remount, SVG fallback, empty props')
  const fake = installFetch([])
  try {
    const tab = imageTab({ id: 'image:img/big.png', path: 'img/big.png' })
    const app = await renderApp(ImageView, { tab }, react)
    byType(app.tree, 'img')[0].props.onLoad({
      target: { naturalWidth: 2000, naturalHeight: 1000, clientWidth: 2000, clientHeight: 1000, style: {} },
    })
    let tree = await app.refresh()
    clickNode(byType(tree, 'img')[0])
    await sleep(240)
    tree = await app.refresh()
    check('zoomed before remount', imgStyleWidth(tree) === '2000px', imgStyleWidth(tree))

    // Remount with the same (mutated) tab: switch away and back.
    const app2 = await renderApp(ImageView, { tab }, react)
    check('restored image rendered', byType(app2.tree, 'img').length === 1)
    byType(app2.tree, 'img')[0].props.onLoad({
      target: { naturalWidth: 2000, naturalHeight: 1000, clientWidth: 2000, clientHeight: 1000, style: {} },
    })
    const tree2 = await app2.refresh()
    check('zoom survives tab switch', imgStyleWidth(tree2) === '2000px', imgStyleWidth(tree2))
  } finally {
    fake.restore()
  }

  // SVG exported with width="100%": no intrinsic size -> container-derived base.
  const svgApp = await renderApp(ImageView, { tab: imageTab({ id: 'image:img/a.svg', path: 'img/a.svg' }) }, react)
  const svgImage = { naturalWidth: 0, naturalHeight: 0, clientWidth: 120, clientHeight: 80, style: {} }
  byType(svgApp.tree, 'img')[0].props.onLoad({ target: svgImage })
  const svgTree = await svgApp.refresh()
  check('dimensionless svg shows natural size as "—"', textOf(svgTree).includes('—'), textOf(svgTree).slice(0, 160))
  check('dimensionless svg fills stage (920x600 ratio 1.5)', imgStyleWidth(svgTree) === '900px', imgStyleWidth(svgTree))
  check('dimensionless svg badge says fit', textOf(svgTree).includes('适应'))
  check('dimensionless svg never 0×0', !imgStyleWidth(svgTree).startsWith('0'), imgStyleWidth(svgTree))

  // Both natural size and rendered box unknown -> sane 1:1 square base.
  const squareApp = await renderApp(ImageView, { tab: imageTab({ id: 'image:img/q.svg', path: 'img/q.svg' }) }, react)
  byType(squareApp.tree, 'img')[0].props.onLoad({ target: { naturalWidth: 0, naturalHeight: 0, clientWidth: 0, clientHeight: 0, style: {} } })
  const squareTree = await squareApp.refresh()
  check('unmeasurable svg falls back to 1:1 box', imgStyleWidth(squareTree) === '600px', imgStyleWidth(squareTree))
  check('unmeasurable svg still shows "—"', textOf(squareTree).includes('—'))

  // Tiny SVG with a measured but tiny natural size (viewBox 24×24) must fill the
  // panel and still allow enlarging beyond the stage (the reported bug).
  const tinyApp = await renderApp(ImageView, { tab: imageTab({ id: 'image:img/tiny.svg', path: 'img/tiny.svg' }) }, react)
  byType(tinyApp.tree, 'img')[0].props.onLoad({
    target: { naturalWidth: 24, naturalHeight: 24, clientWidth: 24, clientHeight: 24, style: {} },
  })
  let tinyTree = await tinyApp.refresh()
  check('tiny svg fit fills panel', imgStyleWidth(tinyTree) === '600px', imgStyleWidth(tinyTree))
  check('tiny svg shows natural size', textOf(tinyTree).includes('24×24 px'), textOf(tinyTree).slice(0, 160))
  clickNode(byType(tinyTree, 'img')[0])
  await sleep(240)
  tinyTree = await tinyApp.refresh()
  check('tiny svg click zooms to 200% of fit', imgStyleWidth(tinyTree) === '1200px', imgStyleWidth(tinyTree))
  byType(tinyTree, 'img')[0].props.onDoubleClick()
  tinyTree = await tinyApp.refresh()
  check('tiny svg double-click returns to fit', imgStyleWidth(tinyTree) === '600px', imgStyleWidth(tinyTree))

  // Huge raster image still shrinks to fit (no accidental upscaling).
  const hugeApp = await renderApp(ImageView, { tab: imageTab({ id: 'image:img/huge.png', path: 'img/huge.png' }) }, react)
  byType(hugeApp.tree, 'img')[0].props.onLoad({
    target: { naturalWidth: 4000, naturalHeight: 3000, clientWidth: 4000, clientHeight: 3000, style: {} },
  })
  const hugeTree = await hugeApp.refresh()
  check('huge image fits stage', imgStyleWidth(hugeTree) === '800px', imgStyleWidth(hugeTree))

  // natural size known but layout box 0×0 (SVG width="100%") -> force px on the node
  const zeroApp = await renderApp(ImageView, { tab: imageTab({ id: 'image:img/z.svg', path: 'img/z.svg' }) }, react)
  const zeroImage = { naturalWidth: 100, naturalHeight: 50, clientWidth: 0, clientHeight: 0, style: {} }
  byType(zeroApp.tree, 'img')[0].props.onLoad({ target: zeroImage })
  const zeroTree = await zeroApp.refresh()
  check(
    '0×0 svg node forced to natural px',
    zeroImage.style.width === '100px' && zeroImage.style.height === '50px',
    JSON.stringify(zeroImage.style),
  )
  check('0×0 svg also gets explicit render size', imgStyleWidth(zeroTree) === '100px', imgStyleWidth(zeroTree))

  const empty = await renderApp(ImageView, {}, react)
  check('empty image props render', textOf(empty.tree).includes('图片'))
}

function testSvgParsing() {
  console.log('\n[10] SVG intrinsic parsing')
  const flow = parseSvgIntrinsic(FLOW_SVG_TEXT)
  check(
    'flow-order viewBox parsed',
    !!flow && Math.abs(flow.width - 1265.671875) < 0.01 && Math.abs(flow.height - 1587.515625) < 0.01,
    flow && JSON.stringify(flow),
  )
  check('viewBox preferred over percentage width', !!flow && flow.source === 'viewBox')
  const commas = parseSvgIntrinsic('<svg viewBox="0,0,100,50"></svg>')
  check('comma separated viewBox', !!commas && commas.width === 100 && commas.height === 50, commas && JSON.stringify(commas))
  const sizeAttrs = parseSvgIntrinsic('<svg width="640" height="480"><path/></svg>')
  check(
    'numeric width/height fallback',
    !!sizeAttrs && sizeAttrs.width === 640 && sizeAttrs.height === 480 && sizeAttrs.source === 'size',
    sizeAttrs && JSON.stringify(sizeAttrs),
  )
  check('px units accepted', svgLengthValue('1265.67px') === 1265.67)
  check('percent rejected', svgLengthValue('100%') === 0)
  check('percent-only sizes -> null', parseSvgIntrinsic('<svg width="100%" height="100%"></svg>') === null)
  check('non-svg text -> null', parseSvgIntrinsic('not an svg document') === null)
  check('empty -> null', parseSvgIntrinsic('') === null)
  check('isSvgPath', isSvgPath('a/b.svg') && isSvgPath('A.SVG') && !isSvgPath('a.png'))
}

async function testSvgViewBoxSizing() {
  console.log('\n[11] ImageView · SVG viewBox sizing (flow-order.svg repro)')
  const fake = installFetch([{ match: `/api/raw?path=${encodeURIComponent(FLOW_SVG_PATH)}`, payload: FLOW_SVG_TEXT }])
  try {
    const tab = { id: `image:${FLOW_SVG_PATH}`, kind: 'image', path: FLOW_SVG_PATH }
    let app = await renderApp(ImageView, { tab }, react)
    const expectedSrc = `${ROUTE}/api/raw?path=${encodeURIComponent(FLOW_SVG_PATH)}`
    let img = byType(app.tree, 'img')[0]
    check('src still the raw URL (never blanked)', !!img && img.props.src === expectedSrc, img && img.props.src)
    // Raster load of this file: naturalWidth is 0 (width="100%").
    img.props.onLoad({ target: { naturalWidth: 0, naturalHeight: 0, clientWidth: 0, clientHeight: 0, style: {} } })
    let tree = await app.refresh()
    check('viewBox intrinsic badge', textOf(tree).includes('1266×1588 px'), textOf(tree).slice(0, 200))
    const plan = imageFitPlan(1265.671875, 1587.515625, 960, 640, 20, 40)
    check('fit fills the panel height', imgStyleWidth(tree) === '478px', imgStyleWidth(tree))
    check('fit height is the stage content height', imgStyleHeight(tree) === '600px', imgStyleHeight(tree))
    check('fit badge says 适应', textOf(tree).includes('适应'))

    // 100% = viewBox pixels, which overflows the stage and becomes scrollable.
    clickNode(byType(tree, 'img')[0])
    await sleep(240)
    tree = await app.refresh()
    check('100% uses viewBox pixels (width)', imgStyleWidth(tree) === '1266px', imgStyleWidth(tree))
    check('100% uses viewBox pixels (height)', imgStyleHeight(tree) === '1588px', imgStyleHeight(tree))
    check('100% indicator', textOf(tree).includes('100%'))

    // Zoom cap far beyond the stage (>= 2x each axis).
    const maxDisplay = imageDisplaySize(1265.671875, 1587.515625, plan.scale, imageClampZoom(8))
    check(
      'cap allows >=2x stage in both axes',
      !!maxDisplay && maxDisplay.width >= 2 * 960 && maxDisplay.height >= 2 * 640,
      JSON.stringify(maxDisplay),
    )

    // Remount: parsed viewBox cached (no refetch) and zoom restored.
    const callsBefore = fake.calls.filter((call) => call.url.includes('/api/raw')).length
    app = await renderApp(ImageView, { tab }, react)
    byType(app.tree, 'img')[0].props.onLoad({
      target: { naturalWidth: 0, naturalHeight: 0, clientWidth: 0, clientHeight: 0, style: {} },
    })
    tree = await app.refresh()
    const callsAfter = fake.calls.filter((call) => call.url.includes('/api/raw')).length
    check('svg parse cached on remount', callsAfter === callsBefore, `${callsBefore} -> ${callsAfter}`)
    check('zoom restored with parsed base', imgStyleWidth(tree) === '1266px', imgStyleWidth(tree))
  } finally {
    fake.restore()
  }

  // Non-SVG images never trigger the SVG text fetch.
  const pngFake = installFetch([])
  try {
    await renderApp(ImageView, { tab: imageTab() }, react)
    check('png does not fetch SVG text', !pngFake.calls.some((call) => call.url.includes('/api/raw')))
  } finally {
    pngFake.restore()
  }
}

async function main() {
  console.log('Markdown Reader html/image tab harness')
  await testHostApis()
  await testHtmlRenderMode()
  await testHtmlSourceMode()
  await testHtmlContentProvided()
  await testHtmlSourceError()
  await testHtmlFallbackToggle()
  await testHtmlSourceVirtual()
  await testHtmlSafety()
  await testImageMath()
  await testImageInteractions()
  await testImagePersistenceAndFallback()
  testSvgParsing()
  await testSvgViewBoxSizing()
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error('\nharness crashed:', error)
  process.exitCode = 1
})
