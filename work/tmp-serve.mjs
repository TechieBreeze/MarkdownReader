const urls = [
  'http://127.0.0.1:57377/plugins/??@local/markdown-reader/client.js&rev=test',
  'http://127.0.0.1:57377/plugins/@local/markdown-reader/client.js',
]
for (const url of urls) {
  const res = await fetch(url)
  const text = await res.text()
  console.log(url, '->', res.status, res.headers.get('content-type'), 'len', text.length)
  console.log('   cache-control:', res.headers.get('cache-control'))
  console.log('   head:', text.slice(0, 120).replace(/\n/g, ' '))
  if (text.includes('mdr-md-diff')) console.log('   >>> SERVED BUNDLE CONTAINS THE DIFF FENCE CODE')
  if (text.includes('isDiffFenceLang')) console.log('   >>> has isDiffFenceLang')
  else if (text.length > 1000) console.log('   >>> NO isDiffFenceLang in the served bundle (STALE)')
}
