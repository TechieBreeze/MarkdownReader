/** Code tab: VSCode-Dark+-style line-numbered viewer with hljs colors. */

const LANG_MAP = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'xml',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.properties': 'ini',
  '.toml': 'ini',
  '.sql': 'sql',
  '.sh': 'bash',
  // the vendored hljs common bundle has no 'dos' grammar: shell is the closest
  // (the standalone reader mapped bat -> bash for the same reason).
  '.bat': 'bash',
  '.cmd': 'bash',
  '.ps1': 'powershell',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.gradle': 'groovy',
  '.md': 'markdown',
}

function langForPath(rel) {
  return LANG_MAP[extOf(rel)] || ''
}

/* ================= 代码高亮统一管线 =================
   Ported from the standalone reader (input/reference/index.html):
     highlightCodeHtml → hljs 高亮 + Java/Kotlin 类型增强 → HTML 字符串
     highlightToLines  → HTML 字符串 → 每行 HTML（跨行注释/字符串不切坏 + Java/Kotlin 标识符补色）
   整文件只做一次 hljs（virtual scroll 下也只算一次），按行重建时保持多行 token 的
   span 在每行上开闭，所以多行注释/字符串的每一行颜色都正确。

   与 per-line hljs 的差别（用户报的 bug）：
     · per-line 把 `/* …` 与 `… *​/` 各自当独立文本 → 整段注释/字符串不上色；
     · hljs 的 Java/Kotlin 语法只给「带赋值的声明」识别类型，静态调用点、无初始化声明、
       字段/返回类型、泛型实参、方法调用名、变量/字段引用全留白 → 靠下面两个后处理补色。 */

/* Java/Kotlin？这两种语言额外做类型增强与标识符补色 */
function isJavaKtLang(lang) {
  return lang === 'java' || lang === 'kotlin' || lang === 'kt'
}

/* Java/Kotlin 类型增强（VSCode Dark+ 观感）：hljs 的 Java/Kotlin 语法只对
   「带赋值的声明」识别类型（hljs-type），静态调用点（JSONObject.parseObject）、
   无初始化声明、字段/返回类型里的类名都不高亮。
   精确增强（只补类型语义位置，统一用 hljs-type 类型色，不碰已高亮的 token，
   不误伤字符串/注释/常量）：
     · 后跟 . 或 空白 → 类名（静态调用 / 声明 / 返回类型）
     · 后跟 < → 泛型「头」（List<…> 的 List、OutputDTO<…> 的 OutputDTO）
     · 泛型 <Type>（hljs 会把 < 转义成 HTML 实体）
     · 逗号后的泛型实参（Map<Long, Boolean> 里的 Boolean）
   排除全大写标识符（常量/枚举），排除已被 span 包裹的内容。
   注：正则里的 \x26lt; 表示「&」+「lt;」两个字符（即 < 的 HTML 实体），
   「&」写成 \x26 是为了避免它在源码里被当成 HTML 实体起始。 */
function enhanceJavaKtTypes(html) {
  return html.replace(
    /<span[^>]*>[\s\S]*?<\/span>|\b[A-Z]\w*\b(?=\.)|\b[A-Z]\w*\b(?=\s)|\b[A-Z]\w*\b(?=\s*\x26lt;)|(?<=<|\x26lt;)\b[A-Z]\w*\b|,\s*(\b[A-Z]\w*\b)/g,
    (m, g1) => {
      if (m.startsWith('<span')) return m
      if (g1) {
        // 逗号后的泛型实参：Map<Long, Boolean> 里的 Boolean
        if (!/[a-z]/.test(g1)) return m // 全大写 → 常量/枚举，跳过
        const head = m.slice(0, m.length - g1.length)
        return head + `<span class="hljs-type">${g1}</span>`
      }
      if (!/[a-z]/.test(m)) return m // 全大写常量/枚举 → 跳过
      return `<span class="hljs-type">${m}</span>`
    },
  )
}

