/**
 * Host half of the Markdown Reader bundle.
 *
 * Registers one same-origin prefix route on the Harness web server. The Client
 * half (client.js) fetches JSON from it; the route also serves the vendored
 * browser libraries (marked / highlight.js) the page needs.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createState } from './lib/state.js'
import { handleRequest } from './lib/api.js'
import { ROUTE } from './lib/constants.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export { ROUTE }

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const state = createState({ ...config, packageDir: HERE })
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => handleRequest(req, res, state),
      }),
    'markdown-reader: http route',
  )
  ctx.logger?.('markdown-reader plugin ready', { roots: state.roots().map((r) => r.path) })
}
