import fs from 'node:fs'
import vm from 'node:vm'
const DOC = 'C:/Users/1/Desktop/work/tasks/20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'
const md = fs.readFileSync(DOC, 'utf8')
const markedSrc = fs.readFileSync('plugin/vendor/marked.min.js', 'utf8')
const sandbox = { window: {}, console }
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(markedSrc, sandbox)
const marked = sandbox.marked || sandbox.window.marked
const html = marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false })
// inline code spans (not inside <pre>)
const inline = [...html.matchAll(/<code(?![^>]*class="language-)[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
const unique = [...new Set(inline)]
console.log('inline code spans:', inline.length, 'unique:', unique.length)
console.log('sample:', unique.slice(0, 6))

const base = 'http://127.0.0.1:57377/markdown-reader'
let t = Date.now()
const m = await (await fetch(base + '/api/markdown?path=' + encodeURIComponent('20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'))).json()
console.log('api/markdown:', Date.now() - t, 'ms, content', m.content && m.content.length, 'chars')

t = Date.now()
const ex = await (await fetch(base + '/api/exists?path=' + encodeURIComponent(unique.join('\n')) + '&from=' + encodeURIComponent('20260917-微服务/docs/设计/20261105/preSync游标翻页改造详细设计说明书.md'))).json()
console.log('api/exists (all candidates):', Date.now() - t, 'ms, results', Object.keys(ex.results || {}).length)