/* Java/Kotlin 关键字（含基本类型）—— 标识符补色与参数列表识别共用 */
const JAVA_KW = (function () {
  const set = {}
  ;(
    'abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends final finally float for goto if implements import instanceof int interface ' +
    'long native new package private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while true false null var record ' +
    'sealed permits yield module requires exports opens uses provides to transitive ' +
    'as break by catch class companion const constructor crossinline data dynamic enum expect ' +
    'external final infix init inline inner internal lateinit noinline open operator out override ' +
    'private protected public reified sealed suspend tailrec vararg actual abstract annotation ' +
    'fun val typeof typealias when where in is object'
  )
    .split(' ')
    .forEach((keyword) => {
      set[keyword] = 1
    })
  return set
})()

/* Java/Kotlin 标识符补色：hljs 不标方法调用名与变量/字段引用。
   只处理「未被任何 span 包裹」的纯文本标识符（绝无双重包裹）：
   · xxx.yyy( 的 yyy / 独立的 yyy( → hljs-title function_（函数名色）
   · 其余小写开头标识符（变量/字段/参数引用）→ hljs-variable（变量色）
   显式排除 Java/Kotlin 关键字与字面量、PascalCase 类型/全大写常量；
   字符串/注释/数字已被 hljs 包裹（classes 非空），不会走到这里，本函数也不匹配数字。
   inImport=true（import 语句里的包路径）：PascalCase 段是**类名** → 类型色。
   返回 token 数组而不是拼好的 HTML：调用方负责转义与拼接。 */
function hljsPostProcJavaKtTokens(txt, inImport) {
  const out = []
  let last = 0
  const re = /\b[A-Za-z_$][\w$]*\b/g
  let match
  while ((match = re.exec(txt)) !== null) {
    const word = match[0]
    if (JAVA_KW[word]) continue // 关键字/字面量 → 不动
    let cls
    if (/^[A-Z]/.test(word)) {
      if (/[a-z]/.test(word)) {
        if (!inImport) continue // PascalCase → 类型归类型增强管
        cls = 'hljs-type' // import 路径里的类名 → 类型
      } else {
        cls = 'hljs-constant' // 全大写 → 常量/枚举值（枚举值要能点）
      }
    } else {
      cls = txt.charAt(match.index + word.length) === '(' ? 'hljs-title function_' : 'hljs-variable'
    }
    if (match.index > last) out.push({ cls: '', txt: txt.slice(last, match.index) })
    out.push({ cls, txt: word })
    last = match.index + word.length
  }
  if (last < txt.length) out.push({ cls: '', txt: txt.slice(last) })
  return out
}

/* 这个文本节点是不是 import 语句里的包路径？
   判据：前一个兄弟节点是 import/static 关键字 span（hljs 只把关键字包成 span）。 */
function isImportPathText(node) {
  let prev = node.previousSibling
  while (prev && prev.nodeType === 3 && !prev.textContent.trim()) prev = prev.previousSibling
  if (!prev || prev.nodeType !== 1) return false
  const text = (prev.textContent || '').trim()
  if (text === 'import') return true
  if (text === 'static') {
    let before = prev.previousSibling
    while (before && before.nodeType === 3 && !before.textContent.trim()) before = before.previousSibling
    return !!before && before.nodeType === 1 && (before.textContent || '').trim() === 'import'
  }
  return false
}

/* Java/Kotlin 参数列表里的标识符。
   背景：hljs 把整个参数列表塞进一个 <span class="hljs-params">(…)</span>，
   而类型增强是「整段 span 跳过」→ 参数里的类型既没上色、也不是独立 token。
   这里在按行重建时单独识别：
     · PascalCase（首字母大写且含小写）→ 类型（hljs-type）
     · 全大写 → 常量/枚举 → 不动
     · 关键字/基本类型 → 关键字色（hljs-keyword）
     · 其余小写标识符 → 参数名（hljs-variable） */
