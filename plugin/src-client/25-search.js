/** Global search panel + quick open (owned by the search slice). */

function SearchPanel(props) {
  const { mode, onClose } = props
  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h(
      'div',
      { className: 'mdr-panel', onClick: (event) => event.stopPropagation() },
      h('div', { className: 'mdr-panel-head' }, h('span', null, mode === 'files' ? '快速打开' : '搜索'), h('span', { className: 'mdr-spacer' }), h('span', { className: 'mdr-btn', onClick: onClose }, '✕')),
      h('div', { className: 'mdr-panel-body' }, h('div', { className: 'mdr-tip', style: { padding: '10px 12px' } }, '该面板由搜索分片实现。')),
    ),
  )
}
