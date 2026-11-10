/**
 * Workbench layer (项目 → 任务) — owned by the workbench slice.
 *
 * One 项目 (workspace root, `currentProject` = null means 全部) owns an ordered
 * list of 任务 (workbench chips). A task is an ordered tab set + one active tab.
 * Everything is persisted per project (see taskStoreKey in 00-core.js):
 *
 *   { activeTaskId, tasks: [{ id, name, activeId, tabs: [stored tab] }] }
 *
 * Stored tabs drop the loaded content (它只在激活时懒加载) but keep path, kind,
 * jump line, git version (branch/commit) and the HTML render/source mode.
 *
 * The App (50-app.js) owns the live task state; this module owns the pure
 * state machine helpers and the chip-row component so the App shell stays
 * readable. Task ids look like `task<N>` and the tab id is always
 * `<kind>:<path>` — the same document opened in two tasks is two tab instances
 * with the same id, which keeps loading/de-dup logic simple.
 */

/** Task id sequence (seeded from restored state so ids never collide). */
let taskSeq = 0

/** tab id -> last known scrollTop (fed by 50-app.js; kept out of React state). */
const tabScrollMemory = new Map()

function rememberTabScroll(tabId, top) {
  if (!tabId) return
  const value = Math.max(0, Math.round(Number(top) || 0))
  tabScrollMemory.set(tabId, value)
}

function recallTabScroll(tabId) {
  return tabScrollMemory.get(tabId) || 0
}

function nextTaskId() {
  taskSeq += 1
  return `task${taskSeq}`
}

/** Seed the id counter from restored ids so new tasks never duplicate one. */
function seedTaskSeq(tasks) {
  for (const task of tasks || []) {
    const match = /^task(\d+)$/.exec(String((task && task.id) || ''))
    if (match) taskSeq = Math.max(taskSeq, Number(match[1]))
  }
}

/**
 * Tab kind by extension (the standalone reader's `tabKindForPath`): a `.html`
 * file opens as a rendered tab (not source), images preview, markdown renders,
 * everything else is a text/code tab.
 */
function kindForPath(rel) {
  const ext = extOf(rel)
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (isImageFile(rel)) return 'image'
  return 'code'
}

/** One empty workbench task. */
function newTaskRecord(name) {
  return { id: nextTaskId(), name: String(name || '任务'), tabs: [], activeId: null }
}

/** Live tab record from a stored/live tab; content is always lazy-loaded. */
function normalizeTab(raw) {
  if (!raw || typeof raw.path !== 'string' || !raw.path) return null
  const path = raw.path.replace(/\\/g, '/').replace(/^\/+/, '')
  const kind = kindForPath(path)
  // The standalone tool persisted `jumpLine` / `scrollTop`; the plugin's own
  // older flat store used `line` / `scroll`. Accept both.
  const line = Math.max(0, Number(raw.line != null ? raw.line : raw.jumpLine) || 0)
  return {
    id: `${kind}:${path}`,
    kind,
    path,
    content: null,
    lang: kind === 'code' ? langForPath(path) : kind === 'html' ? 'xml' : '',
    line,
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    commit: typeof raw.commit === 'string' ? raw.commit : '',
    htmlMode: raw.htmlMode === 'source' ? 'source' : 'render',
    navFrom: !!raw.navFrom,
    error: '',
    scroll: Math.max(0, Number(raw.scroll != null ? raw.scroll : raw.scrollTop) || 0),
  }
}

/**
 * Clamp a persisted workbench blob into the live shape. Returns null when there
 * is nothing usable (caller then creates the default 任务).
 */
