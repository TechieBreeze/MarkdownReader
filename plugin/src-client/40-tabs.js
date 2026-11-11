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
    { className: 'mdr-tabbar' },
    tabs.length === 0 ? h('div', { className: 'mdr-tip', style: { padding: '6px 4px' } }, '未打开文件') : null,
    tabsEl,
  )
}
