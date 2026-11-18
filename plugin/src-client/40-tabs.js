/**
 * Tab strip: ordered list of open documents, click to switch, close button,
 * drag to reorder.
 *
 * The drag mechanism is deliberately the SAME as the task chips' one
 * (32-workbench.js `WorkbenchBar`): HTML5 drag & drop, `draggable` on the item,
 * the drag id in a ref, the left/right half of the target decides whether the
 * item lands before or after it, and a `.dragging` class dims the item that is
 * being moved. Copy it verbatim rather than reinventing it.
 */

const TAB_KIND_LABELS = { code: 'code', html: 'html', image: 'img' }

/**
 * Translate a WHEEL event over an overflowing tab strip into horizontal scroll.
 *
 * The strip is `overflow-x:auto`, and the browser only maps a vertical wheel to
 * horizontal scrolling while Shift is held - the user asked for a plain wheel
 * to scroll the tabs ("当前是shift+鼠标滚轮才能滚动，但是我需要直接滚动鼠标滚轮也能滚动").
 *
 * @returns {boolean} true when the event was consumed (the caller must
 *   preventDefault, which is why this runs on a NON-passive native listener:
 *   React attaches `wheel` passively, where preventDefault is ignored).
 */
function tabBarWheelScroll(el, event) {
  if (!el || !event) return false
  const max = (Number(el.scrollWidth) || 0) - (Number(el.clientWidth) || 0)
  if (max <= 0) return false // no overflow: leave the wheel alone
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages. Trackpads report pixels.
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Number(el.clientHeight) || 400 : 1
  const dx = (Number(event.deltaX) || 0) * scale
  const dy = (Number(event.deltaY) || 0) * scale
  // A horizontal trackpad gesture wins; a vertical wheel is remapped.
  const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy
  if (!delta) return false
  const next = Math.max(0, Math.min(max, (Number(el.scrollLeft) || 0) + delta))
  if (next === (Number(el.scrollLeft) || 0)) return false // edge: let the page have it
  el.scrollLeft = next
  return true
}

/** Is this event target the tab's close button? (A drag must not start there.) */
function isTabCloseTarget(target) {
  if (!target) return false
  const cls = typeof target.className === 'string' ? target.className : ''
  if (cls.split(/\s+/).includes('mdr-tab-close')) return true
  return typeof target.closest === 'function' && !!target.closest('.mdr-tab-close')
}

function TabBar(props) {
  const { tabs, activeId, onActivate, onClose, onReorder } = props
  const [draggingId, setDraggingId] = React.useState('')
  const dragRef = React.useRef('')
  const barRef = React.useRef(null)

  // Plain mouse wheel scrolls the strip horizontally once the tabs overflow.
  // A native listener is required: React's onWheel is passive, so preventDefault
  // there would be ignored and the page would scroll instead.
  React.useEffect(() => {
    const el = barRef.current
    if (!el || typeof el.addEventListener !== 'function') return undefined
    const onWheel = (event) => {
      if (tabBarWheelScroll(el, event)) event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel, { passive: false })
  }, [])

  const tabsEl = tabs.map((tab) =>
    h(
      'div',
      {
        key: tab.id,
        className:
          'mdr-tab' + (tab.id === activeId ? ' on' : '') + (draggingId === tab.id ? ' dragging' : ''),
        'data-mdr-path': tab.path,
        title:
          tab.path +
          (tab.branch ? ` @ ${tab.branch}` : '') +
          (tab.commit ? ` @ ${String(tab.commit).slice(0, 7)}` : '') +
          (tab.line ? ` · 跳转行 ${tab.line}` : '') +
          ' · 拖拽可调整顺序',
        draggable: true,
        onClick: () => {
          // A drag must not switch the tab.
          if (dragRef.current) return
          onActivate(tab.id)
        },
        onDragStart: (event) => {
          if (isTabCloseTarget(event.target)) {
            event.preventDefault()
            return
          }
          dragRef.current = tab.id
          setDraggingId(tab.id)
          try {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', tab.id)
          } catch {
            // some webviews expose a read-only dataTransfer; drag still reorders
          }
        },
        onDragOver: (event) => {
          if (!dragRef.current || dragRef.current === tab.id) return
          event.preventDefault()
          try {
            event.dataTransfer.dropEffect = 'move'
          } catch {
            // ignore
          }
          const rect = event.currentTarget.getBoundingClientRect()
          const before = event.clientX < rect.left + rect.width / 2
          if (typeof onReorder === 'function') onReorder(dragRef.current, tab.id, before)
        },
        onDrop: (event) => event.preventDefault(),
        onDragEnd: () => {
          dragRef.current = ''
          setDraggingId('')
        },
      },
      h('span', { className: 'mdr-tab-name' }, tab.path.split('/').pop()),
      TAB_KIND_LABELS[tab.kind]
        ? h(
            'span',
            {
              className: 'mdr-tip',
              style: {
                fontSize: 10,
                lineHeight: 1.4,
                padding: '0 4px',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
              },
            },
            TAB_KIND_LABELS[tab.kind],
          )
        : null,
      h(
        'span',
        {
          className: 'mdr-tab-close',
          title: '关闭',
          onClick: (event) => {
            event.stopPropagation()
            onClose(tab.id)
          },
        },
        h(Icons.close, { size: 14 }),
      ),
    ),
  )

  return h(
    'div',
    { className: 'mdr-tabbar', ref: barRef },
    tabs.length === 0 ? h('div', { className: 'mdr-tip', style: { padding: '6px 4px' } }, '未打开文件') : null,
    tabsEl,
  )
}
