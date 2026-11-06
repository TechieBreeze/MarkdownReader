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

/* ================= md fenced code blocks (same pipeline as the code view) =================
   10-markdown.js hands every ```lang fence to renderFenceCodeHtml(source, lang) instead of
   running hljs itself. Both views then share highlightCodeHtml → highlightToLines, so the
   token classes (and therefore the colours) of a md code block are identical to the same
   source in a code tab/modal: multi-line comments/strings stay coloured, and Java/Kotlin get
   the type/method/variable post passes. */

/* 代码块语言名归一化（port of the standalone reader's hljsLang):
   ```lang 里的常见别名 → highlight.js 语言名；未收录的语言返回 ''（调用方保持原文）。 */
const HLJS_LANG_ALIAS = {
  // 前端框架模板 → xml（hljs common 包无 vue/svelte 语言）
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  angular: 'xml',
  hbs: 'xml',
  handlebars: 'xml',
  pug: 'xml',
  ejs: 'xml',
  jsp: 'xml',
  thymeleaf: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  py3: 'python',
  python3: 'python',
  ipython: 'python',
  gyp: 'python',
  pycon: 'python',
  rb: 'ruby',
  gemspec: 'ruby',
  podspec: 'ruby',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  'h++': 'cpp',
  hh: 'cpp',
  cc: 'cpp',
  objc: 'objectivec',
  'obj-c': 'objectivec',
  bat: 'dos',
  cmd: 'dos',
  dos: 'dos',
  ps1: 'powershell',
  powershell: 'powershell',
  patch: 'diff',
  md: 'markdown',
  markdown: 'markdown',
  jsonc: 'json',
  json5: 'json',
  text: '',
  txt: '',
  plaintext: '',
  plain: '',
  mermaid: '',
  ini: 'ini',
  properties: 'ini',
}

/** Alias targets missing from the vendored common bundle → closest available grammar.
    `dos` is mapped to bash here for the same reason LANG_MAP maps `.bat` to bash. */
const HLJS_LANG_FALLBACK = { dos: 'bash' }

/** Normalize a fence language hint to a highlight.js language name ('' = plain text).
    The ALIAS table is applied BEFORE the "already a hljs name" check on purpose: the
    code view resolves languages from the file extension (`langForPath`, e.g. .js →
    javascript, .kt → kotlin, .html → xml), so a ```js / ```kt / ```html fence must
    resolve to the same canonical name to produce byte-identical token classes. */
function hljsLangNormalized(lang) {
  const lib = typeof window !== 'undefined' ? window.hljs : null
  if (!lang || !lib || typeof lib.getLanguage !== 'function') return ''
  const raw = String(lang).trim().toLowerCase().replace(/^\./, '')
  if (!raw) return ''
  if (Object.prototype.hasOwnProperty.call(HLJS_LANG_ALIAS, raw)) {
    const mapped = HLJS_LANG_ALIAS[raw]
    if (!mapped) return '' // text / plaintext / mermaid … → keep the source as-is
    if (lib.getLanguage(mapped)) return mapped
    const fallback = HLJS_LANG_FALLBACK[mapped]
    if (fallback && lib.getLanguage(fallback)) return fallback
    return ''
  }
  if (lib.getLanguage(raw)) return raw // already a canonical hljs name
  return ''
}

/**
 * md-scoped VSCode Dark+ palette — keep in sync with the `.mdr-code` palette in
 * GIT_CSS (15-git.js). 00-core's APP_CSS already covers the common tokens for
 * `.mdr-root`, but it has no rules for the Java/Kotlin post-pass classes
 * (`hljs-constant`, `hljs-params.hljs-type`, …), so md fences would otherwise
 * leave ALL-CAPS constants white and paint parameter types as plain variables.
 * Injected once (idempotently) the first time a fence is rendered.
 */