function normalizeWorkbench(data) {
  if (!data || !Array.isArray(data.tasks) || !data.tasks.length) return null
  const tasks = []
  for (const rawTask of data.tasks) {
    if (!rawTask || typeof rawTask !== 'object') continue
    const tabs = []
    for (const rawTab of Array.isArray(rawTask.tabs) ? rawTask.tabs : []) {
      const tab = normalizeTab(rawTab)
      if (!tab) continue
      // The same path may only appear once per task (id is kind:path).
      if (tabs.some((item) => item.id === tab.id)) continue
      // The reading position belongs to the TASK: the tab id is shared between
      // tasks, so a task-scoped key keeps the two positions apart.
      if (tab.scroll > 0) rememberTabScroll(tabScrollKey(rawTask.id, tab.id), tab.scroll)
      tabs.push(tab)
    }
    const wantedActive = rawTask.activeId != null ? rawTask.activeId : rawTask.activeTabId
    const activeId = tabs.some((tab) => tab.id === wantedActive)
      ? wantedActive
      : tabs.length
        ? tabs[tabs.length - 1].id
        : null
    tasks.push({
      id: typeof rawTask.id === 'string' && rawTask.id ? rawTask.id : nextTaskId(),
      name: String(rawTask.name || '任务'),
      tabs,
      activeId,
    })
  }
  if (!tasks.length) return null
  seedTaskSeq(tasks)
  const activeTaskId = tasks.some((task) => task.id === data.activeTaskId) ? data.activeTaskId : tasks[0].id
  return { tasks, activeTaskId }
}

/**
 * Restore the workbench for a project. Migration order:
 *   1. the project's own new key;
 *   2. (全部 only) the earlier flat plugin tab set mdreader.plugin.tabs.v1.
 * The standalone tool's mdreader.tasks.v1 has the same shape as our stored state,
 * so normalizeWorkbench accepts it directly as the legacy key for 全部.
 */
function restoreWorkbench(project) {
  const stored = normalizeWorkbench(readStoredJson(taskStoreKey(project), null))
  if (stored) return stored
  if (project) return null
  const legacy = readStoredJson('mdreader.plugin.tasks.v1', null)
  const migrated = normalizeWorkbench(legacy)
  if (migrated) return migrated
  const flat = readStoredJson(TABS_KEY, null)
  if (flat && Array.isArray(flat.tabs) && flat.tabs.length) {
    const task = newTaskRecord('默认')
    const tabs = []
    for (const rawTab of flat.tabs) {
      const tab = normalizeTab(rawTab)
      if (tab && !tabs.some((item) => item.id === tab.id)) tabs.push(tab)
    }
    if (!tabs.length) return null
    task.tabs = tabs
    task.activeId = tabs.some((tab) => tab.id === flat.activeId)
      ? flat.activeId
      : tabs[tabs.length - 1].id
    return { tasks: [task], activeTaskId: task.id }
  }
  return null
}

/** Persist one project's workbench (ordered tasks, per-task tabs + active tab). */
function saveWorkbench(project, workbench) {
  if (!workbench || !Array.isArray(workbench.tasks)) return
  const data = {
    activeTaskId: workbench.activeTaskId,
    tasks: workbench.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      activeId: task.activeId,
      tabs: task.tabs.map((tab) => ({
        path: tab.path,
        line: tab.line || 0,
        branch: tab.branch || '',
        commit: tab.commit || '',
        htmlMode: tab.htmlMode === 'source' ? 'source' : 'render',
        navFrom: !!tab.navFrom,
        scroll: recallTabScroll(tabScrollKey(task.id, tab.id)) || tab.scroll || 0,
      })),
    })),
  }
  writeStoredJson(taskStoreKey(project), data)
}

/* -------------------------------------------------------------- chip row UI */

const WORKBENCH_CSS = `
.mdr-taskbar{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:33px;padding:3px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto;overflow-y:hidden}
.mdr-task-chip{display:inline-flex;align-items:center;gap:5px;height:24px;max-width:230px;padding:0 6px 0 8px;border:1px solid transparent;border-left:2px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer;white-space:nowrap;user-select:none;flex:0 0 auto}
.mdr-task-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mdr-task-chip.on{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);border-left-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:500}
.mdr-task-chip.dragging{opacity:.45}
.mdr-task-name{overflow:hidden;text-overflow:ellipsis}
.mdr-task-count{opacity:.6;font-size:11px}
.mdr-task-del{display:inline-flex;align-items:center;justify-content:center;padding:0 2px;border-radius:3px;opacity:.5;font-size:12px;line-height:1}
.mdr-task-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
.mdr-task-new{display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer;flex:0 0 auto}
.mdr-task-new:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.mdr-task-rename{height:22px;width:132px;padding:0 6px;border:1px solid var(--dsw-alias-brand-primary);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}
.mdr-task-tip{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;opacity:.75}
`

