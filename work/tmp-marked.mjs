import fs from 'node:fs'
import vm from 'node:vm'
const markedSrc = fs.readFileSync('plugin/vendor/marked.min.js', 'utf8')
const sandbox = { window: {}, console }
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(markedSrc, sandbox)
const marked = sandbox.marked || sandbox.window.marked
const DOC = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'
const md = fs.readFileSync(DOC, 'utf8')
const html = marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
fs.writeFileSync('work/tmp-marked.html', html, 'utf8')
const classes = [...html.matchAll(/<code class="([^"]*)"/g)].map((m) => m[1])
const counts = {}
classes.forEach((c) => { counts[c] = (counts[c] || 0) + 1 })
console.log('code class histogram:', JSON.stringify(counts, null, 1))
console.log('language-diff blocks:', classes.filter((c) => c === 'language-diff').length)
// how many fences does the source have?
console.log('source ```diff fences:', (md.match(/^```diff/gm) || []).length)
console.log('source ``` fences total:', (md.match(/^```/gm) || []).length)
// find fences whose class is missing
const missing = [...html.matchAll(/<pre><code([^>]*)>/g)].map((m) => m[1]).filter((a) => !a.includes('language-'))
console.log('code blocks WITHOUT a language class:', missing.length, JSON.stringify(missing.slice(0, 5)))
