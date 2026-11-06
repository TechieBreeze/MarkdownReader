import fs from 'node:fs'
const asar = 'D:/DeepSeekHermes/resources/app.asar'
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
const dataStart = 16 + headerSize
const dsh = header.files.dsh
console.log('/dsh entries:', Object.keys(dsh.files || {}).join(', '))
const pkgs = dsh.files.packages
if (pkgs) console.log('/dsh/packages entries:', Object.keys(pkgs.files || {}).join(', '))
const nm = dsh.files.node_modules
if (nm) {
  const deep = nm.files['@deepseek-ai']
  if (deep) console.log('@deepseek-ai:', Object.keys(deep.files || {}).join(', '))
}
