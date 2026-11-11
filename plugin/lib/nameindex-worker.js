/**
 * The basename index, built in a WORKER THREAD.
 *
 * The Host runs in the Harness's MAIN process - the same process that serves
 * the app's web requests and the plugin client bundles. Walking the workspace
 * there (the 微服务 workspace holds >150k files) blocked the process for
 * seconds, and the app's own boot then failed to fetch the plugin bundle:
 * "web boot: 1 entry did not activate" -> the app shows the crash dialog and
 * has to be restarted.
 *
 * In a worker the main thread stays free: the tree listing, the markdown
 * fetch and the boot's bundle request are all served immediately.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const HIDDEN_DIR_NAMES = new Set(['.git', 'node_modules', '.mmd-cache', '__pycache__', '.idea', '.vscode-server'])
const MAX_FILES = 400000
const MAX_FILES_PER_ROOT = 120000
const MAX_DEPTH = 18

const roots = Array.isArray(workerData && workerData.roots) ? workerData.roots : []
const cacheFile = (workerData && workerData.cacheFile) || ''

const map = new Map()
let files = 0

/**
 * The roots are walked ROUND ROBIN: the workspace root `work/code` holds the
 * agent workspaces (hundreds of thousands of files) and used to eat the whole
 * file budget, so the workspace with the actual repositories was never
 * reached and their files stayed unresolvable. One directory per root in turn
 * gives every root its share.
 */
const stacks = roots.map((root) => ({ stack: [{ dir: root, depth: 0 }], files: 0 }))

for (;;) {
  let progressed = false
  for (const entry of stacks) {
    if (!entry.stack.length) continue
    if (files >= MAX_FILES) break
    if (entry.files >= MAX_FILES_PER_ROOT) {
      entry.stack.length = 0
      continue
    }
    const { dir, depth } = entry.stack.pop()
    let dirents = null
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      progressed = true
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || HIDDEN_DIR_NAMES.has(dirent.name)) continue
      const child = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < MAX_DEPTH) entry.stack.push({ dir: child, depth: depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      files += 1
      entry.files += 1
      // Only the SHALLOWEST path per name: that is the one the search prefers
      // (a doc's citation means the top-level file, not a copy deep in target/).
      const known = map.get(dirent.name)
      if (known === undefined) map.set(dirent.name, child)
      else if (child.split(path.sep).length < known.split(path.sep).length) map.set(dirent.name, child)
    }
    progressed = true
  }
  if (!progressed || files >= MAX_FILES) break
}

// The worker also writes the cache - off the main thread, so a multi-megabyte
// string never exists in the Harness's main process.
let saved = 0
if (cacheFile) {
  try {
    const lines = []
    for (const [name, best] of map) {
      if (lines.length >= 20000) break
      lines.push(`${name}\t${best}`)
      saved += 1
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(
      cacheFile,
      `${Date.now()}\t${(workerData && workerData.key) || ''}\t${(workerData && workerData.version) || 'v2'}\n${lines.join('\n')}`,
      'utf8',
    )
  } catch {
    // A read-only home is not a reason to break the reader.
  }
}

// The main thread only gets the capped entries (the same set the cache holds).
const entries = []
for (const [name, best] of map) {
  if (entries.length >= 20000) break
  entries.push([name, best])
}

parentPort.postMessage({ ok: true, files, entries, saved })
