/**
 * Recreate the read-only oracle: a self-contained copy of the ORIGINAL
 * Markdown Reader server (Python) used as ground truth for jump-resolution
 * parity tests. The copy lives in work/oracle (gitignored) so `input/reference`
 * stays pristine and the repository does not carry a second vendor_py.
 *
 * Usage:
 *   node work/oracle-setup.mjs
 *   cd work/oracle && python server.py --port 8790 \
 *     --root "C:/Users/1/Desktop/work/code" \
 *     --root "C:/Users/1/Desktop/work/tasks/20260917-微服务"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REFERENCE = path.resolve(HERE, '..', 'input', 'reference')
const TARGET = path.resolve(HERE, 'oracle')

const FILES = ['server.py', 'web_defs.py', 'soa_defs.py']
const DIRS = ['vendor_py']

fs.mkdirSync(TARGET, { recursive: true })
for (const name of FILES) {
  const from = path.join(REFERENCE, name)
  if (!fs.existsSync(from)) throw new Error(`missing reference file: ${from}`)
  fs.copyFileSync(from, path.join(TARGET, name))
}
for (const name of DIRS) {
  const from = path.join(REFERENCE, name)
  if (!fs.existsSync(from)) throw new Error(`missing reference dir: ${from}`)
  fs.cpSync(from, path.join(TARGET, name), { recursive: true })
}
console.log(`oracle ready: ${TARGET}`)
console.log('start it with: cd work/oracle && python server.py --port 8790 --root <root> [--root <root>]')
