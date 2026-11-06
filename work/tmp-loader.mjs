import fs from 'node:fs'
const main = fs.readFileSync('work/tmp-main.js', 'utf8')
const start = main.indexOf('var ModuleLoader;')
const region = main.slice(start, start + 9000)
console.log(region)
