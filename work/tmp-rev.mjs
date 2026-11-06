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
const text = read('/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js')
fs.writeFileSync('work/tmp-client-modules.js', text, 'utf8')
const lines = text.split('\n')
lines.forEach((line, i) => {
  if (/rev\b|revision|hash|etag|mtime|version/i.test(line)) console.log(String(i + 1).padStart(4), line.slice(0, 220))
})
