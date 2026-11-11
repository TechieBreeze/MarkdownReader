import { parentPort, workerData } from 'node:worker_threads'
import { buildClassIndexEntries } from './defs.js'

const { rootAbs, prefix, onlyRepos } = workerData || {}

try {
  const entries = buildClassIndexEntries(rootAbs, prefix || '', onlyRepos || null)
  parentPort.postMessage({ ok: true, rootAbs, entries })
} catch (error) {
  parentPort.postMessage({ ok: false, rootAbs, error: error && error.message ? error.message : String(error) })
}
