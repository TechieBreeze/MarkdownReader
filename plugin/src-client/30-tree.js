/** Directory tree with on-demand loading and persisted expansion. */

function TreeNode(props) {
  const { node, depth, expanded, dirs, failed, activePath, onToggle, onOpen } = props
  const open = node.dir && expanded.has(node.path)
  const children = node.dir && open ? dirs[node.path] : null
  // `dirs[path]` 有值 = 已加载（可能是空数组）；failed[path] = 加载失败。
  // 一直「加载中…」只会出现在请求真的在飞的时候：App 恢复展开态时会主动 loadDir。
  const failedHere = !!(open && failed && failed[node.path])
  const meta = node.dir ? { kind: 'folder', color: 'var(--dsw-alias-label-secondary)' } : fileIcon(node.ext)
  const Icon = Icons[meta.kind]
  const childIndent = { paddingLeft: 18 + depth * 14 }
  let placeholder = null
  if (open && failedHere) {
    placeholder = h('div', { className: 'mdr-tip', style: { ...childIndent, color: 'var(--dsw-alias-state-error-primary)' } }, '加载失败，点目录树右上角刷新重试')
  } else if (open && !children) {
    placeholder = h('div', { className: 'mdr-tip', style: childIndent }, '加载中…')
  } else if (open && children && !children.length) {
    placeholder = h('div', { className: 'mdr-tip', style: childIndent }, '（空目录）')
  }
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
            failed,
            activePath,
            onToggle,
            onOpen,
          }),
        )
      : null,
    placeholder,
  )
}

function Tree(props) {
  const { rootEntries, expanded, dirs, failed, activePath, onToggle, onOpen } = props
  if (!rootEntries) {
    const rootFailed = !!(failed && failed[''])
    return h(
      'div',
      {
        className: 'mdr-tip',
        style: {
          padding: '6px 12px',
          color: rootFailed ? 'var(--dsw-alias-state-error-primary)' : undefined,
        },
      },
      rootFailed ? '目录加载失败，点右上角刷新重试' : '加载中…',
    )
  }
  return h(
    'div',
    null,
    rootEntries.map((node) => h(TreeNode, { key: node.path, node, depth: 0, expanded, dirs, failed, activePath, onToggle, onOpen })),
  )
}