function hljsParamTokens(txt) {
  const out = []
  let last = 0
  const re = /\b[A-Za-z_$][\w$]*\b/g
  let match
  while ((match = re.exec(txt)) !== null) {
    const word = match[0]
    let cls = ''
    if (/^[A-Z]/.test(word)) {
      if (/[a-z]/.test(word)) cls = 'hljs-type' // PascalCase → 类型
    } else if (JAVA_KW[word]) {
      cls = 'hljs-keyword' // 关键字 / 基本类型
    } else {
      cls = 'hljs-variable' // 参数名
    }
    if (!cls) continue
    if (match.index > last) out.push({ cls: '', txt: txt.slice(last, match.index) })
    out.push({ cls, txt: word })
    last = match.index + word.length
  }
  if (last < txt.length) out.push({ cls: '', txt: txt.slice(last) })
  return out
}

/* hljs 高亮 → HTML 字符串（未收录语言 / 高亮异常 → 转义后的原文） */
function highlightCodeHtml(content, lang) {
  const lib = typeof window !== 'undefined' ? window.hljs : null
  const source = String(content == null ? '' : content)
  const name = lang && lib && typeof lib.getLanguage === 'function' && lib.getLanguage(lang) ? lang : ''
  if (!lib || !name) return escapeHtml(source)
  let html
  try {
    html = lib.highlight(source, { language: name, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(source)
  }
  if (isJavaKtLang(lang)) html = enhanceJavaKtTypes(html)
  return html
}

/* HTML 字符串 → 每行 HTML（按行重建 DOM，跨行 token 保持正确）
   · 文本节点是【解码后】的内容（HTML 实体已还原成 < > 等字符），
     重新拼回 HTML 时必须再转义一次，否则 < 会被浏览器当成标签开头。
   · Java/Kotlin：未被 span 包裹的纯文本 → 补方法调用名与变量/字段引用；
     参数列表（hljs-params 里的纯文本）→ 补类型与参数名。 */
function highlightToLines(html, isJavaKt) {
  const tmpl = document.createElement('template')
  tmpl.innerHTML = html
  const lines = []
  let current = []
  lines.push(current)
  function walk(node, classes) {
    if (node.nodeType === 3) {
      // text node：取出跨行文本逐行切开
      const parts = node.textContent.split('\n')
      const inParams = isJavaKt && classes.length && classes[classes.length - 1] === 'hljs-params'
      const inImport = isJavaKt && !classes.length && isImportPathText(node)
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          current = []
          lines.push(current)
        }
        if (parts[index] !== '') {
          const tokens = isJavaKt
            ? inParams
              ? hljsParamTokens(parts[index])
              : !classes.length
                ? hljsPostProcJavaKtTokens(parts[index], inImport)
                : [{ cls: '', txt: parts[index] }]
            : [{ cls: '', txt: parts[index] }]
          for (const token of tokens) {
            current.push({ cls: classes.concat(token.cls ? token.cls.split(' ') : []), txt: escapeHtml(token.txt) })
          }
        }
      }
    } else if (node.nodeType === 1 || node.nodeType === 11) {
      // 保留 title 的语义子类（class_/function_/inherited__/invoke__），
      // 使函数名与类名在配色下可区分
      const cls = String(node.className || '')
        .split(' ')
        .filter(
          (one) =>
            one.startsWith('hljs-') || one === 'class_' || one === 'function_' || one === 'inherited__' || one === 'invoke__',
        )
      const childClasses = classes.concat(cls)
      for (const child of node.childNodes || []) walk(child, childClasses)
    }
  }
  walk(tmpl.content, [])
  return lines.map((tokens) =>
    tokens.map((token) => (token.cls.length ? `<span class="${token.cls.join(' ')}">${token.txt}</span>` : token.txt)).join(''),
  )
}