const FENCE_CSS_ID = 'mdr-fence-css'
const FENCE_CSS = `
.mdr-md pre code .hljs-keyword,.mdr-md pre code .hljs-doctag,.mdr-md pre code .hljs-template-tag,.mdr-md pre code .hljs-tag,.mdr-md pre code .hljs-name,.mdr-md pre code .hljs-attr,.mdr-md pre code .hljs-selector-tag,.mdr-md pre code .hljs-meta,.mdr-md pre code .hljs-section,.mdr-md pre code .hljs-link,.mdr-md pre code .hljs-variable.language_{color:#569cd6}
.mdr-md pre code .hljs-string,.mdr-md pre code .hljs-meta .hljs-string,.mdr-md pre code .hljs-code,.mdr-md pre code .hljs-formula{color:#ce9178}
.mdr-md pre code .hljs-comment,.mdr-md pre code .hljs-quote{color:#6a9955}
.mdr-md pre code .hljs-number,.mdr-md pre code .hljs-literal,.mdr-md pre code .hljs-symbol,.mdr-md pre code .hljs-bullet{color:#b5cea8}
.mdr-md pre code .hljs-type,.mdr-md pre code .hljs-title,.mdr-md pre code .hljs-title.class_,.mdr-md pre code .hljs-title.class_.inherited__,.mdr-md pre code .hljs-built_in{color:#4ec9b0}
.mdr-md pre code .hljs-title.function_,.mdr-md pre code .hljs-title.function_.invoke__{color:#dcdcaa}
.mdr-md pre code .hljs-variable,.mdr-md pre code .hljs-property,.mdr-md pre code .hljs-attribute,.mdr-md pre code .hljs-params,.mdr-md pre code .hljs-template-variable{color:#9cdcfe}
.mdr-md pre code .hljs-selector-id,.mdr-md pre code .hljs-selector-class,.mdr-md pre code .hljs-selector-attr,.mdr-md pre code .hljs-selector-pseudo{color:#d7ba7d}
.mdr-md pre code .hljs-regexp{color:#d16969}
.mdr-md pre code .hljs-operator,.mdr-md pre code .hljs-punctuation,.mdr-md pre code .hljs-subst{color:#d4d4d4}
.mdr-md pre code .hljs-addition{color:#b5cea8;background-color:rgba(46,160,67,.15)}
.mdr-md pre code .hljs-deletion{color:#f48771;background-color:rgba(248,81,73,.15)}
.mdr-md pre code .hljs-constant{color:#b5cea8}
.mdr-md pre code .hljs-params.hljs-type{color:#4ec9b0}
.mdr-md pre code .hljs-params.hljs-variable{color:#9cdcfe}
.mdr-md pre code .hljs-params.hljs-keyword{color:#569cd6}
.mdr-md pre code .hljs-params.hljs-constant{color:#b5cea8}
.mdr-md .mdr-md-diff{margin:1em 0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:#1e1e1e;overflow:auto}
.mdr-md .mdr-md-diff .mdr-cl{font-size:12.5px}
.mdr-md .mdr-md-diff .mdr-cl-code{flex:1;padding-left:10px;color:#d4d4d4;white-space:pre;tab-size:4}
.mdr-md .mdr-md-diff .mdr-diff-sign{display:inline-block;width:14px;margin-right:6px;color:#6e7681;user-select:none}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-add .mdr-diff-sign{color:#3fb950}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-del .mdr-diff-sign{color:#f48771}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-add{background:rgba(46,160,67,.15)}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-del{background:rgba(248,81,73,.12)}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-del .mdr-cl-code{text-decoration:line-through;opacity:.78}
.mdr-md .mdr-md-diff .mdr-cl.mdr-git-ctx{background:rgba(139,148,158,.06)}
.mdr-md .mdr-md-diff .mdr-diff-meta .mdr-cl-code{color:#6e7681}
.mdr-md .mdr-md-diff .mdr-diff-hunk .mdr-cl-code{color:#79c0ff}
/* The diff block is NOT inside <pre><code>, so the fence palette above does not
   reach it: mirror the same token colours for the highlighted diff code. */
.mdr-md .mdr-md-diff .hljs-keyword,.mdr-md .mdr-md-diff .hljs-doctag,.mdr-md .mdr-md-diff .hljs-template-tag,.mdr-md .mdr-md-diff .hljs-tag,.mdr-md .mdr-md-diff .hljs-name,.mdr-md .mdr-md-diff .hljs-attr,.mdr-md .mdr-md-diff .hljs-selector-tag,.mdr-md .mdr-md-diff .hljs-meta,.mdr-md .mdr-md-diff .hljs-section,.mdr-md .mdr-md-diff .hljs-link,.mdr-md .mdr-md-diff .hljs-variable.language_{color:#569cd6}
.mdr-md .mdr-md-diff .hljs-string,.mdr-md .mdr-md-diff .hljs-meta .hljs-string,.mdr-md .mdr-md-diff .hljs-code,.mdr-md .mdr-md-diff .hljs-formula{color:#ce9178}
.mdr-md .mdr-md-diff .hljs-comment,.mdr-md .mdr-md-diff .hljs-quote{color:#6a9955}
.mdr-md .mdr-md-diff .hljs-number,.mdr-md .mdr-md-diff .hljs-literal,.mdr-md .mdr-md-diff .hljs-symbol,.mdr-md .mdr-md-diff .hljs-bullet{color:#b5cea8}
.mdr-md .mdr-md-diff .hljs-type,.mdr-md .mdr-md-diff .hljs-title,.mdr-md .mdr-md-diff .hljs-title.class_,.mdr-md .mdr-md-diff .hljs-title.class_.inherited__,.mdr-md .mdr-md-diff .hljs-built_in{color:#4ec9b0}
.mdr-md .mdr-md-diff .hljs-title.function_,.mdr-md .mdr-md-diff .hljs-title.function_.invoke__{color:#dcdcaa}
.mdr-md .mdr-md-diff .hljs-variable,.mdr-md .mdr-md-diff .hljs-property,.mdr-md .mdr-md-diff .hljs-attribute,.mdr-md .mdr-md-diff .hljs-params,.mdr-md .mdr-md-diff .hljs-template-variable{color:#9cdcfe}
.mdr-md .mdr-md-diff .hljs-selector-id,.mdr-md .mdr-md-diff .hljs-selector-class,.mdr-md .mdr-md-diff .hljs-selector-attr,.mdr-md .mdr-md-diff .hljs-selector-pseudo{color:#d7ba7d}
.mdr-md .mdr-md-diff .hljs-regexp{color:#d16969}
.mdr-md .mdr-md-diff .hljs-operator,.mdr-md .mdr-md-diff .hljs-punctuation,.mdr-md .mdr-md-diff .hljs-subst{color:#d4d4d4}
.mdr-md .mdr-md-diff .hljs-constant{color:#b5cea8}
.mdr-md .mdr-md-diff .hljs-params.hljs-type{color:#4ec9b0}
.mdr-md .mdr-md-diff .hljs-params.hljs-variable{color:#9cdcfe}
.mdr-md .mdr-md-diff .hljs-params.hljs-keyword{color:#569cd6}
`

