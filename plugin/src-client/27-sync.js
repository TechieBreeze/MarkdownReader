/**
 * 同步 / 检查更新 panel — owned by the panels slice.
 *
 * Contract (wired by 50-app.js): h(SyncPanel, { onClose })
 * Host: GET /markdown-reader/api/sync/status?fetch=1, POST /markdown-reader/api/sync/pull
 */
function SyncPanel(props) {
  const { onClose } = props
  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h('div', { className: 'mdr-panel', onClick: (event) => event.stopPropagation() }, '同步面板由 panels 分片实现'),
  )
}