/** One line's highlighted HTML through the same whole-line pipeline (kept for other views). */
function highlightLineHtml(text, lang) {
  try {
    const lines = highlightByLine(String(text == null ? '' : text), lang || 'plaintext')
    return (lines && lines[0]) || ' '
  } catch {
    return escapeHtml(text) || ' '
  }
}

/* 整文件一次 hljs → 按行切分。开销是文件长度线性的一次调用（虚拟滚动也只是
   一次；不再 per-row 独立高亮），并按下述内容哈希缓存，切回标签页不重复算。 */
function highlightByLine(content, lang) {
  return highlightToLines(highlightCodeHtml(content, lang), isJavaKtLang(lang))
}

/** 高亮结果缓存：key = lang + 内容哈希（整文件一次高亮的结果按文件缓存）。 */
const HIGHLIGHT_CACHE_MAX = 8
const highlightCache = new Map()

function textHash(value) {
  const text = String(value)
  // FNV-1a 32-bit，包含长度，避免不同内容同 key
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16)
}

function highlightLinesCached(content, lang) {
  const text = String(content == null ? '' : content)
  const key = `${lang || ''}\u0000${text.length}\u0000${textHash(text)}`
  const hit = highlightCache.get(key)
  if (hit) {
    // LRU：命中后挪到末尾
    highlightCache.delete(key)
    highlightCache.set(key, hit)
    return hit
  }
  let lines
  try {
    lines = highlightByLine(text, lang)
  } catch {
    lines = text.split('\n').map((one) => escapeHtml(one))
  }
  highlightCache.set(key, lines)
  while (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value
    highlightCache.delete(oldest)
  }
  return lines
}

/* -------------------------------------------------------------- code scroll */

/**
 * Per-file scroll positions of the code viewport, shared by all mounted code
 * views. The reported bug was "switch tab and the code scroll jumps back to the
 * top / to the link line", so the position is persisted per file and restored on
 * remount — an *explicit* jump request (open a link with a line number, or an
 * already-open tab that gets a new line) still wins over the memory.
 */
const CODE_SCROLL_KEY = 'mdreader.plugin.codescroll.v1'

/** file key -> line that was explicitly jumped to this session (restore vs jump). */
const codeJumpSeen = new Map()

const codeScrollStore = (() => {
  const MAX_ENTRIES = 400
  let data = null
  let timer = 0
  const read = () => {
    if (data) return data
    data = {}
    try {
      const value = JSON.parse(localStorage.getItem(CODE_SCROLL_KEY) || '{}')
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          const top = Number(value[key])
          if (Number.isFinite(top) && top > 0) data[key] = Math.round(top)
        }
      }
    } catch {
      data = {}
    }
    return data
  }
  const flush = () => {
    timer = 0
    try {
      const keys = Object.keys(data || {})
      // Bounded store: drop the oldest inserted entries first.
      for (let index = 0; index < keys.length - MAX_ENTRIES; index += 1) delete data[keys[index]]
      localStorage.setItem(CODE_SCROLL_KEY, JSON.stringify(data || {}))
    } catch {
      // quota / private mode: the in-memory map still works for this session
    }
  }
  return {
    get(key) {
      const top = read()[String(key)]
      return typeof top === 'number' ? top : 0
    },
    save(key, top) {
      const value = Number(top)
      const name = String(key)
      const map = read()
      if (!Number.isFinite(value) || value <= 0) delete map[name]
      else map[name] = Math.round(value)
      if (!timer) timer = setTimeout(flush, 250)
    },
  }
})()