/** Inject the md-fence palette once; safe to call on every fence render. */
function ensureFenceCss() {
  if (typeof document === 'undefined' || !document.head) return
  const existing = typeof document.getElementById === 'function' ? document.getElementById(FENCE_CSS_ID) : null
  if (existing) return
  const style = document.createElement('style')
  style.id = FENCE_CSS_ID
  style.textContent = FENCE_CSS
  document.head.appendChild(style)
}

/**
 * Highlight one fenced code block exactly like the code view would: whole-source
 * hljs pass + Java/Kotlin post passes + per-line span rebuild, joined back with
 * newlines for the `<pre><code>` innerHTML. Unknown/absent language → escaped
 * plain text (never throws; synchronous, one block at a time).
 */
function renderFenceCodeHtml(source, langHint) {
  const text = String(source == null ? '' : source)
  const hl = hljsLangNormalized(langHint)
  if (!hl) return escapeHtml(text)
  try {
    ensureFenceCss()
    return highlightToLines(highlightCodeHtml(text, hl), isJavaKtLang(hl)).join('\n')
  } catch {
    return escapeHtml(text)
  }
}

/* ------------------------------------------------------------- diff fences */

/**
 * Fence languages that render as a diff view instead of highlighted source.
 * `patch` is an alias of `diff` (the same alias the code view uses for .patch).
 */
