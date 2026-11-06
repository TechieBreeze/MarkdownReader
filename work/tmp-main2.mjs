import fs from 'node:fs'
const main = fs.readFileSync('work/tmp-main.js', 'utf8')
for (const needle of ['ModuleLoader', 'plugin-client', 'clientEntry', 'client_asset', '/client/', 'import.meta.url']) {
  const hits = [...main.matchAll(new RegExp('[^\n]{0,140}' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\n]{0,140}', 'g'))].map((m) => m[0])
  console.log('=== ' + needle + ': ' + hits.length)
  console.log(hits.slice(0, 4).join('\n---\n'))
}
