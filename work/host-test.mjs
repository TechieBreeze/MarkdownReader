/**
 * Standalone harness for the plugin's Host API: imports lib/*.js directly and
 * serves them on 127.0.0.1:8799 so host changes can be verified without
 * restarting the DSH app.
 *
 * Usage: node work/host-test.mjs [rootPath...]
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createState } from '../plugin/lib/state.js'
import { handleRequest } from '../plugin/lib/api.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'plugin')
const roots = process.argv.slice(2)
const state = createState({
  packageDir: PLUGIN,
  roots: roots.length ? roots : ['C:/Users/1/Desktop/work/tasks/20260917-微服务'],
})

const server = http.createServer((req, res) => handleRequest(req, res, state))
server.listen(8799, '127.0.0.1', () => {
  console.log('host-test listening http://127.0.0.1:8799')
  console.log('roots:', state.roots().map((root) => root.path).join(', '))
})
