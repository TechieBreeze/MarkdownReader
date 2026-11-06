import fs from 'node:fs'
const asar = 'D:/DeepSeekHermes/resources/app.asar'
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
const dataStart = 16 + headerSize
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix + '/' + name
    if (entry.files) walk(entry, full)
    else files.push({ path: full, size: entry.size, offset: entry.offset })
  }
}
walk(header, '')
const read = (f) => buf.slice(dataStart + Number(f.offset), dataStart + Number(f.offset) + f.size).toString('utf8')
const hits = []
for (const f of files) {
  if (!/\.(js|mjs|cjs)$/.test(f.path) || f.size < 2000 || f.size > 900000) continue
  if (f.path.includes('/node_modules/') && !f.path.includes('@deepseek-ai/dsh-client')) continue
  const text = read(f)
  if (!text.includes('attachShadow')) continue
  const idx = text.indexOf('attachShadow')
  hits.push({ path: f.path, snippet: text.slice(Math.max(0, idx - 300), idx + 200).replace(/\n/g, ' ') })
}
console.log('files using attachShadow:', hits.length)
for (const hit of hits.slice(0, 6)) {
  console.log('=== ' + hit.path)
  console.log(hit.snippet)
}