/** One row's HTML. diffMode adds the +/- gutter sign and diff row classes. */
function gitRowHtml(row, index, lang, diffMode, hitIndex, codeHtml, top) {
  const classes = ['mdr-cl']
  if (row.kind === 'add') classes.push('mdr-git-add')
  else if (row.kind === 'del') classes.push('mdr-git-del')
  else if (row.kind === 'ctx') classes.push('mdr-git-ctx')
  // 跳转行持久高亮：只有确实落在这一行（row index）才加 .hit；删除行不加
  // （旧文件行号与当前渲染的新版本文本错位，标上去反而误导）。
  if (hitIndex != null && hitIndex >= 0 && index === hitIndex && row.kind !== 'del') classes.push('hit')
  const sign = row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  '
  const gutter = diffMode ? sign : '  '
  const style = top == null ? '' : ` style="top:${top}px"`
  const no = row.no == null ? '' : row.no
  return `<div class="${classes.join(' ')}" data-line="${no}"${style}><span class="mdr-cl-no">${no}</span><span class="mdr-cl-code">${gutter}${codeHtml}</span></div>`
}

/**
 * Rows + diff flag for the current git view of a file. Shared by the code tab
 * and the code modal so branch/commit rendering can never drift apart.
 */
function useCodeRows(view, workspaceContent) {
  // "◎ branch 最新" shows the selected branch's own HEAD file when it was fetched
  // (branch switches), otherwise the workspace content the App loaded.
  const baseContent = view.branchContent != null ? view.branchContent : workspaceContent
  const diffRows = React.useMemo(
    () => (view.commit && view.hunks && view.hunks.length ? buildDiffRows(view.fileLines, view.hunks) : null),
    [view.commit, view.hunks, view.fileLines],
  )
  const rows = React.useMemo(() => {
    if (diffRows) return diffRows
    return String(baseContent == null ? '' : baseContent)
      .split('\n')
      .map((text, index) => ({ no: index + 1, kind: 'plain', text }))
  }, [diffRows, baseContent])
  return { rows, diffMode: !!diffRows, baseContent }
}

/**
 * Rows viewport. Files over GIT_V_THRESHOLD rows keep full highlighting but only
 * paint the viewport +/- GIT_BUFFER rows (20px absolute rows inside a spacer).
 *
 * Props (code tab + modal):
 *   scrollKey      file key for the persisted scroll memory (omit = no persistence)
 *   contentReady   false while the file text is still loading: defer the
 *                  jump/restore decision instead of deciding against 1 empty row
 *   restoreScroll  { top } — exactly restore this position (modal ← 返回), takes
 *                  precedence over the line jump and the scroll memory
 *   jumpHover      Java/Kotlin: add `.jump-hover` so Ctrl+clickable tokens get the
 *                  original hover affordance (underline / pointer)
 *   freshOpen      true for a tab that was just opened (content not loaded yet).
 *                  A line request from a fresh open is an EXPLICIT jump and always
 *                  wins over the persisted scroll memory; a remount caused by
 *                  switching back to an open tab restores the remembered position.
 */
