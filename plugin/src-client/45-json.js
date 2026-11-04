/** JSON formatting tool (owned by the search slice). */

function JsonTool(props) {
  const { onClose } = props
  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h(
      'div',
      { className: 'mdr-panel', onClick: (event) => event.stopPropagation() },
      h('div', { className: 'mdr-panel-head' }, h('span', null, 'JSON 工具'), h('span', { className: 'mdr-spacer' }), h('span', { className: 'mdr-btn', onClick: onClose }, '✕')),
      h('div', { className: 'mdr-panel-body' }, h('div', { className: 'mdr-tip', style: { padding: '10px 12px' } }, '该面板由搜索分片实现。')),
    ),
  )
}
