/**
 * 同步 / 检查更新 panel — owned by the panels slice.
 *
 * Contract (wired by 50-app.js): h(SyncPanel, { onClose })
 * Host: GET /markdown-reader/api/sync/status[?fetch=1], POST /markdown-reader/api/sync/pull
 *
 * 场景：插件本身也是一个 git 仓库，用一台机器开发、另一台机器点一下拿到最新代码。
 * 两步走：先「检查更新」（只 fetch，只读，显示新提交数量与清单），再由人点
 * 「拉取更新」（会改工作区文件）——破坏性操作永远由人确认。
 * 后端在未配置远程 / 有本地改动 / 非 git 目录时都会返回可读的 reason/error，
 * 这里只负责展示，不做任何猜测或自动重试。
 */

/** Host 侧最多返回 20 条待拉取提交，这里再兜一层。 */
const SYNC_COMMIT_LIMIT = 20

const SYNC_CSS = `
.mdr-sync-panel{width:min(640px,92vw);height:min(80vh,720px);max-height:80vh}
.mdr-sync-head{flex-wrap:wrap;row-gap:6px}
.mdr-sync-title{flex:0 0 auto}
.mdr-sync-sub{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.mdr-sync-body{display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;flex:1;min-height:0}
.mdr-sync-meta{display:flex;flex-direction:column;gap:5px;font-size:12.5px}
.mdr-sync-meta-row{display:flex;gap:8px;align-items:baseline}
.mdr-sync-meta-k{flex:0 0 68px;color:var(--dsw-alias-label-secondary)}
.mdr-sync-meta-v{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:12px;word-break:break-all}
.mdr-sync-meta-v.dim{color:var(--dsw-alias-label-secondary)}
.mdr-sync-status{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px}
.mdr-sync-status.busy{color:var(--dsw-alias-label-secondary)}
.mdr-sync-status.ok{color:#3fb950;border-color:rgba(63,185,80,.38);background:rgba(63,185,80,.08)}
.mdr-sync-status.upd{color:#4a9eff;border-color:rgba(74,158,255,.42);background:rgba(74,158,255,.09)}
.mdr-sync-status.warn{color:#d29922;border-color:rgba(210,153,34,.42);background:rgba(210,153,34,.09)}
.mdr-sync-status.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:rgba(248,81,73,.08)}
.mdr-sync-counts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mdr-sync-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px}
.mdr-sync-pill.upd{color:#4a9eff;border-color:rgba(74,158,255,.42)}
.mdr-sync-pill.warn{color:#d29922;border-color:rgba(210,153,34,.42)}
.mdr-sync-tip{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mdr-sync-note{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-word}
.mdr-sync-note.ok{color:#3fb950;border-color:rgba(63,185,80,.38);background:rgba(63,185,80,.08)}
.mdr-sync-note.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:rgba(248,81,73,.08)}
.mdr-sync-help{padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;line-height:1.65}
.mdr-sync-help code{font-family:"Cascadia Code",Consolas,monospace;font-size:11.5px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.mdr-sync-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;flex:0 0 auto}
.mdr-sync-list-head{padding:6px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.mdr-sync-commit{display:flex;align-items:baseline;gap:8px;padding:5px 10px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mdr-sync-commit:last-child{border-bottom:none}
.mdr-sync-sha{flex:0 0 auto;font-family:"Cascadia Code",Consolas,monospace;font-size:11.5px;color:#4a9eff}
.mdr-sync-msg{flex:1;min-width:0;word-break:break-word;color:var(--dsw-alias-label-primary)}
.mdr-sync-commit-meta{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:44%;overflow:hidden;text-overflow:ellipsis}
.mdr-sync-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.mdr-sync-foot .mdr-spacer{flex:1}
.mdr-sync-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.mdr-sync-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay)}
.mdr-sync-btn:disabled,.mdr-sync-panel .mdr-btn:disabled{opacity:.45;cursor:default}
`

/** Human text for an exception thrown by fetchJson / anything else in an async path. */
function syncErrorText(error) {
  if (!error) return ''
  const message = error && error.message != null ? error.message : error
  const text = String(message == null ? '' : message).trim()
  return text || '未知错误'
}