function CodeBody(props) {
  const { rows, lang, diffMode, targetLine, viewKey, scrollKey, contentReady, restoreScroll, jumpHover, freshOpen } = props
  const total = rows.length
  const virtual = total > GIT_V_THRESHOLD
  const scrollerRef = React.useRef(null)
  const [win, setWin] = React.useState(() => ({ first: 0, last: Math.min(total, 160) }))
  const rafRef = React.useRef(0)
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const lastTopRef = React.useRef(0)
  const saveTimerRef = React.useRef(0)
  // Captured on mount only: a fresh open keeps "explicit jump" semantics even
  // after the content arrives and the prop flips to false.
  const freshOpenRef = React.useRef(!!freshOpen)
  const scrollMetaRef = React.useRef({ key: '', diff: false, ready: true })
  scrollMetaRef.current = {
    key: scrollKey == null ? '' : String(scrollKey),
    diff: !!diffMode,
    ready: contentReady !== false,
  }
  const restoreAppliedRef = React.useRef(null)
  const jumpAppliedRef = React.useRef(0)
  // Whole-file highlight once, cached by content hash: switching tabs / branch /
  // commit back and forth never re-highlights.
  const joinedText = React.useMemo(
    () => rows.map((row) => (row && row.text != null ? String(row.text) : '')).join('\n'),
    [rows],
  )
  const hljsReady = typeof window !== 'undefined' && !!window.hljs
  const hlLines = React.useMemo(() => highlightLinesCached(joinedText, lang), [joinedText, lang, hljsReady])
  // Jump target: match by file line number, preferring real rows over deleted
  // diff rows (deleted rows carry the OLD line number and are struck through, so
  // they may be scrolled to but are never marked as "the jumped line"). A line
  // past EOF clamps to the last row (jump still lands somewhere sensible) but is
  // not highlighted.
  const jumpTarget = React.useMemo(() => {
    const line = Number(targetLine) || 0
    if (line <= 0) return { index: -1, hit: -1 }
    let deleted = -1
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row || row.no !== line) continue
      if (row.kind !== 'del') return { index, hit: index }
      if (deleted < 0) deleted = index
    }
    if (deleted >= 0) return { index: deleted, hit: -1 }
    return { index: Math.max(0, Math.min(line, rows.length) - 1), hit: -1 }
  }, [rows, targetLine])
  const paintWindow = () => {
    const el = scrollerRef.current
    if (!el) return
    const list = rowsRef.current
    if (list.length <= GIT_V_THRESHOLD) return
    const scrollTop = el.scrollTop
    const first = Math.max(0, Math.floor(scrollTop / GIT_LINE_H) - GIT_BUFFER)
    const last = Math.min(list.length, Math.ceil((scrollTop + el.clientHeight) / GIT_LINE_H) + GIT_BUFFER)
    setWin((prev) => (prev.first === first && prev.last === last ? prev : { first, last }))
  }

  const flushScroll = () => {
    const meta = scrollMetaRef.current
    if (!meta.key || meta.diff || !meta.ready) return
    codeScrollStore.save(meta.key, lastTopRef.current)
  }

  const scheduleScrollSave = () => {
    if (saveTimerRef.current) return
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = 0
      flushScroll()
    }, 220)
  }

  React.useEffect(() => {
    // The file text has not arrived yet: the placeholder rows would make every
    // restore decision look like "scroll to top", so wait for the real content.
    if (contentReady === false) return undefined
    const el = scrollerRef.current
    if (!el) return undefined
    const storeKey = scrollKey == null ? '' : String(scrollKey)
    // Modal ← 返回: an explicit restore is consumed once (a later re-render must
    // not yank the pane back to the same position).
    const freshRestore = !!(restoreScroll && Number.isFinite(restoreScroll.top) && restoreScroll !== restoreAppliedRef.current)
    if (freshRestore) restoreAppliedRef.current = restoreScroll
    const savedTop = !diffMode && storeKey ? codeScrollStore.get(storeKey) : 0
    // An explicit jump: content settled with a target line. It wins over the
    // scroll memory the first time this line is requested for this file; after
    // that (switch away and back) the remembered position is restored instead.
    const jumpPending = !freshRestore && targetLine > 0 && jumpTarget.index >= 0
    const sameLineAlready = storeKey ? codeJumpSeen.get(storeKey) === targetLine : jumpAppliedRef.current === targetLine
    // A just-opened tab with a requested line is explicit even if the same line
    // was jumped to earlier in this session (e.g. reopen the same code link).
    const jumpIsNew = freshOpenRef.current || !sameLineAlready
    let mode = 'top'
    if (freshRestore) mode = 'restore'
    else if (jumpPending && jumpIsNew) mode = 'jump'
    else if (savedTop > 0) mode = 'saved'
    else if (jumpPending) mode = 'jump'
    if (mode === 'restore') {
      el.scrollTop = Math.max(0, Math.round(restoreScroll.top))
    } else if (mode === 'saved') {
      el.scrollTop = savedTop
    } else if (mode === 'jump') {
      // Centre the target row like the original scrollCodeToLine.
      const top = jumpTarget.index * GIT_LINE_H - Math.floor((el.clientHeight - GIT_LINE_H) / 2)
      el.scrollTop = Math.max(0, top)
    } else {
      el.scrollTop = 0
    }
    lastTopRef.current = el.scrollTop
    paintWindow()
    if (mode === 'jump') {
      jumpAppliedRef.current = targetLine
      if (storeKey) codeJumpSeen.set(storeKey, targetLine)
    }
    return undefined
    // rows identity changes whenever the rendered content (commit/branch/file) changes.
  }, [viewKey, targetLine, diffMode, rows, total, scrollKey, contentReady, restoreScroll, jumpTarget])

  React.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      flushScroll()
    },
    [],
  )

  const onScroll = () => {
    const el = scrollerRef.current
    if (el) {
      lastTopRef.current = el.scrollTop
      scheduleScrollSave()
    }
    paintWindow()
    if (!virtual) return
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      paintWindow()
    })
  }

  const windowFrom = virtual ? Math.max(0, Math.min(win.first, Math.max(0, total - 1))) : 0
  const windowTo = virtual ? Math.min(total, Math.max(windowFrom, win.last)) : 0

  const codeHtmlAt = (index) => {
    const value = hlLines && hlLines[index]
    if (value != null) return value
    const row = rows[index]
    return escapeHtml(row && row.text != null ? String(row.text) : '') || ' '
  }

  const plainHtml = React.useMemo(() => {
    if (virtual) return ''
    let html = ''
    for (let index = 0; index < rows.length; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, jumpTarget.hit, codeHtmlAt(index), null)
    }
    return html
  }, [virtual, rows, lang, diffMode, jumpTarget, hlLines])

  const windowHtml = React.useMemo(() => {
    if (!virtual) return ''
    let html = ''
    for (let index = windowFrom; index < windowTo; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, jumpTarget.hit, codeHtmlAt(index), index * GIT_LINE_H)
    }
    return html
  }, [virtual, rows, lang, diffMode, jumpTarget, hlLines, windowFrom, windowTo])

  // `.jump-hover` is the original container gate for the Ctrl+click affordance;
  // deleted diff rows are excluded by CSS (their line numbers are the OLD file's).
  const bodyClass = 'mdr-code-body' + (virtual ? ' mdr-git-vscroll' : '') + (jumpHover ? ' jump-hover' : '')

  return h(
    'div',
    {
      className: bodyClass,
      ref: scrollerRef,
      onScroll,
    },
    virtual
      ? h('div', {
          className: 'mdr-git-vwrap',
          style: { height: total * GIT_LINE_H + 'px' },
          dangerouslySetInnerHTML: { __html: windowHtml },
        })
      : h('div', { dangerouslySetInnerHTML: { __html: plainHtml } }),
  )
}

