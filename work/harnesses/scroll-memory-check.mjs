/**
 * Reading-position memory across TASKS (regression).
 *
 * The bug the user reported: "切『任务』到别的任务，记录的滚动位置就没了" - the
 * reading position of a document was lost when the workbench switched to
 * another task and back.
 *
 * Two causes, both checked here:
 *  1. the position was keyed by PATH only. The tab id is `<kind>:<path>`, so
 *     the same document open in two tasks is the SAME tab id - the two tasks
 *     shared one position and overwrote each other. The key must carry the
 *     task id.
 *  2. the markdown view restores its position when it MOUNTS. With the same
 *     tab id in two tasks React REUSES the view, nothing remounts, so the
 *     position of the task you came back to was never applied. The App now
 *     restores it explicitly on every task/tab change.
 *
 * Usage: node work/harnesses/scroll-memory-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 300)}`}`)
  }
}

/* ------------------------------------------------------------ fake storage */

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}
globalThis.sessionStorage = globalThis.localStorage

/* --------------------------------------------------------- load the parts */

function lift(file, names, extra = '') {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  const parts = []
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`${name} not found in ${file}`)
    const end = source.indexOf('\nfunction ', start + 10)
    parts.push(source.slice(start, end < 0 ? source.length : end))
  }
  return new Function(`${parts.join('\n')}\n${extra}\nreturn { ${names.join(', ')} }`)()
}

const coreSource = fs.readFileSync(path.join(SRC, '00-core.js'), 'utf8')
const core = lift('00-core.js', ['mdScrollKey', 'tabScrollKey'], coreSource.slice(coreSource.indexOf('const scrollStorage = (() => {'), coreSource.indexOf('/* ------------------------------------------------------------------- icons */')))
const workbench = lift('32-workbench.js', ['rememberTabScroll', 'recallTabScroll', 'normalizeTab', 'normalizeWorkbench', 'saveWorkbench'], `${coreSource.slice(coreSource.indexOf('const scrollStorage = (() => {'), coreSource.indexOf('/* ------------------------------------------------------------------- icons */'))}\nconst mdScrollKey = ${core.mdScrollKey.toString()}\nconst tabScrollKey = ${core.tabScrollKey.toString()}\nconst tabScrollMemory = new Map()\nlet taskSeq = 0\nfunction seedTaskSeq(tasks){ for (const t of tasks||[]) { const m = /^task(\\d+)$/.exec(String((t&&t.id)||'')); if (m) taskSeq = Math.max(taskSeq, Number(m[1])) } }\nfunction nextTaskId(){ taskSeq += 1; return 'task' + taskSeq }\nfunction kindForPath(p){ return /\\.md$/i.test(p) ? 'md' : 'code' }\nfunction langForPath(){ return '' }\nfunction isImageFile(){ return false }\nfunction extOf(p){ const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i) }\nconst taskStoreKey = (p) => 'tasks:' + p\nconst writeStoredJson = (k, v) => localStorage.setItem(k, JSON.stringify(v))\nconst readStoredJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }\n`)

/* --------------------------------------------------------------- the tests */

console.log('\n[1] the position key carries the task id')
const keyA = core.mdScrollKey('task1', 'docs/a.md')
const keyB = core.mdScrollKey('task2', 'docs/a.md')
check('two tasks, same document, different keys', keyA !== keyB, { keyA, keyB })
check('the key still contains the path', keyA.includes('docs/a.md') && keyA.includes('task1'), keyA)
check('the tab scroll key is task scoped too', core.tabScrollKey('task1', 'md:docs/a.md') !== core.tabScrollKey('task2', 'md:docs/a.md'))

console.log('\n[2] two tasks keep their own position')
workbench.rememberTabScroll(core.tabScrollKey('task1', 'md:docs/a.md'), 2400)
workbench.rememberTabScroll(core.tabScrollKey('task2', 'md:docs/a.md'), 800)
check('task 1 keeps its position', workbench.recallTabScroll(core.tabScrollKey('task1', 'md:docs/a.md')) === 2400)
check('task 2 keeps its position', workbench.recallTabScroll(core.tabScrollKey('task2', 'md:docs/a.md')) === 800)

console.log('\n[3] the workbench round trip keeps both positions')
const live = {
  activeTaskId: 'task2',
  tasks: [
    {
      id: 'task1',
      name: '任务1',
      activeId: 'md:docs/a.md',
      tabs: [
        {
          id: 'md:docs/a.md',
          kind: 'md',
          path: 'docs/a.md',
          line: 0,
          branch: '',
          commit: '',
          htmlMode: 'render',
          navFrom: false,
          scroll: 0,
        },
      ],
    },
    {
      id: 'task2',
      name: '任务2',
      activeId: 'md:docs/a.md',
      tabs: [
        {
          id: 'md:docs/a.md',
          kind: 'md',
          path: 'docs/a.md',
          line: 0,
          branch: '',
          commit: '',
          htmlMode: 'render',
          navFrom: false,
          scroll: 0,
        },
      ],
    },
  ],
}
workbench.saveWorkbench('proj', live)
const saved = JSON.parse(localStorage.getItem('tasks:proj'))
check('the stored scroll is task scoped', saved.tasks[0].tabs[0].scroll === 2400 && saved.tasks[1].tabs[0].scroll === 800, saved.tasks.map((t) => t.tabs[0].scroll))
// A fresh page: the positions must come back per task.
workbench.rememberTabScroll(core.tabScrollKey('task1', 'md:docs/a.md'), 0)
workbench.rememberTabScroll(core.tabScrollKey('task2', 'md:docs/a.md'), 0)
const restored = workbench.normalizeWorkbench(saved)
check('the workbench is restored', !!restored && restored.tasks.length === 2)
check(
  'after a reload task 1 keeps its position',
  workbench.recallTabScroll(core.tabScrollKey('task1', 'md:docs/a.md')) === 2400,
  workbench.recallTabScroll(core.tabScrollKey('task1', 'md:docs/a.md')),
)
check(
  'after a reload task 2 keeps its position',
  workbench.recallTabScroll(core.tabScrollKey('task2', 'md:docs/a.md')) === 800,
  workbench.recallTabScroll(core.tabScrollKey('task2', 'md:docs/a.md')),
)

console.log('\n[4] the app restores the position on every task/tab change')
const appSource = fs.readFileSync(path.join(SRC, '50-app.js'), 'utf8')
const mdSource = fs.readFileSync(path.join(SRC, '10-markdown.js'), 'utf8')
check('saveActiveScroll keys by task', /scrollStorage\.set\(mdScrollKey\(task\.id, tab\.path\)/.test(appSource))
check('the scroll listener keys by task', /scrollStorage\.set\(mdScrollKey\(task\.id, tab\.path\)/.test(appSource))
check('the app restores on task/tab change', /mdScrollKey\(workbench\.activeTaskId, activeTab\.path\)/.test(appSource))
check('the restore effect watches the task and the tab', /\[workbench\.activeTaskId, activeTabKey\]/.test(appSource))
check('the markdown view knows its task', /taskId/.test(mdSource) && /mdScrollKey\(taskId, tab\.path\)/.test(mdSource))
check('the markdown view is given the task id', /taskId: workbench\.activeTaskId/.test(appSource))
check('switching a task saves the outgoing position', /const switchTask = React\.useCallback\([\s\S]{0,320}?saveActiveScroll\(\)/.test(appSource))

console.log(failures ? `\n${failures} check(s) failed` : '\nall scroll memory checks passed')
if (failures) process.exitCode = 1
