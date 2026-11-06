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
const main = read('/lib/main.js')
fs.writeFileSync('work/tmp-main.js', main, 'utf8')
const hits = [...main.matchAll(/[^\n]{0,120}client\.js[^\n]{0,120}/g)].map((m) => m[0])
console.log('client.js mentions:', hits.length)
console.log(hits.slice(0, 12).join('\n---\n'))
