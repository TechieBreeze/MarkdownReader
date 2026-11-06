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
const pkg = header.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-authorization']
for (const [name, entry] of Object.entries(pkg.files || {})) {
  if (entry.files) {
    for (const [n2, e2] of Object.entries(entry.files)) {
      if (!/\.(js|mjs|cjs)$/.test(n2) || e2.size < 500) continue
      const text = read(`/dsh/node_modules/@deepseek-ai/dsh-authorization/${name}/${n2}`)
      console.log('=== ' + name + '/' + n2)
      const hits = [...text.matchAll(/[^\n]{0,160}(token|authorization|cookie|header|x-dsh)[^\n]{0,160}/gi)].map((m) => m[0])
      console.log(hits.slice(0, 25).join('\n'))
    }
  }
}
