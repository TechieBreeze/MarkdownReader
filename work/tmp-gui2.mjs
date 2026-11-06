const html = await (await fetch('http://127.0.0.1:57377/')).text()
console.log('len', html.length)
console.log(html.slice(0, 1500))
