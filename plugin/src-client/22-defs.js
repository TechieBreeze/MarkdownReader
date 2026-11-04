/**
 * Ctrl+click "jump to definition" for the code views (code tab + code modal).
 *
 * Replaces the old candidate-list chooser with the original's single-target flow:
 * resolve one definition on the Host and navigate straight to it (same file →
 * scroll + persistent highlight; another file → open it), mirroring the
 * standalone reader's `ctrlTokenInfo` + `ctrlJump` + `openTarget`.
 *
 * Frozen Host contract (round 7): POST {ROUTE}/api/def
 *   request  { path, line, col, name, kind, text, branch, commit }
 *            line/col are 1-based (col inside the line's CODE TEXT)
 *            text = the full text currently rendered (workspace / branch / commit)
 *            branch/commit = the git version currently rendered (null otherwise)
 *   success  { ok: true, file, line, kind, defName, impl: {file,line}|null }
 *   failure  HTTP 400 { ok: false, error: "..." }  → postJson throws → toast(error)
 *
 * kind comes from the highlight.js token class exactly like the original:
 *   function_ → method, hljs-type / class_ → type, hljs-constant → constant
 *   (Java/Kotlin), hljs-variable → variable. Identifiers with no hljs span at all
 *   (common in JS/TS/Vue and for a couple of Java shapes) are resolved column-wise
 *   and sent as variable, so web files keep jumping too.
 *
 * Deleted rows of the commit-diff view (`.mdr-git-del`) stay non-jumpable: their
 * line number is the OLD file's and the rendered text is the new version.
 */

/** The rendered row prefixes every code line with a 2-char diff/gutter marker. */
const DEF_GUTTER_LEN = 2
const DEF_IDENT_RE = /^[A-Za-z_$][\w$]*$/
const DEF_WEB_PATH_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue)$/i
const DEF_JAVA_LIKE_PATH_RE = /\.(?:java|kt|kts)$/i
/** Web grammars have no Java/Kotlin post-pass: these hljs token classes were
    treated as variables by the original web resolver (strings excluded). */
const DEF_WEB_VARIABLE_CLASS_RE =
  /^hljs-(?:keyword|title|attr|property|function|params|literal|number|regexp|built_in|symbol|selector|prompt|section|meta|subst|doctag|type|class|name|variable)(?:$|\s)/

function defIsWebPath(rel) {
  return DEF_WEB_PATH_RE.test(String(rel || ''))
}

function defIsJavaLikePath(rel) {
  return DEF_JAVA_LIKE_PATH_RE.test(String(rel || ''))
}

/** The Host has a local-definition resolver only for Java/Kotlin and web sources. */
function canJumpInFile(rel) {
  return defIsJavaLikePath(rel) || defIsWebPath(rel)
}

/** kind for a clicked token from its hljs class list; '' = not a jump target. */
function defKindFromClass(className, rel) {
  const cls = String(className || '')
  if (!cls) return ''
  if (cls.includes('function_')) return 'method'
  if (cls.includes('hljs-type') || cls.includes('class_')) return 'type'
  if (cls.includes('hljs-constant')) return defIsJavaLikePath(rel) ? 'constant' : 'variable'
  if (cls.includes('hljs-variable')) return 'variable'
  if (defIsWebPath(rel) && !cls.includes('hljs-string') && DEF_WEB_VARIABLE_CLASS_RE.test(cls)) return 'variable'
  return ''
}

/* ------------------------------------------------------------- DOM helpers */

function defParentElement(node) {
  if (!node) return null
  return node.nodeType === 3 ? node.parentElement || null : node
}

function defElementClosest(node, selector) {
  const element = defParentElement(node)
  if (!element) return null
  if (typeof element.closest === 'function') return element.closest(selector)
  // Minimal fallback (harnesses): walk parents and compare a single class name.
  const className = selector.startsWith('.') ? selector.slice(1) : ''
  let current = element
  while (current) {
    if (className && current.classList && current.classList.contains && current.classList.contains(className)) return current
    current = current.parentElement || null
  }
  return null
}