const DIFF_FENCE_LANGS = new Set(['diff', 'git-diff', 'patch'])

function isDiffFenceLang(lang) {
  return DIFF_FENCE_LANGS.has(String(lang == null ? '' : lang).trim().toLowerCase())
}

/**
 * Is this line a FILE HEADER of a diff (`--- a/x`, `+++ b/x`, `--- /dev/null`)?
 *
 * The shape decides, NOT the counts of the hunk header: the counts are only a
 * hint (hand-written diffs declare them wrong all the time), and a hunk whose
 * counts are too small would otherwise swallow the file header of the NEXT
 * file - the rest of that hunk would fall out of the diff and be rendered as
 * dim header rows instead of code rows.
 */
function isDiffFileHeaderLine(line) {
  return /^(---|\+\+\+) (a\/|b\/|\/dev\/null)/.test(String(line == null ? '' : line))
}

/**
 * Rows of a unified diff pasted into a ```diff fence.
 *
 * Boundary rules (the same in the Host's diff parser):
 *  - a hunk body runs until the next `@@` header, the next `diff --git`
 *    (a new file) or the FILE HEADER of the next file (`--- a/x`, `+++ b/x`,
 *    `--- /dev/null`). The counts in the hunk header are a HINT, not a hard
 *    boundary: hand-written diffs in design docs routinely declare the wrong
 *    counts (e.g. `@@ -11,21 +11,21 @@` over a 22-line body), and cutting the
 *    body there loses the tail of the change.
 *  - an EMPTY line inside a hunk body is a context row (some tools strip the
 *    trailing space of an empty context line). It used to end the hunk, which
 *    dropped the rest of the change into dim header rows.
 *  - trailing blank lines of the patch are stripped first: `git show --patch`
 *    output ends with a newline, and splitting it yields a trailing empty line
 *    that would otherwise become a phantom row (and eat a real line of the
 *    commit-version file - the bug that made the code view lose the line right
 *    after a hunk).
 */
function parseDiffFenceRows(source) {
  const rows = []
  const text = String(source == null ? '' : source).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  let inHunk = false
  for (const line of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[3])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      inHunk = true
      rows.push({ kind: 'hunk', no: null, text: line })
      continue
    }
    if (inHunk) {
      if (line.startsWith('diff --git ')) {
        inHunk = false
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" - a meta row, and it does NOT end the
        // hunk.
        rows.push({ kind: 'meta', no: null, text: line })
        continue
      } else if (isDiffFileHeaderLine(line)) {
        // The file header of the NEXT file ends this hunk.
        inHunk = false
      } else {
        const kind = line[0]
        if (kind === '+') {
          rows.push({ kind: 'add', no: newNo, text: line.slice(1) })
          newNo += 1
          if (newLeft > 0) newLeft -= 1
          continue
        }
        if (kind === '-') {
          rows.push({ kind: 'del', no: oldNo, text: line.slice(1) })
          oldNo += 1
          if (oldLeft > 0) oldLeft -= 1
          continue
        }
        // context line (an empty line counts as a context line with no content)
        rows.push({ kind: 'ctx', no: newNo, text: line.slice(1) })
        oldNo += 1
        newNo += 1
        if (oldLeft > 0) oldLeft -= 1
        if (newLeft > 0) newLeft -= 1
        continue
      }
    }
    if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', no: null, text: line })
      continue
    }
    if (line.trim() === '') continue
    rows.push({ kind: 'meta', no: null, text: line })
  }
  return rows
}

