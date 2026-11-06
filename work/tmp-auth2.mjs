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
const needle = 'authentication required'
for (const f of files) {
  if (f.size < 500 || f.size > 400000) continue
  if (!/\.(js|mjs|cjs)$/.test(f.path)) continue
  const text = read(f)
  if (!text.includes(needle)) continue
  console.log('=== ' + f.path)
  const idx = text.indexOf(needle)
  console.log(text.slice(Math.max(0, idx - 2600), idx + 300))
  break
}
