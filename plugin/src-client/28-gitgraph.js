/**
 * Git 版本树 modal — owned by the panels slice.
 *
 * Contract (wired by 50-app.js): h(GitGraphModal, { path, onClose, onOpen })
 *   path: active tab path (or a repo info) to resolve the repository
 *   onOpen(path, commit?) opens a file/commit in a tab
 * Host: GET /api/git/repos, GET /api/git/graph?path=&limit=
 */
function GitGraphModal(props) {
  const { onClose } = props
  return h(
    'div',
    { className: 'mdr-overlay', onClick: onClose },
    h('div', { className: 'mdr-panel', onClick: (event) => event.stopPropagation() }, '版本树由 panels 分片实现'),
  )
}