/**
 * Split the rows into per-file sections.
 *
 * The file path comes from the patch header (`diff --git a/x b/x`, or `+++ b/x`),
 * and it decides the highlighting language - the same rule the code view uses
 * for a file (`langForPath`).
 */
function diffFenceSections(rows) {
  const sections = []
  let current = null
  const ensure = () => {
    if (!current) {
      current = { path: '', rows: [] }
      sections.push(current)
    }
    return current
  }
  for (const row of rows) {
    if (row.kind === 'meta') {
      const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(row.text)
      if (gitHeader) {
        // A new file starts here: `diff --git` is the only header that opens a
        // section (`--- a/x` / `+++ b/x` belong to the file it just announced).
        // The header line itself is KEPT as a row - nothing of the patch may
        // silently disappear.
        current = { path: gitHeader[2], rows: [row] }
        sections.push(current)
        continue
      }
      const plusHeader = /^\+\+\+ b\/(.+)$/.exec(row.text)
      if (plusHeader) {
        const section = ensure()
        if (!section.path) section.path = plusHeader[1]
        section.rows.push(row)
        continue
      }
    }
    ensure().rows.push(row)
  }
  for (const section of sections) {
    section.lang = section.path ? langForPath(section.path) : ''
  }
  return sections
}

/**
 * Highlight the code part of a diff section.
 *
 * Two fragments are highlighted, because a diff has two sides: the NEW side
 * (context + added lines) and the OLD side (context + deleted lines). Each side
 * is highlighted as ONE block, so multi-line comments/strings keep their colour
 * - per-line highlighting would break them (the reason the code view highlights
 * whole files in one pass).
 */
function highlightDiffFragment(rows, lang) {
  const texts = rows.map((row) => row.text)
  if (!texts.length) return []
  const lib = typeof window !== 'undefined' ? window.hljs : null
  const name = lang && lib && typeof lib.getLanguage === 'function' && lib.getLanguage(lang) ? lang : ''
  if (!name) return texts.map((text) => escapeHtml(text))
  try {
    const lines = highlightToLines(highlightCodeHtml(texts.join('\n'), name), isJavaKtLang(name))
    if (!lines || lines.length !== texts.length) return texts.map((text) => escapeHtml(text))
    return lines
  } catch {
    return texts.map((text) => escapeHtml(text))
  }
}