/** The `.mdr-cl` row containing `node`, but only when it belongs to this view root. */
function defRowOf(node, rootEl) {
  const row = defElementClosest(node, '.mdr-cl')
  if (!row) return null
  if (rootEl && typeof rootEl.contains === 'function' && !rootEl.contains(row)) return null
  if (rootEl && typeof rootEl.contains !== 'function') return null
  return row
}

function defLineOfRow(row) {
  if (!row) return 0
  let raw = ''
  if (row.dataset && row.dataset.line != null) raw = String(row.dataset.line)
  else if (typeof row.getAttribute === 'function') raw = String(row.getAttribute('data-line') || '')
  const line = parseInt(raw, 10)
  return Number.isFinite(line) ? line : 0
}

/**
 * 1-based column of (node, offset) inside the row's code text. The sticky
 * line-number column is not part of `.mdr-cl-code`; the 2-char diff/gutter
 * marker is stripped so the column matches the real source line.
 */
function defCodeColumn(row, node, offset) {
  if (!row || typeof row.querySelector !== 'function') return 0
  const codeEl = row.querySelector('.mdr-cl-code')
  if (!codeEl) return 0
  let total = 0
  let found = -1
  let stop = false
  const walk = (parent) => {
    for (const child of parent.childNodes || []) {
      if (stop) return
      if (child === node) {
        found = child.nodeType === 3 ? total + Math.max(0, Number(offset) || 0) : total
        stop = true
        return
      }
      if (child.nodeType === 3) total += (child.textContent || '').length
      else if (child.nodeType === 1) {
        if (child.contains && child.contains(node)) {
          walk(child)
          return
        }
        total += (child.textContent || '').length
      }
    }
  }
  walk(codeEl)
  if (found < 0) return 0
  return Math.max(1, found + 1 - DEF_GUTTER_LEN)
}

/** Word under (textNode, offset): identifier plus its start offset in that node. */
function defWordFromTextNode(node, offset) {
  if (!node || node.nodeType !== 3) return null
  const text = String(node.textContent || '')
  const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch)
  let at = Math.max(0, Math.min(Number(offset) || 0, text.length))
  // A click exactly at the end of a word still means that word (caret offset).
  if ((at >= text.length || !isWord(text[at])) && at > 0 && isWord(text[at - 1])) at -= 1
  let start = at
  let end = at
  while (start > 0 && isWord(text[start - 1])) start -= 1
  while (end < text.length && isWord(text[end])) end += 1
  const name = text.slice(start, end)
  if (!DEF_IDENT_RE.test(name)) return null
  return { name, start }
}

function defCaretAt(event) {
  if (typeof document === 'undefined') return null
  try {
    if (typeof document.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(event.clientX, event.clientY)
      if (position && position.offsetNode) return { node: position.offsetNode, offset: position.offset || 0 }
    }
    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(event.clientX, event.clientY)
      if (range && range.startContainer) return { node: range.startContainer, offset: range.startOffset || 0 }
    }
  } catch {
    // caret lookup is best-effort; fall back to the event target span
  }
  return null
}

/**
 * Resolve the token under a Ctrl+click. Returns
 * { name, kind, line, col } or null when the click is not on a resolvable token.
 */
