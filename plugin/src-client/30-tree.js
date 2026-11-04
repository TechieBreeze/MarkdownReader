/** Directory tree with on-demand loading and persisted expansion. */

function TreeNode(props) {
  const { node, depth, expanded, dirs, activePath, onToggle, onOpen } = props
  const open = node.dir && expanded.has(node.path)
  const children = node.dir && open ? dirs[node.path] : null
  const meta = node.dir ? { kind: 'folder', color: 'var(--dsw-alias-label-secondary)' } : fileIcon(node.ext)
  const Icon = Icons[meta.kind]
  return h(
    'div',
    null,
    h(
      'div',
      {
        className: 'mdr-tr' + (activePath === node.path ? ' on' : ''),
        style: { paddingLeft: 6 + depth * 14 },
        title: node.path,
        onClick: () => (node.dir ? onToggle(node.path) : onOpen(node.path)),
      },
      h('span', { className: 'mdr-caret' + (open ? ' open' : '') }, node.dir ? '▶' : ''),
      h('span', { className: 'mdr-ticon', style: { color: meta.color } }, h(Icon, { size: 14 })),
      h('span', { className: 'mdr-tname' }, node.name),
    ),
    children
      ? children.map((child) =>
          h(TreeNode, {
            key: child.path,
            node: child,
            depth: depth + 1,
            expanded,
            dirs,
            activePath,
            onToggle,
            onOpen,
          }),
        )
      : null,
    open && !dirs[node.path] ? h('div', { className: 'mdr-tip', style: { paddingLeft: 18 + depth * 14 } }, '加载中…') : null,
  )
}

function Tree(props) {
  const { rootEntries, expanded, dirs, activePath, onToggle, onOpen } = props
  if (!rootEntries) return h('div', { className: 'mdr-tip', style: { padding: '6px 12px' } }, '加载中…')
  return h(
    'div',
    null,
    rootEntries.map((node) => h(TreeNode, { key: node.path, node, depth: 0, expanded, dirs, activePath, onToggle, onOpen })),
  )
}
