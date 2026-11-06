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
// the dsh package (not node_modules) - find the web server sources
const dsh = files.filter((f) => f.path.startsWith('/dsh/') && !f.path.includes('/node_modules/') && /\.(js|mjs|cjs)$/.test(f.path) && /web/i.test(f.path))
console.log(dsh.map((f) => `${f.size}\t${f.path}`).join('\n'))
