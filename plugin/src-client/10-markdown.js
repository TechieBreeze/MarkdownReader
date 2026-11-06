/** Markdown rendering: marked -> DOM -> jumps (code/md/html/image/git links), hljs. */

const REPO_BLOB_MARKERS = ['/-/blob/', '/blob/', '/-/raw/', '/raw/']

function looksLikePath(text) {
  if (!text || text.length > 260) return false
  if (/^[a-z]+:\/\//i.test(text)) return false
  if (/\s/.test(text)) return false
  if (!/\.[a-z0-9]{1,10}$/i.test(text)) return false
  return true
}

function findLineToken(anchor) {
  let node = anchor.nextSibling
  while (node && node.nodeType === 3 && !node.textContent.trim()) node = node.nextSibling
  if (node && node.nodeType === 1 && node.tagName === 'CODE' && /^\d+$/.test(node.textContent.trim())) {
    return { node, line: Number(node.textContent.trim()) }
  }
  return null
}

function isRepoBlobUrl(href) {
  if (!/^https?:\/\//i.test(href)) return false
  return REPO_BLOB_MARKERS.some((marker) => href.includes(marker))
}

/**
 * Tab kind for a resolved path. Ordered so `.html` is a rendered tab (not
 * source), images preview, markdown stays markdown, everything else code.
 */
function linkKindFor(resolved) {
  const ext = extOf(resolved)
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (isImageFile(resolved)) return 'image'
  if (isCodeFile(resolved)) return 'code'
  return ''
}

function appendLineBadge(anchor, line) {
  if (line == null) return
  anchor.dataset.line = String(line)
  const badge = document.createElement('span')
  badge.className = 'mdr-badge'
  badge.textContent = String(line)
  anchor.appendChild(badge)
}

function parseBranchCommit(query) {
  const result = { branch: '', commit: '' }
  if (!query) return result
  let params
  try {
    params = new URLSearchParams(query)
  } catch {
    return result
  }
  const branch = params.get('branch') || params.get('ref') || ''
  const commit = params.get('commit') || params.get('sha') || ''
  if (branch && /^[A-Za-z0-9._/-]+$/.test(branch)) result.branch = branch
  if (commit && /^[A-Za-z0-9._/-]+$/.test(commit)) result.commit = commit
  return result
}

/** Attach the data-* contract that 50-app.js routes on. */
function applyLocalLink(anchor, resolved, line, branch, commit) {
  const kind = linkKindFor(resolved)
  if (!kind) return
  anchor.dataset.path = resolved
  anchor.dataset.kind = kind
  if (line != null) anchor.dataset.line = String(line)
  if (branch) anchor.dataset.branch = branch
  if (commit) anchor.dataset.commit = commit
  const suffix = (line != null ? ` :${line}` : '') + (branch ? `（${branch} 版本）` : '')
  if (kind === 'code') {
    anchor.classList.add('mdr-jump')
    anchor.removeAttribute('href')
    anchor.title = `${resolved}${suffix}（点击弹窗；Ctrl/Cmd+点击开为标签页）`
    appendLineBadge(anchor, line)
  } else {
    anchor.classList.add('mdr-local-link')
    anchor.removeAttribute('href')
    anchor.title = `${resolved}${suffix}`
    if (kind === 'md') {
      anchor.removeAttribute('target')
      anchor.classList.add('mdr-md-link')
    }
  }
}

function enhanceMarkdown(container, mdPath, multi, rootNames) {
  // The diff fence renders in the CLIENT, so "the block did not render" can
  // only be answered by the client: how many fences it saw, how many became
  // diff views, how long it took. The Host keeps the last report.
  const renderStarted = performance.now()
  let fenceCount = 0
  let diffCount = 0
  let renderError = ''
  const report = () => {
    if (typeof reportMdRender !== 'function') return
    reportMdRender({
      path: mdPath,
      fences: fenceCount,
      diffBlocks: diffCount,
      ms: Math.round(performance.now() - renderStarted),
      error: renderError,
    })
  }
  // 1) local images -> raw endpoint
  container.querySelectorAll('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || ''
    if (/^(https?:|data:)/i.test(raw)) return
    const { path: href } = splitHref(raw)
    let decoded = href
    try {
      decoded = decodeURIComponent(href)
    } catch {
      decoded = href
    }
    const resolved = resolveRel(mdPath, decoded, multi, rootNames)
    img.src = `${ROUTE}/api/raw?path=${encodeURIComponent(resolved)}`
    img.loading = 'lazy'
    img.alt = img.alt || ''
  })

  // 2) anchors: repository links are resolved in a batch below; everything else
  //    is classified locally into md/code/html/image jumps.
  const repoLinks = []
  for (const anchor of [...container.querySelectorAll('a[href]')]) {
    const raw = anchor.getAttribute('href') || ''
    if (isRepoBlobUrl(raw)) {
      // Keep the remote href: Shift+click / right-click stay native. Styled like
      // the original tool's repository links while the local target is resolved.
      anchor.classList.add('mdr-jump', 'mdr-repo-link')
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.title = '在仓库中新标签页打开（正在解析本地文件…）'
      repoLinks.push({ anchor, url: raw })
      continue
    }
    if (/^(https?:|mailto:)/i.test(raw)) {
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      continue
    }
    if (raw.startsWith('#')) continue
    const { path: beforeHash, hash } = splitHref(raw)
    const queryAt = beforeHash.indexOf('?')
    const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1)
    const cleanHref = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt)
    let decoded = cleanHref
    try {
      decoded = decodeURIComponent(cleanHref)
    } catch {
      decoded = cleanHref
    }
    const resolved = resolveRel(mdPath, decoded, multi, rootNames)
    const extra = parseBranchCommit(query)
    let line = null
    const token = findLineToken(anchor)
    if (token) {
      line = token.line
      token.node.classList.add('mdr-line-token')
    }
    if (line == null && /^L\d+$/.test(hash)) line = Number(hash.slice(1))
    applyLocalLink(anchor, resolved, line, extra.branch, extra.commit)
  }

  // 2b) resolve remote repo-view links to local workspace files
  if (repoLinks.length) {
    const unique = [...new Set(repoLinks.map((item) => item.url))]
    fetchJson('/api/git/resolve', { url: unique, path: mdPath })
      .then((payload) => {
        const map = (payload && payload.resolved) || {}
        for (const item of repoLinks) {
          const hit = map[item.url]
          if (!hit || !hit.path) continue
          const anchor = item.anchor
          anchor.classList.add('mdr-jump')
          anchor.classList.remove('mdr-repo-link')
          anchor.dataset.path = hit.path
          anchor.dataset.kind = linkKindFor(hit.path) || 'code'
          if (hit.line) {
            anchor.dataset.line = String(hit.line)
            appendLineBadge(anchor, hit.line)
          }
          if (hit.refExists && hit.ref) anchor.dataset.branch = hit.ref
          // Keep href so Shift+click / right-click / copy-link still reach the
          // repository page; plain click is routed in-app by 50-app.js.
          anchor.title =
            `打开本地代码: ${hit.path}${hit.line ? ' :' + hit.line : ''}` +
            (hit.refExists && hit.ref ? `（${hit.ref} 版本）` : '') +
            '（Shift+点击 / 右键打开仓库原链接）'
        }
      })
      .catch(() => {})
  }

  // 3) bare backtick paths become links when the file actually resolves
  const candidates = []
  for (const code of container.querySelectorAll('code')) {
    if (code.closest('a') || code.closest('pre')) continue
    const text = (code.textContent || '').trim()
    if (!looksLikePath(text)) continue
    candidates.push({ code, text })
  }
  if (candidates.length) {
    const unique = [...new Set(candidates.map((item) => item.text))]
    // `from` lets the Host prefer THIS document's project root when the same
    // basename exists in several opened projects.
    fetchJson('/api/exists', { path: unique, from: mdPath })
      .then((payload) => {
        const results = (payload && payload.results) || {}
        for (const item of candidates) {
          const hit = results[item.text]
          if (!hit || !hit.exists || !hit.abs) continue
          const anchor = document.createElement('a')
          anchor.className = 'mdr-jump'
          anchor.dataset.path = hit.abs
          anchor.dataset.kind = linkKindFor(hit.abs) || 'code'
          anchor.title = hit.abs
          anchor.textContent = item.text
          item.code.textContent = ''
          item.code.appendChild(anchor)
        }
      })
      .catch(() => {})
  }

  // 4) fenced code blocks -> the SAME pipeline as the code view (hljs language
  //    aliases + Java/Kotlin post passes), sliced so a doc with hundreds of
  //    blocks does not block the main thread.
  const fenceBlocks = []
  for (const code of container.querySelectorAll('pre > code')) {
    const match = /language-([\w+-]+)/.exec(code.className || '')
    const lang = match ? match[1] : ''
    if (lang === 'mermaid') {
      code.dataset.mermaidSource = code.textContent || ''
      code.innerHTML = '<span class="mdr-mermaid-note">▦ mermaid 图 · 滚动到可见时渲染</span>'
      continue
    }
    fenceBlocks.push({ code, lang })
  }
  fenceCount = fenceBlocks.length
  if (fenceBlocks.length) {
    let index = 0
    // Run the slices on IDLE time with a small budget.
    // A document with ~90 fences (plus the diff fences, which highlight two
    // sides each) otherwise monopolises the main thread in 60ms chunks: the
    // page stopped responding exactly where a mermaid diagram rendered (its
    // parse+layout is a long task of its own), which the user reported as
    // "卡在 §10 时序与协作 那个 mermaid 图前后".
    const schedule =
      typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? (fn) => window.requestIdleCallback(fn, { timeout: 400 })
        : (fn) => window.setTimeout(fn, 16)
    const step = () => {
      const started = performance.now()
      for (; index < fenceBlocks.length; index += 1) {
        const { code, lang } = fenceBlocks[index]
        const source = code.textContent || ''
        if (typeof isDiffFenceLang === 'function' && isDiffFenceLang(lang)) {
          // ```diff → the commit-diff view inside the document: the code part
          // only, highlighted with the language of the file the diff belongs
          // to, added rows green and deleted rows red + strike-through.
          try {
            const html = typeof renderDiffFenceHtml === 'function' ? renderDiffFenceHtml(source) : escapeHtml(source)
            if (typeof ensureFenceCss === 'function') ensureFenceCss()
            const wrap = document.createElement('div')
            wrap.className = 'mdr-md-diff'
            wrap.innerHTML = html
            const pre = code.parentElement
            if (pre && pre.parentNode) pre.parentNode.replaceChild(wrap, pre)
            else code.innerHTML = html
            diffCount += 1
          } catch {
            code.innerHTML = escapeHtml(source)
            renderError = 'diff fence failed: ' + String(source && source.slice(0, 40))
          }
        } else {
          try {
            code.innerHTML =
              typeof renderFenceCodeHtml === 'function'
                ? renderFenceCodeHtml(source, lang)
                : escapeHtml(source)
            code.classList.add('hljs')
          } catch {
            code.innerHTML = escapeHtml(source)
          }
        }
        if (performance.now() - started > 12) {
          index += 1
          break
        }
      }
      if (index < fenceBlocks.length) schedule(step)
      else report()
    }
    schedule(step)
  } else {
    report()
  }

  // 5) mermaid fences are rendered lazily by the mermaid slice
  try {
    enhanceMermaid(container)
  } catch {
    // mermaid rendering must never break the document
  }
}