/**
 * The 工作台 chip row above the tree: ordered task chips, ＋ 新建, 双击重命名,
 * × 删除, HTML5 drag & drop reorder (drag must not start from the × button).
 */
function WorkbenchBar(props) {
  const { tasks, activeTaskId, onSwitch, onNew, onRename, onDelete, onReorder } = props
  const [editingId, setEditingId] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [draggingId, setDraggingId] = React.useState('')
  const dragRef = React.useRef('')
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      if (typeof inputRef.current.select === 'function') inputRef.current.select()
    }
  }, [editingId])

  const beginRename = (task) => {
    setEditingId(task.id)
    setDraft(task.name)
  }
  const commitRename = () => {
    if (editingId) onRename(editingId, draft)
    setEditingId('')
  }
  const cancelRename = () => setEditingId('')

  const chips = tasks.map((task) => {
    const editing = editingId === task.id
    return h(
      'div',
      {
        key: task.id,
        className:
          'mdr-task-chip' + (task.id === activeTaskId ? ' on' : '') + (draggingId === task.id ? ' dragging' : ''),
        title: editing ? '' : `${task.name}（${task.tabs.length} 个标签页）· 双击重命名 · 拖拽调整顺序`,
        draggable: !editing,
        onClick: () => {
          if (!editing && task.id !== activeTaskId) onSwitch(task.id)
        },
        onDoubleClick: (event) => {
          if (event.target && event.target.closest && event.target.closest('.mdr-task-del')) return
          beginRename(task)
        },
        onDragStart: (event) => {
          if (event.target && event.target.closest && event.target.closest('.mdr-task-del')) {
            event.preventDefault()
            return
          }
          dragRef.current = task.id
          setDraggingId(task.id)
          try {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', task.id)
          } catch {
            // some webviews expose a read-only dataTransfer; drag still reorders
          }
        },
        onDragOver: (event) => {
          if (!dragRef.current || dragRef.current === task.id) return
          event.preventDefault()
          try {
            event.dataTransfer.dropEffect = 'move'
          } catch {
            // ignore
          }
          const rect = event.currentTarget.getBoundingClientRect()
          const before = event.clientX < rect.left + rect.width / 2
          onReorder(dragRef.current, task.id, before)
        },
        onDrop: (event) => event.preventDefault(),
        onDragEnd: () => {
          dragRef.current = ''
          setDraggingId('')
        },
      },
      editing
        ? h('input', {
            ref: inputRef,
            className: 'mdr-task-rename',
            value: draft,
            onClick: (event) => event.stopPropagation(),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            },
            onBlur: commitRename,
          })
        : h('span', { className: 'mdr-task-name' }, task.name),
      h('span', { className: 'mdr-task-count' }, String(task.tabs.length)),
      !editing
        ? h(
            'span',
            {
              className: 'mdr-task-del',
              title: '删除任务（其中的标签页一并关闭，不影响磁盘文件）',
              onClick: (event) => {
                event.stopPropagation()
                onDelete(task.id)
              },
            },
            '×',
          )
        : null,
    )
  })

  return h(
    'div',
    { className: 'mdr-taskbar' },
    h('style', { dangerouslySetInnerHTML: { __html: WORKBENCH_CSS } }),
    chips,
    h('span', { className: 'mdr-task-new', title: '新建任务', onClick: onNew }, '＋'),
    h('span', { className: 'mdr-task-tip' }, '任务 = 一组标签页 · 双击改名'),
  )
}
