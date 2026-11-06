import fs from 'node:fs'
const main = fs.readFileSync('work/tmp-main.js', 'utf8')
const needles = ['__ModuleLoader__ =', '__ModuleLoader__=', 'window.__ModuleLoader__', '"/plugins', "'/plugins", '/pkg/', 'node_modules/', 'immutable', 'max-age']
for (const needle of needles) {
  const hits = [...main.matchAll(new RegExp('[^\n]{0,160}' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\n]{0,160}', 'g'))].map((m) => m[0])
  console.log('=== ' + needle + ': ' + hits.length)
  console.log(hits.slice(0, 5).join('\n---\n'))
}
