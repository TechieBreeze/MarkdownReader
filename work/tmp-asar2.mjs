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
const own = files.filter((f) => !f.path.includes('node_modules') && /\.(js|mjs|cjs|ts|tsx)$/.test(f.path))
console.log('own source files:', own.length)
console.log(own.map((f) => `${f.size}\t${f.path}`).join('\n'))
