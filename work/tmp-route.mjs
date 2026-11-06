const res = await fetch('http://127.0.0.1:57377/markdown-reader')
const text = await res.text()
console.log('status', res.status, 'type', res.headers.get('content-type'), 'len', text.length)
console.log(text.slice(0, 1200))
