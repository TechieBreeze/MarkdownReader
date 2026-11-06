import fs from 'node:fs'
const asar = 'D:/DeepSeekHermes/resources/app.asar'
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
const dataStart = 16 + headerSize
function read(filePath) {
  let node = header
  for (const part of filePath.split('/').filter(Boolean)) {
    node = node.files[part]
    if (!node) throw new Error('missing ' + part)
  }
  return buf.slice(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size).toString('utf8')
}
const root = '/dsh/node_modules/@deepseek-ai/'
for (const pkg of ['dsh-client-modules', 'dsh-host-webserver']) {
  const node = header.files.dsh.files.node_modules.files['@deepseek-ai'].files[pkg]
  console.log('=== ' + pkg, JSON.stringify(node.files ? Object.keys(node.files) : node.size))
  for (const [name, entry] of Object.entries(node.files || {})) {
    if (entry.files) {
      for (const [n2, e2] of Object.entries(entry.files)) {
        if (/\.(js|mjs|cjs)$/.test(n2) && e2.size > 1000) {
          const text = read(`/dsh/node_modules/@deepseek-ai/${pkg}/${name}/${n2}`)
          const hits = [...text.matchAll(/[^\n]{0,150}(client\.js|cache-control|Cache-Control|etag|max-age|no-cache)[^\n]{0,150}/g)].map((m) => m[0])
          if (hits.length) {
            console.log('--- ' + name + '/' + n2)
            console.log(hits.slice(0, 12).join('\n'))
          }
        }
      }
    } else if (/\.(js|mjs|cjs)$/.test(name) && entry.size > 1000) {
      const text = read(`/dsh/node_modules/@deepseek-ai/${pkg}/${name}`)
      const hits = [...text.matchAll(/[^\n]{0,150}(client\.js|cache-control|Cache-Control|etag|max-age|no-cache)[^\n]{0,150}/g)].map((m) => m[0])
      if (hits.length) {
        console.log('--- ' + name)
        console.log(hits.slice(0, 12).join('\n'))
      }
    }
  }
}
