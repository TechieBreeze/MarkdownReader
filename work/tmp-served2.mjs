import fs from 'node:fs'
import crypto from 'node:crypto'
const st = fs.statSync('plugin/client.js')
function framedHash(domain, parts) {
  const hash = crypto.createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}
const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
const res = await fetch(`http://127.0.0.1:57377/plugins/??@local/markdown-reader/client.js&rev=${rev}`)
const text = await res.text()
const probes = {
  'dispatch: isDiffFenceLang(lang)': text.includes('isDiffFenceLang(lang)'),
  'wrapper class mdr-md-diff': text.includes('mdr-md-diff'),
  'FENCE_CSS id': text.includes("const FENCE_CSS_ID = 'mdr-fence-css'"),
  'fence css diff rules': text.includes('.mdr-md .mdr-md-diff .mdr-cl.mdr-git-add'),
  'hljs palette for diff': text.includes('.mdr-md .mdr-md-diff .hljs-keyword'),
  'APP_CSS': text.includes('const APP_CSS = `'),
  'FENCE_CSS': text.includes('const FENCE_CSS = `'),
  'reportMdRender': text.includes('function reportMdRender'),
  'idle scheduling in fences': text.includes('requestIdleCallback'),
}
for (const [name, ok] of Object.entries(probes)) console.log(ok ? 'ok  ' : 'MISS', name)
// how is FENCE_CSS injected?
const i = text.indexOf('function ensureFenceCss')
console.log('\n--- ensureFenceCss in the SERVED bundle ---')
console.log(text.slice(i, i + 520))
