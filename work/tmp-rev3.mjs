import fs from 'node:fs'
const text = fs.readFileSync('work/tmp-client-modules.js', 'utf8')
const lines = text.split('\n')
const show = (from, to) => console.log(lines.slice(from - 1, to).map((l, i) => String(from + i).padStart(4) + ' ' + l).join('\n'))
show(596, 660)
console.log('...')
show(800, 915)