/** 高亮后的 HTML → 纯文本（用来校验这一行和 diff 里的那一行是否一致）。 */
function diffPlainText(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * HTML for a ```diff fence: the code part only (NO line-number column),
 * highlighted with the language of the file the diff belongs to, with added
 * rows green and deleted rows red + strike-through - the same look as the
 * commit diff in the code view.
 */
function renderDiffFenceHtml(source) {
  const rows = parseDiffFenceRows(source)
  if (!rows.length) return escapeHtml(String(source == null ? '' : source))
  const parts = []
  for (const section of diffFenceSections(rows)) {
    const newSide = []
    const oldSide = []
    // 每行在两侧高亮块里的槽位要**显式记录**：上下文行在两侧各占一行，
    // 删除行只占旧侧，新增行只占新侧。旧侧的行如果按出现顺序直接取，
    // 就会被前面若干上下文行顶偏 —— 删除行会显示成别的行（真实案例：
    // 详设里第一段 diff 的删除行显示成了 `@XxlJob(...)`，看着像重复一行）。
    const slots = []
    for (const row of section.rows) {
      const slot = { old: -1, new: -1 }
      if (row.kind === 'ctx') {
        slot.new = newSide.length
        newSide.push(row)
        slot.old = oldSide.length
        oldSide.push(row)
      } else if (row.kind === 'add') {
        slot.new = newSide.length
        newSide.push(row)
      } else if (row.kind === 'del') {
        slot.old = oldSide.length
        oldSide.push(row)
      }
      slots.push(slot)
    }
    const newHtml = highlightDiffFragment(newSide, section.lang)
    const oldHtml = highlightDiffFragment(oldSide, section.lang)
    for (let index = 0; index < section.rows.length; index += 1) {
      const row = section.rows[index]
      if (row.kind === 'meta') {
        parts.push(`<div class="mdr-cl mdr-diff-meta"><span class="mdr-cl-code">${escapeHtml(row.text)}</span></div>`)
        continue
      }
      if (row.kind === 'hunk') {
        parts.push(`<div class="mdr-cl mdr-diff-hunk"><span class="mdr-cl-code">${escapeHtml(row.text)}</span></div>`)
        continue
      }
      const cls = row.kind === 'add' ? 'mdr-git-add' : row.kind === 'del' ? 'mdr-git-del' : 'mdr-git-ctx'
      const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
      const slot = slots[index]
      const raw = row.kind === 'del' ? oldHtml[slot.old] : newHtml[slot.new]
      // 兜底：高亮后的行文本必须和 diff 里的这一行完全一致，否则用原文。
      // 这样任何高亮/映射错位都不会把 A 行画成 B 行。
      const code = raw !== undefined && diffPlainText(raw) === row.text ? raw : escapeHtml(row.text)
      parts.push(
        `<div class="mdr-cl ${cls}"><span class="mdr-cl-code"><span class="mdr-diff-sign">${sign}</span>${code}</span></div>`,
      )
    }
  }
  return parts.join('')
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
function gitRowHtml(row, index, lang, diffMode, hitIndex, codeHtml, top, extraClass) {
  const classes = ['mdr-cl']
  if (row.kind === 'add') classes.push('mdr-git-add')
  else if (row.kind === 'del') classes.push('mdr-git-del')
  else if (row.kind === 'ctx') classes.push('mdr-git-ctx')
  // 跳转行持久高亮：只有确实落在这一行（row index）才加 .hit；删除行不加
  // （旧文件行号与当前渲染的新版本文本错位，标上去反而误导）。
  if (hitIndex != null && hitIndex >= 0 && index === hitIndex && row.kind !== 'del') classes.push('hit')
  // 搜索命中标记（Ctrl+F）：.mdr-fs-line 是命中行，.mdr-fs-cur 是当前命中。
  if (extraClass) classes.push(extraClass)
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
  const {
    rows,
    lang,
    diffMode,
    targetLine,
    viewKey,
    scrollKey,
    contentReady,
    restoreScroll,
    jumpHover,
    freshOpen,
    searchKey,
  } = props
  const total = rows.length
  const virtual = total > GIT_V_THRESHOLD
  const scrollerRef = React.useRef(null)
  const [win, setWin] = React.useState(() => ({ first: 0, last: Math.min(total, 160) }))
  const rafRef = React.useRef(0)
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const lastTopRef = React.useRef(0)
  const saveTimerRef = React.useRef(0)
  // In-file search (Ctrl+F): the matching rows and the current one. The marks
  // are part of the rendered rows, so they survive a virtual-scroll repaint.
  const [fs, setFs] = React.useState({ matches: [], index: -1 })
  const fsRef = React.useRef(fs)
  fsRef.current = fs
  const fsMarkSet = React.useMemo(() => new Set(fs.matches), [fs.matches])
  const fsCurrent = fs.matches.length ? fs.matches[fs.index] : -1
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

  /**
   * In-file search (Ctrl+F) over the code rows.
   *
   * The code is searched by LINE (the rows carry the plain text), so a match
   * is a row index. The rows carry the mark class, so the highlight survives a
   * virtual-scroll repaint.
   */
  const scrollToSearchRow = (index) => {
    const el = scrollerRef.current
    if (!el || index < 0) return
    const top = index * GIT_LINE_H - Math.floor((el.clientHeight - GIT_LINE_H) / 2)
    el.scrollTop = Math.max(0, top)
    lastTopRef.current = el.scrollTop
    paintWindow()
  }

  React.useEffect(() => {
    if (!searchKey) return undefined
    const controller = {
      kind: 'code',
      search(query, options) {
        const re = fileSearchRegex(query, options)
        if (!re) return { count: 0, index: -1, error: '正则表达式错误' }
        const list = rowsRef.current || []
        const matches = []
        for (let index = 0; index < list.length; index += 1) {
          const row = list[index]
          const text = row && row.text != null ? String(row.text) : ''
          if (!text) continue
          if (fileSearchMatchesIn(text, re).length) matches.push(index)
        }
        setFs({ matches, index: matches.length ? 0 : -1 })
        if (matches.length) scrollToSearchRow(matches[0])
        return { count: matches.length, index: matches.length ? 0 : -1 }
      },
      goto(delta) {
        const state = fsRef.current
        const total = state.matches.length
        if (!total) return { count: 0, index: -1 }
        let next = state.index + delta
        if (next < 0) next = total - 1
        if (next >= total) next = 0
        setFs({ matches: state.matches, index: next })
        scrollToSearchRow(state.matches[next])
        return { count: total, index: next }
      },
      clear() {
        setFs({ matches: [], index: -1 })
      },
    }
    registerFileSearchController(searchKey, controller)
    return () => unregisterFileSearchController(searchKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

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

  // Search marks: the current match wins over the other matches.
  const searchClassFor = (index) => {
    if (index === fsCurrent) return 'mdr-fs-cur'
    if (fsMarkSet.has(index)) return 'mdr-fs-line'
    return ''
  }

  const plainHtml = React.useMemo(() => {
    if (virtual) return ''
    let html = ''
    for (let index = 0; index < rows.length; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, jumpTarget.hit, codeHtmlAt(index), null, searchClassFor(index))
    }
    return html
  }, [virtual, rows, lang, diffMode, jumpTarget, hlLines, fsMarkSet, fsCurrent])

  const windowHtml = React.useMemo(() => {
    if (!virtual) return ''
    let html = ''
    for (let index = windowFrom; index < windowTo; index += 1) {
      html += gitRowHtml(rows[index], index, lang, diffMode, jumpTarget.hit, codeHtmlAt(index), index * GIT_LINE_H, searchClassFor(index))
    }
    return html
  }, [virtual, rows, lang, diffMode, jumpTarget, hlLines, windowFrom, windowTo, fsMarkSet, fsCurrent])

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

/** 「实现: XxxImpl」entry bar CSS (the original's _jumpDefbar), code-tab scoped. */
const DEFBAR_CSS = `
.mdr-code .mdr-defbar{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:3px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.mdr-code .mdr-defbar-lbl{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.mdr-code .mdr-defbar-btn{padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.mdr-code .mdr-defbar-btn:hover{border-color:var(--dsw-alias-brand-primary)}
`

/** Does the git view recorded on an impl entry bar still match what is rendered? */
function defBarViewMatches(defView, view) {
  if (!defView) return !view.commit && view.branchContent == null
  if (defView.commit) return defView.commit === view.commit
  if (defView.branch) return defView.branch === view.branch && !view.commit && view.branchContent != null
  return !view.commit && view.branchContent == null
}

function CodeView(props) {
  const { tab, onOpen, onBack } = props
  const { view, actions } = useGitView(tab)
  const lang = tab.lang || langForPath(tab.path)
  const workspaceContent = String(tab.content == null ? '' : tab.content)
  const viewRef = React.useRef(null)

  const { rows, diffMode } = useCodeRows(view, workspaceContent)
  // Text + git version that the jump request must carry: exactly what is
  // rendered (commit version in a diff view, branch version in a branch view,
  // workspace content otherwise).
  const defText = React.useMemo(
    () =>
      diffMode && Array.isArray(view.fileLines)
        ? view.fileLines.join('\n')
        : view.branchContent != null
          ? String(view.branchContent)
          : workspaceContent,
    [diffMode, view.fileLines, view.branchContent, workspaceContent],
  )
  // A commit only counts as the rendered version when its diff rows are shown.
  const defView = view.commit && diffMode ? { commit: view.commit } : view.branchContent != null ? { branch: view.branch } : null
  const defSourceRef = React.useRef({})
  defSourceRef.current = {
    path: tab.path,
    text: defText,
    branch: defView && defView.branch ? defView.branch : '',
    commit: defView && defView.commit ? defView.commit : '',
    line: tab.line || 0,
  }

  // Ctrl/Cmd+click → one definition, then jump (same file → line highlight;
  // another file → open it; no candidate chooser). getSource is a ref read so the
  // listener stays bound while branch/commit/text change under it.
  React.useEffect(() => {
    const root = viewRef.current
    if (!root || typeof onOpen !== 'function') return undefined
    return setupDefinitionClick(
      root,
      () => defSourceRef.current,
      (result, source, hit) => {
        const target = String(result.file || '').replace(/\\/g, '/')
        if (!target) return
        const line = Math.max(0, Number(result.line) || 0)
        const opts = { kind: 'code' }
        if (source.commit) opts.commit = source.commit
        else if (source.branch) opts.branch = source.branch
        // Push the clicked position onto the nav history first (the original's
        // ctrlJump pushNav(src.path, lineNo) before opening the target), so the
        // ← 返回 button / Alt+← return to the token that was clicked.
        opts.from = {
          path: source.path,
          line: Math.max(0, Number(hit && hit.line) || 0),
          branch: source.branch || '',
          commit: source.commit || '',
        }
        // Interface hit → carry the 「实现: XxxImpl」entry bar onto the target tab
        // (the original's openTargetTab/_jumpDefbar behaviour).
        if (result.impl && result.impl.file) {
          const implFile = String(result.impl.file)
          opts.defBar = {
            impl: { file: implFile, line: Math.max(0, Number(result.impl.line) || 0) },
            label: implFile.split('/').pop().replace(/\.java$/, '') || implFile,
            view: source.commit ? { commit: source.commit } : source.branch ? { branch: source.branch } : null,
          }
        } else {
          opts.defBar = null
        }
        // Def results always open in the CODE view, even when the target file is
        // .html/.vue/... (linkKindFor must not be applied to definitions).
        onOpen(target, line, opts)
      },
    )
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

  const viewKey = `${tab.id}|${view.branch}|${view.commit || ''}|${diffMode ? 'diff' : 'base'}|${
    view.branchContent == null ? 'ws' : 'branch'
  }`
  const showInfo = !!view.commit || !!view.hint || !!view.loading
  // Scroll memory is per file; the commit view gets its own slot so switching
  // back from a diff does not restore a diff scroll position into the file view.
  const scrollKey = diffMode ? `${tab.path}\u0000commit:${view.commit || ''}` : tab.path
  const contentReady = tab.content != null || view.branchContent != null

  const defBar = tab.defBar && tab.defBar.impl && tab.defBar.impl.file ? tab.defBar : null
  const showDefBar = !!defBar && defBarViewMatches(defBar.view, view)

  return h(
    'div',
    { className: 'mdr-code' },
    h('style', { dangerouslySetInnerHTML: { __html: GIT_CSS + DEFBAR_CSS } }),
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
    showDefBar
      ? h(
          'div',
          { className: 'mdr-defbar' },
          h('span', { className: 'mdr-defbar-lbl' }, '实现:'),
          h(
            'button',
            {
              type: 'button',
              className: 'mdr-defbar-btn',
              title: `跳转到实现：${defBar.impl.file}:${defBar.impl.line}`,
              onClick: () =>
                onOpen(defBar.impl.file, defBar.impl.line, { kind: 'code', ...(defBar.view || {}), defBar: null }),
            },
            defBar.label,
          ),
        )
      : null,
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
        // In-file search (Ctrl+F) keys the controller by the tab id.
        searchKey: tab.id,
      }),
    ),
  )
}
