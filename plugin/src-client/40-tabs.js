/** Tab strip: ordered list of open documents, click to switch, close button. */

function TabBar(props) {
  const { tabs, activeId, onActivate, onClose } = props
  return h(
    'div',
    { className: 'mdr-tabbar' },
    tabs.length === 0 ? h('div', { className: 'mdr-tip', style: { padding: '6px 4px' } }, '未打开文件') : null,
    tabs.map((tab) =>
      h(
        'div',
        {
          key: tab.id,
          className: 'mdr-tab' + (tab.id === activeId ? ' on' : ''),
          title: tab.path,
          onClick: () => onActivate(tab.id),
        },
        h('span', { className: 'mdr-tab-name' }, tab.path.split('/').pop()),
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
          h(Icons.close, { size: 12 }),
        ),
      ),
    ),
  )
}