/**
 * Restore a saved markdown scroll offset, re-applying it while lazy content
 * (mermaid diagrams, images) grows the document. Stops the moment the user
 * scrolls/wheels/keys by themselves.
 */
function restoreMarkdownScroll(scroller, target) {
  if (!scroller || !target) return () => {}
  let cancelled = false
  let userMoved = false
  const markUser = () => {
    userMoved = true
  }
  const apply = () => {
    if (cancelled || userMoved) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = Math.min(target, max)
  }
  scroller.addEventListener('wheel', markUser, { passive: true })
  scroller.addEventListener('touchstart', markUser, { passive: true })
  scroller.addEventListener('keydown', markUser)
  apply()
  const timers = [200, 500, 900, 1400, 2000, 2800].map((ms) => setTimeout(apply, ms))
  return () => {
    cancelled = true
    timers.forEach((timer) => clearTimeout(timer))
    scroller.removeEventListener('wheel', markUser)
    scroller.removeEventListener('touchstart', markUser)
    scroller.removeEventListener('keydown', markUser)
  }
}

function MarkdownView(props) {
  const { tab, multi, rootNames } = props
  const boxRef = React.useRef(null)
  const [error, setError] = React.useState('')
  const scrollKey = `md:${tab.path}`

  // Persist while visible. No save on cleanup: by then the tab may already be
  // replaced/switched (scrollTop clamped to 0) and would overwrite the good
  // value. App saves explicitly before switching and on beforeunload.
  React.useEffect(() => {
    const box = boxRef.current
    const scroller = box ? box.closest('.mdr-content') : null
    if (!scroller) return undefined
    const save = () => scrollStorage.set(scrollKey, scroller.scrollTop)
    scroller.addEventListener('scroll', save, { passive: true })
    return () => scroller.removeEventListener('scroll', save)
  }, [scrollKey])

  React.useEffect(() => {
    let cancelled = false
    let disposeRestore = () => {}
    ensureVendor()
      .then(() => {
        if (cancelled || !boxRef.current) return
        try {
          const html = window.marked.parse(String(tab.content == null ? '' : tab.content), {
            gfm: true,
            breaks: false,
            mangle: false,
            headerIds: false,
          })
          boxRef.current.innerHTML = html
          enhanceMarkdown(boxRef.current, tab.path, multi, rootNames)
          setError('')
          const scroller = boxRef.current.closest('.mdr-content')
          const target = scrollStorage.get(scrollKey)
          if (target > 0) disposeRestore = restoreMarkdownScroll(scroller, target)
          else if (scroller) scroller.scrollTop = 0
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      })
      .catch((err) => setError(String((err && err.message) || err)))
    return () => {
      cancelled = true
      disposeRestore()
    }
  }, [tab.id, tab.content, tab.path, multi, rootNames, scrollKey])

  return h(
    'div',
    { className: 'mdr-md-wrap' },
    error ? h('div', { className: 'mdr-err' }, error) : null,
    h('div', { className: 'mdr-md', ref: boxRef }),
  )
}