function definitionHitAt(rootEl, event, relPath) {
  const target = event && event.target
  if (!target) return null
  // Deleted diff rows are old-file lines rendered inside the new file: no jump.
  // (Direct closest() here keeps the fast path obvious; the helper below covers
  // nodes without Element.closest in harnesses.)
  if (target.closest && target.closest('.mdr-git-del')) return null
  if (defElementClosest(target, '.mdr-git-del')) return null
  const row = defRowOf(target, rootEl)
  if (!row) return null
  const line = defLineOfRow(row)
  if (!line) return null
  const codeEl = defElementClosest(target, '.mdr-cl-code')
  if (!codeEl) return null // clicks on the line-number column do nothing

  // 1) Caret-based word extraction: exact under the pointer, works for tokens
  //    without any hljs span (JS/TS/Vue plain identifiers) as well.
  const caret = defCaretAt(event)
  if (caret && caret.node && caret.node.nodeType === 3) {
    const word = defWordFromTextNode(caret.node, caret.offset)
    if (word) {
      const span = defElementClosest(caret.node, 'span')
      // `.mdr-cl-code` itself is a span: only an inner token span counts.
      const tokenSpan = span && span !== codeEl && codeEl.contains(span) ? span : null
      const kind = tokenSpan ? defKindFromClass(tokenSpan.className, relPath) : 'variable'
      if (kind) {
        const col = defCodeColumn(row, caret.node, word.start)
        if (col > 0) return { name: word.name, kind, line, col }
      }
      // A non-jumpable token (keyword/punctuation/string/comment) gets no request.
      if (tokenSpan) return null
    }
  }

  // 2) Fallback when the caret API is unavailable: use the hljs span itself.
  const span = defElementClosest(target, 'span')
  if (!span || span === codeEl || !codeEl.contains(span)) return null
  const kind = defKindFromClass(span.className, relPath)
  if (!kind) return null
  const name = String(span.textContent || '').trim()
  if (!DEF_IDENT_RE.test(name)) return null
  const col = defCodeColumn(row, span, 0)
  if (!col) return null
  return { name, kind, line, col }
}

/* --------------------------------------------------------- Host contract */

/** POST /api/def body from the clicked token + the current view source. */
function definitionRequestBody(source, hit) {
  const path = String((source && source.path) || '')
  const line = Math.max(0, Number(hit && hit.line) || 0)
  const col = Math.max(0, Number(hit && hit.col) || 0)
  const name = String((hit && hit.name) || '')
  if (!path || !line || !col || !name) return null
  return {
    path,
    line,
    col,
    name,
    kind: (hit && hit.kind) || 'variable',
    text: String(source && source.text != null ? source.text : ''),
    branch: (source && source.branch) || null,
    commit: (source && source.commit) || null,
  }
}

/** Ask the Host for one definition; failures surface as the Host's own message. */
async function requestDefinition(source, hit) {
  const body = definitionRequestBody(source, hit)
  if (!body) return null
  try {
    const payload = await postJson('/api/def', body)
    // The oracle-style resolver may report a failure in the body with HTTP 200
    // (e.g. "外部/框架方法，无本地定义"); the plan's contract uses 400 (postJson
    // throws instead). Surface the message either way.
    if (payload && payload.error) {
      toast(String(payload.error), 'err')
      return null
    }
    if (!payload || !payload.file || !(Number(payload.line) > 0)) {
      toast('未找到定义', 'err')
      return null
    }
    return payload
  } catch (err) {
    toast(String((err && err.message) || err), 'err')
    return null
  }
}

/**
 * Attach the Ctrl/Cmd+click listener. `getSource()` is called at click time so
 * the request always carries the text / branch / commit currently rendered (the
 * view can switch branch or commit without remounting). `onJump(result, source,
 * hit)` navigates: same file → line jump, another file → open it (the caller
 * decides modal in-place vs new tab); `hit` carries the clicked line so the
 * caller can push it onto the navigation history like the original ctrlJump.
 * Returns a dispose function.
 */
function setupDefinitionClick(rootEl, getSource, onJump) {
  if (!rootEl || typeof getSource !== 'function' || typeof onJump !== 'function') return () => {}
  let busy = false
  const handler = async (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    let source = null
    try {
      source = getSource() || null
    } catch {
      source = null
    }
    if (!source || !source.path || !canJumpInFile(source.path)) return
    const hit = definitionHitAt(rootEl, event, source.path)
    if (!hit) return
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    busy = true
    if (rootEl.classList && rootEl.classList.add) rootEl.classList.add('mdr-def-busy')
    try {
      const result = await requestDefinition(source, hit)
      if (result) onJump(result, source, hit)
    } finally {
      busy = false
      if (rootEl.classList && rootEl.classList.remove) rootEl.classList.remove('mdr-def-busy')
    }
  }
  rootEl.addEventListener('click', handler)
  return () => rootEl.removeEventListener('click', handler)
}
