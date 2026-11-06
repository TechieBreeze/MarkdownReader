import fs from 'node:fs'
const asar = 'D:/DeepSeekHermes/resources/app.asar'
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix + '/' + name
    if (entry.files) walk(entry, full)
    else files.push({ path: full, size: entry.size, offset: entry.offset })
  }
}
walk(header, '')
console.log('total files:', files.length)
const hits = files.filter((f) => /web|client|asset|plugin/i.test(f.path) && /\.(js|mjs|cjs|ts)$/.test(f.path) && f.size > 2000)
console.log(hits.map((f) => `${f.size}\t${f.path}`).join('\n'))
