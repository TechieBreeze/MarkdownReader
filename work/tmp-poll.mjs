const base = 'http://127.0.0.1:57377/markdown-reader'
for (let i = 0; i < 20; i += 1) {
  const last = await (await fetch(base + '/api/client-ping')).json()
  if (last.last && last.last.md) { console.log('MD REPORT:', JSON.stringify(last.last, null, 1)); break }
  await new Promise((r) => setTimeout(r, 3000))
}
