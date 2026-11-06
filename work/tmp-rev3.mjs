import fs from 'node:fs'
import crypto from 'node:crypto'
const file = 'plugin/client.js'
const st = fs.statSync(file)
function framedHash(domain, parts) {
  const hash = crypto.createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}
const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
console.log('client.js mtimeMs', st.mtimeMs, 'size', st.size)
console.log('computed rev:', rev)
const url = `http://127.0.0.1:57377/plugins/??@local/markdown-reader/client.js&rev=${rev}`
const res = await fetch(url)
const text = await res.text()
console.log('GET', url)
console.log('status', res.status, 'type', res.headers.get('content-type'), 'cache-control', res.headers.get('cache-control'), 'len', text.length)
if (text.length > 1000) {
  console.log('served bundle has the diff fence code:', text.includes('function isDiffFenceLang'))
  console.log('served bundle build id:', /const BUILD_ID = "([0-9a-f]+)"/.exec(text)?.[1])
}
