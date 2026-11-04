/** Small HTTP helpers for the Host route. */
import fs from 'node:fs'
import path from 'node:path'

export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendText(res, status, value, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(value, 'utf8')
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: String(message || 'error') })
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function sendFile(res, absPath) {
  let stat
  try {
    stat = fs.statSync(absPath)
  } catch {
    sendError(res, 404, 'not found')
    return
  }
  if (!stat.isFile()) {
    sendError(res, 404, 'not found')
    return
  }
  const ext = path.extname(absPath).toLowerCase()
  const types = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }
  res.writeHead(200, {
    'content-type': types[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  })
  fs.createReadStream(absPath).pipe(res)
}
