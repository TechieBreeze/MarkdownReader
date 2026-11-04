/** Tab strip: ordered list of open documents, click to switch, close button. */

const TAB_KIND_LABELS = { code: 'code', html: 'html', image: 'img' }

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
          title:
            tab.path +
            (tab.branch ? ` @ ${tab.branch}` : '') +
            (tab.commit ? ` @ ${String(tab.commit).slice(0, 7)}` : '') +
            (tab.line ? ` · 跳转行 ${tab.line}` : ''),
          onClick: () => onActivate(tab.id),
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
          h(Icons.close, { size: 12 }),
        ),
      ),
    ),
  )
}