function CodeGitInfo(props) {
  const { view } = props
  const meta = view.commitMeta
  const parts = []
  if (view.commit) {
    parts.push(h('span', { className: 'mdr-git-hash' }, meta ? meta.short : String(view.commit).slice(0, 7)))
    if (meta) {
      parts.push(h('span', { className: 'mdr-git-author' }, meta.author))
      parts.push(h('span', { className: 'mdr-git-date' }, meta.date))
      parts.push(h('span', { className: 'mdr-git-subject', title: meta.subject }, meta.subject))
    }
  }
  if (view.loading) parts.push(h('span', { className: 'mdr-git-stat' }, '加载中…'))
  else if (view.hint) parts.push(h('span', { className: 'mdr-git-stat mdr-git-note' }, view.hint))
  else if (view.commit) parts.push(h('span', { className: 'mdr-git-stat' }, `+${view.stats.add} −${view.stats.del} 行`))
  return h('div', { className: 'mdr-git-info' }, parts)
}

/** Tab id -> `${branch}\0${commit}` already applied (so remount does not re-apply). */
const gitTabViewApplied = new Map()

function CodeView(props) {
  const { tab, onOpen, onBack } = props
  const { view, actions } = useGitView(tab)
  const lang = tab.lang || langForPath(tab.path)
  const workspaceContent = String(tab.content == null ? '' : tab.content)
  const viewRef = React.useRef(null)
  const [defState, setDefState] = React.useState(null)

  // Ctrl/Cmd+click anywhere in the code body looks the symbol up and opens the
  // chooser (or the only candidate directly).
  React.useEffect(() => {
    const root = viewRef.current
    if (!root || typeof onOpen !== 'function') return undefined
    const dispose = setupDefinitionClick(root, tab, (candidates, symbol, error) => {
      if (!candidates.length) {
        setDefState({ symbol, candidates: [], error: error || '' })
        return
      }
      if (candidates.length === 1) {
        onOpen(candidates[0].path, candidates[0].line)
        return
      }
      setDefState({ symbol, candidates, error: '' })
    })
    return dispose
  }, [tab.id, tab.path, onOpen])

  // git-adapted code link: tab.branch / tab.commit must be applied to this tab's
  // git view on open (and when an already-open tab receives a new target view).
  // A fresh tab (`content == null`) re-applies even for the same target, so
  // closing and reopening the link shows the requested branch again.
  React.useEffect(() => {
    if (!tab.branch && !tab.commit) return
    const key = `${tab.branch || ''}\u0000${tab.commit || ''}`
    if (gitTabViewApplied.get(tab.id) === key && tab.content != null) return
    gitTabViewApplied.set(tab.id, key)
    void applyGitTarget({ id: tab.id, kind: 'code', path: tab.path }, tab.branch, tab.commit, actions.refresh)
  }, [tab.id, tab.path, tab.branch, tab.commit, tab.content == null, actions.refresh])

  const { rows, diffMode } = useCodeRows(view, workspaceContent)
  const viewKey = `${tab.id}|${view.branch}|${view.commit || ''}|${diffMode ? 'diff' : 'base'}|${
    view.branchContent == null ? 'ws' : 'branch'
  }`
  const showInfo = !!view.commit || !!view.hint || !!view.loading
  // Scroll memory is per file; the commit view gets its own slot so switching
  // back from a diff does not restore a diff scroll position into the file view.
  const scrollKey = diffMode ? `${tab.path}\u0000commit:${view.commit || ''}` : tab.path
  const contentReady = tab.content != null || view.branchContent != null

  return h(
    'div',
    { className: 'mdr-code' },
    h('style', { dangerouslySetInnerHTML: { __html: GIT_CSS } }),
    h(
      'div',
      { className: 'mdr-code-head' },
      h(Icons.code, { size: 14 }),
      typeof onBack === 'function' && tab.navFrom
        ? h(
            'button',
            { type: 'button', className: 'mdr-code-back', title: '返回上一次跳转位置', onClick: onBack },
            '← 返回',
          )
        : null,
      h('span', { className: 'mdr-code-path', title: tab.path }, tab.path),
      h('span', { className: 'mdr-spacer' }),
      view.git ? h(GitBar, { view, actions }) : null,
      h('span', { className: 'mdr-tip', title: 'Ctrl/Cmd + 点击符号跳转到定义' }, `${lang || 'text'} · ${rows.length} 行 · Ctrl+点击跳定义`),
    ),
    showInfo ? h(CodeGitInfo, { view }) : null,
    h(
      'div',
      { className: 'mdr-code-viewwrap', ref: viewRef },
      h(CodeBody, {
        rows,
        lang,
        diffMode,
        targetLine: tab.line || 0,
        viewKey,
        scrollKey,
        contentReady,
        jumpHover: isJavaKtLang(lang),
        // A tab whose content has not loaded yet was just opened: its line request
        // is an explicit jump and must beat any remembered scroll position.
        freshOpen: tab.content == null,
      }),
    ),
    defState
      ? h(DefinitionChooser, {
          state: defState,
          onPick: (candidate) => {
            onOpen(candidate.path, candidate.line)
            setDefState(null)
          },
          onClose: () => setDefState(null),
        })
      : null,
  )
}
