/**
 * HTML preview render probe (headless Chrome + CDP).
 *
 * Answers the only question that matters for "some charts do not render":
 * does the page really paint its chart canvases, and what does the console say?
 *
 * Usage:
 *   node work/html-preview-probe.mjs                 # plugin preview vs local file
 *   node work/html-preview-probe.mjs <url> [<url>]   # compare two URLs
 *
 * Exits non-zero when a URL renders no canvas while the baseline does, or when
 * the page logged an uncaught error.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

const PROBE_EXPRESSION = `(() => {
  const canvases = [...document.querySelectorAll('canvas')]
  const sized = canvases.filter((c) => c.width > 0 && c.height > 0)
  const chartHosts = [...document.querySelectorAll('[id^="c"], .chart, [class*="chart"]')]
    .map((el) => ({ id: el.id || '', w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((row) => row.w > 0 && row.h > 0)
  return JSON.stringify({
    url: location.href,
    title: document.title,
    canvases: canvases.length,
    sizedCanvases: sized.length,
    chartHosts: chartHosts.length,
    hasEcharts: typeof window.echarts === 'object' && window.echarts !== null,
    bodyHeight: document.body ? document.body.scrollHeight : 0,
    docHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
  })
})()`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // chrome not up yet
    }
    await sleep(200)
  }
  throw new Error('devtools endpoint never came up')
}

async function probe(chrome, url, port, waitMs) {
  const wsUrl = await waitForDevtools(port)
  const socket = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const logs = []
  const errors = []
  const events = []
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    events.push(message)
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      logs.push(`${message.params.type}: ${text}`)
      if (message.params.type === 'error') errors.push(text)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {}
      errors.push(details.exception?.description || details.text || 'unknown exception')
    }
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params: params || {} }))
    })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')
  await send('Page.navigate', { url })
  await sleep(waitMs)
  const result = await send('Runtime.evaluate', { expression: PROBE_EXPRESSION, returnByValue: true })
  const value = result.result?.result?.value
  const info = value ? JSON.parse(value) : null
  socket.close()
  return { info, logs, errors }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    console.log('SKIP: no Chromium binary found (set CHROME_PATH)')
    return
  }
  const docAbs = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/公众号身份重复门店8888-stage数据全景.html'
  const rel = '20260917-微服务/docs/' + encodeURIComponent('公众号身份重复门店8888-stage数据全景.html')
  const pluginUrl = process.env.PLUGIN_URL || `http://127.0.0.1:57377/markdown-reader/api/html?path=${rel}`
  const baselineUrl = `file:///${docAbs.replace(/\\/g, '/')}`
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : [baselineUrl, pluginUrl]

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-html-probe-'))
  const port = 9400 + Math.floor(Math.random() * 200)
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      '--window-size=1400,1000',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  let failed = false
  try {
    for (const url of urls) {
      const { info, logs, errors } = await probe(chrome, url, port, 6000)
      console.log(`\n=== ${url.slice(0, 120)}`)
      console.log('   ', JSON.stringify(info))
      if (logs.length) console.log('    console:', logs.slice(0, 6).join(' | ').slice(0, 600))
      if (errors.length) console.log('    errors :', errors.slice(0, 4).join(' | ').slice(0, 600))
      if (!info || info.sizedCanvases === 0) {
        console.log('    FAIL: no sized <canvas> -> the chart did not render')
        failed = true
      }
      if (errors.length) {
        console.log('    FAIL: the page raised uncaught errors')
        failed = true
      }
    }
  } finally {
    child.kill()
    await sleep(400)
    try {
      execFileSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
    } catch {
      // already gone
    }
    fs.rmSync(profile, { recursive: true, force: true })
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exitCode = failed ? 1 : 0
}

main()
