import fs from 'node:fs'
const text = fs.readFileSync('work/tmp-client-modules.js', 'utf8')
const lines = text.split('\n')
console.log(lines.slice(150, 235).map((l, i) => String(i + 151).padStart(4) + ' ' + l).join('\n'))
console.log('=== where baseline comes from ===')
lines.forEach((line, i) => {
  if (/baseline|artifactRevision|statSync|mtimeMs/.test(line)) console.log(String(i + 1).padStart(4), line.slice(0, 200))
})