/** Metadata value with an explicit dash for the unknown case. */
function syncMetaValue(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function SyncPanel(props) {
  const { onClose } = props || {}
  const [data, setData] = React.useState(null)
  const [phase, setPhase] = React.useState('loading') // loading | checking | pulling | ready
  const [error, setError] = React.useState('')
  const [note, setNote] = React.useState('')
  const [noteKind, setNoteKind] = React.useState('info') // info | ok
  const seqRef = React.useRef(0)

  const close = () => {
    if (typeof onClose === 'function') onClose()
  }

  // 打开面板先读「不联网」的本地状态，再让用户主动点「检查更新」——与独立版一致。
  const loadStatus = React.useCallback((withFetch) => {
    const seq = (seqRef.current += 1)
    setPhase(withFetch ? 'checking' : 'loading')
    setError('')
    setNote('')
    fetchJson('/api/sync/status', withFetch ? { fetch: 1 } : null)
      .then((payload) => {
        if (seq !== seqRef.current) return
        setData(payload && typeof payload === 'object' ? payload : null)
        setPhase('ready')
      })
      .catch((err) => {
        if (seq !== seqRef.current) return
        setData(null)
        setError(`读取同步状态失败：${syncErrorText(err)}`)
        setPhase('ready')
      })
  }, [])

  React.useEffect(() => {
    loadStatus(false)
    return () => {
      seqRef.current += 1
    }
  }, [loadStatus])

  const pull = () => {
    const seq = (seqRef.current += 1)
    setPhase('pulling')
    setError('')
    setNote('')
    postJson('/api/sync/pull', {})
      .then((payload) => {
        if (seq !== seqRef.current) return
        if (payload && payload.status && typeof payload.status === 'object') setData(payload.status)
        const changed = !!(payload && payload.changed)
        const base = (payload && payload.note) || (changed ? '已更新' : '已是最新，无需更新')
        if (changed) {
          setNoteKind('ok')
          setNote(
            `${base}\n\n提示：Client 代码需要刷新页面才会加载新版本；Host 代码需要在插件管理器里把本 bundle 禁用再启用，重新加载 Host 模块。`,
          )
        } else {
          setNoteKind('info')
          setNote(base)
        }
        setPhase('ready')
      })
      .catch((err) => {
        if (seq !== seqRef.current) return
        setError(`拉取更新失败：${syncErrorText(err)}`)
        setPhase('ready')
      })
  }

  const busy = phase === 'loading' || phase === 'checking' || phase === 'pulling'
  const status = data && typeof data === 'object' ? data : null
  const configured = !!(status && status.configured)
  const fetched = !!(status && status.fetched)
  const dirty = !!(status && status.dirty)
  const behind = status ? Number(status.behind) || 0 : 0
  const ahead = status ? Number(status.ahead) || 0 : 0
  const commits = status && Array.isArray(status.commits) ? status.commits.slice(0, SYNC_COMMIT_LIMIT) : []
  const reason = status && typeof status.reason === 'string' ? status.reason : ''
  // configured=true 但 fetched=false 且带 reason，只可能是 Host 执行 fetch 失败
  // （未配置远程时走 !configured 分支），必须显式说“检查失败”，不能显示“已是最新”。
  const fetchFailed = configured && !fetched && !!reason
  const canPull = configured && fetched && behind > 0 && !busy

  let lineText = ''
  let lineKind = 'busy'
  if (phase === 'loading') {
    lineText = '正在读取本地同步状态…'
  } else if (phase === 'checking') {
    lineText = '正在连接远程仓库检查更新…'
  } else if (phase === 'pulling') {
    lineText = '正在拉取更新，请稍候…'
  } else if (error) {
    lineText = '操作失败'
    lineKind = 'err'
  } else if (!status) {
    lineText = '尚未读取到同步状态'
  } else if (!configured) {
    lineText = '未配置同步远程仓库'
    lineKind = 'warn'
  } else if (fetchFailed) {
    lineText = '检查更新失败'
    lineKind = 'err'
  } else if (fetched && behind > 0) {
    lineText = `有 ${behind} 个新提交可拉取`
    lineKind = 'upd'
  } else if (fetched) {
    lineText = '已是最新'
    lineKind = 'ok'
  } else {
    lineText = '已读取本地状态，点「检查更新」联网查询远端最新提交'
  }

  const metaRows = [
    ['仓库', status && status.repo],
    ['当前分支', status && status.current],
    ['同步分支', status && status.branch],
    ['远程', status && status.remote],
    ['本地改动', status ? (dirty ? '有未提交改动' : '无') : null],
  ]

  const commitRows = commits.map((commit, index) => {
    const item = commit && typeof commit === 'object' ? commit : {}
    const hash = String(item.short || item.hash || '')
    const subject = String(item.subject || '(无提交说明)')
    const meta = [item.author, item.date].filter((part) => part != null && part !== '').join(' · ')
    return h(
      'div',
      { className: 'mdr-sync-commit', key: hash || `commit-${index}` },
      h('span', { className: 'mdr-sync-sha', title: String(item.hash || hash) }, hash || '—'),
      h('span', { className: 'mdr-sync-msg', title: subject }, subject),
      meta ? h('span', { className: 'mdr-sync-commit-meta', title: meta }, meta) : null,
    )
  })

  const counts = configured
    ? h(
        'div',
        { className: 'mdr-sync-counts' },
        h(
          'span',
          { className: 'mdr-sync-pill' + (fetched && behind > 0 ? ' upd' : '') },
          `落后 ${fetched ? behind : '—'} 条`,
        ),
        h(
          'span',
          { className: 'mdr-sync-pill' + (fetched && ahead > 0 ? ' warn' : '') },
          `领先 ${fetched ? ahead : '—'} 条`,
        ),
        fetched && dirty ? h('span', { className: 'mdr-sync-tip' }, '本地有未提交改动，拉取会被拒绝') : null,
        fetched && ahead > 0 ? h('span', { className: 'mdr-sync-tip' }, '本地提交不会被覆盖') : null,
      )
    : null

  const help = status && !configured
    ? h(
        'div',
        { className: 'mdr-sync-help' },
        `未配置同步远程仓库：${reason || '插件所在 git 仓库没有 origin 远程'}\n` +
          '可以在插件 config（cordis.patch.yml）里设置 syncRepo（远程 URL）与 syncBranch（分支名），' +
          '或为插件所在 git 仓库添加 origin 远程，例如：git remote add origin <url>',
      )
    : null

  return h(
    'div',
    {
      className: 'mdr-overlay',
      onClick: close,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '检查更新',
    },
    h(
      'div',
      { className: 'mdr-panel mdr-sync-panel', onClick: (event) => event.stopPropagation() },
      h('style', { dangerouslySetInnerHTML: { __html: SYNC_CSS } }),
      h(
        'div',
        { className: 'mdr-panel-head mdr-sync-head' },
        h('span', { className: 'mdr-sync-title' }, '检查更新'),
        h('span', { className: 'mdr-sync-sub' }, '从远程仓库拉取插件的最新代码'),
        h('span', { className: 'mdr-spacer' }),
        h(
          'button',
          { type: 'button', className: 'mdr-btn', title: '关闭（Esc）', 'aria-label': '关闭', onClick: close },
          h(Icons.close, { size: 12 }),
        ),
      ),
      h(
        'div',
        { className: 'mdr-panel-body mdr-sync-body' },
        h(
          'div',
          { className: 'mdr-sync-meta' },
          metaRows.map(([key, value]) =>
            h(
              'div',
              { className: 'mdr-sync-meta-row', key },
              h('span', { className: 'mdr-sync-meta-k' }, key),
              h(
                'span',
                { className: 'mdr-sync-meta-v' + (value == null || value === '' ? ' dim' : '') },
                syncMetaValue(value),
              ),
            ),
          ),
        ),
        h('div', { className: 'mdr-sync-status ' + lineKind }, lineText),
        counts,
        help,
        error ? h('div', { className: 'mdr-sync-note err' }, error) : null,
        fetchFailed && !error ? h('div', { className: 'mdr-sync-note err' }, reason) : null,
        dirty && configured
          ? h(
              'div',
              { className: 'mdr-sync-note' },
              '本地有未提交改动：为避免覆盖，拉取会被后端拒绝。请先提交或丢弃这些改动再拉取。',
            )
          : null,
        commits.length
          ? h(
              'div',
              { className: 'mdr-sync-list' },
              h(
                'div',
                { className: 'mdr-sync-list-head' },
                `待拉取提交（最新在上，共 ${commits.length} 条` +
                  (behind > commits.length ? `，还有 ${behind - commits.length} 条未显示` : '') +
                  '）',
              ),
              commitRows,
            )
          : null,
        note ? h('div', { className: 'mdr-sync-note' + (noteKind === 'ok' ? ' ok' : '') }, note) : null,
      ),
      h(
        'div',
        { className: 'mdr-sync-foot' },
        h(
          'button',
          {
            type: 'button',
            className: 'mdr-btn',
            onClick: () => loadStatus(true),
            disabled: busy,
            title: '执行 git fetch 检查远端是否有新提交（只读）',
          },
          phase === 'checking' ? '检查中…' : '检查更新',
        ),
        h('span', { className: 'mdr-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'mdr-btn mdr-sync-btn mdr-sync-btn-primary',
            onClick: pull,
            disabled: !canPull,
            title: fetched && behind > 0 ? `将拉取 ${behind} 个新提交（fast-forward）` : '暂无可拉取的更新',
          },
          phase === 'pulling' ? '拉取中…' : behind > 0 ? `拉取更新（${behind}）` : '拉取更新',
        ),
      ),
    ),
  )
}
