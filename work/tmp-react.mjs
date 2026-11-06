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
    else files.push({ path: full, size: entry.size })
  }
}
walk(header, '')
const react = files.filter((f) => /react(-dom)?[/\\.](development|production)(\.min)?\.js$|react-dom\.umd|react\.umd/i.test(f.path))
console.log(react.map((f) => `${f.size}\t${f.path}`).join('\n') || 'no umd react found')
console.log('--- any file named react-dom.js / react.js under a client asset dir:')
console.log(files.filter((f) => /react/i.test(f.path) && /\.(js|mjs)$/.test(f.path) && f.size > 100000).map((f) => `${f.size}\t${f.path}`).slice(0, 20).join('\n'))
