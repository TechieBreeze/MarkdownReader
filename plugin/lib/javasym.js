/**
 * Java source analysis for Ctrl+click "go to definition".
 *
 * The standalone reader used javalang (a Python AST parser). The plugin is a
 * Node-only host (no npm deps), so this module implements a deliberately small,
 * tolerant Java scanner that reproduces the parts of the javalang AST the
 * resolver in `defs.js` needs:
 *
 *   - package / imports (explicit, wildcard, static);
 *   - type declarations (class/interface/enum/record/@interface) with their
 *     annotations, `extends` / `implements` names and body token ranges;
 *   - methods with their parameter declarations (parameter decl line is the
 *     METHOD's line, matching javalang's `MethodDeclaration.position.line`);
 *   - fields (with Lombok-relevant annotations) and enum constants;
 *   - local variable declarations, including for-init and for-each declarations
 *     (javalang models those as LocalVariableDeclaration), plus the extras the
 *     contract asks for: catch parameters, lambda parameters and
 *     try-with-resources declarations (the original tool could not jump to those
 *     because they are separate javalang node types — the plugin resolves them
 *     as a strict superset, only when the javalang-equivalent pool misses).
 *
 * The lexer skips comments, string/char literals (including Java text blocks)
 * and keeps 1-based line/column plus the absolute character offset of every
 * token, so the resolver can work on click coordinates exactly.
 *
 * Not a full Java parser: annotations with arguments, generics, arrays,
 * varargs, initializer blocks and anonymous classes are handled structurally
 * (skipped/balanced), not semantically.
 */

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'native', 'transient', 'volatile', 'strictfp', 'default', 'sealed',
])

const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void'])

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null',
])

const TYPE_DECL_KEYWORDS = new Set(['class', 'interface', 'enum'])

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9')
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9'
}

/* ------------------------------------------------------------------ lexer */

/**
 * Tokenize Java source. Returns [{ kind, value, line, col, offset }].
 * kind: 'ident' | 'keyword' | 'number' | 'string' | 'char' | 'symbol'.
 * Comments and whitespace are dropped; line/col are 1-based.
 */
export function tokenizeJava(text) {
  const src = String(text || '')
  const tokens = []
  const n = src.length
  let i = 0
  let line = 1
  let col = 1
  const push = (kind, value, startLine, startCol, startOffset) => {
    tokens.push({ kind, value, line: startLine, col: startCol, offset: startOffset })
  }
  while (i < n) {
    const ch = src[i]
    if (ch === '\n') {
      i += 1
      line += 1
      col = 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1
      col += 1
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        i += 1
        col += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      col += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line += 1
          col = 1
        } else {
          col += 1
        }
        i += 1
      }
      if (i < n) {
        i += 2
        col += 2
      }
      continue
    }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      const startLine = line
      const startCol = col
      const startOffset = i
      i += 3
      col += 3
      while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) {
        if (src[i] === '\\') {
          i += 2
          col += 2
          continue
        }
        if (src[i] === '\n') {
          line += 1
          col = 1
          i += 1
          continue
        }
        i += 1
        col += 1
      }
      if (i < n) {
        i += 3
        col += 3
      }
      push('string', '""', startLine, startCol, startOffset)
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      const startCol = col
      const startOffset = i
      i += 1
      col += 1
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          i += 2
          col += 2
          continue
        }
        if (src[i] === '\n') {
          line += 1
          col = 1
          i += 1
          continue
        }
        i += 1
        col += 1
      }
      if (i < n) {
        i += 1
        col += 1
      }
      push(quote === '"' ? 'string' : 'char', quote, startLine, startCol, startOffset)
      continue
    }
    if (isIdentStart(ch)) {
      const startLine = line
      const startCol = col
      const startOffset = i
      let j = i + 1
      while (j < n && isIdentPart(src[j])) j += 1
      const value = src.slice(i, j)
      push(JAVA_KEYWORDS.has(value) ? 'keyword' : 'ident', value, startLine, startCol, startOffset)
      col += j - i
      i = j
      continue
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      const startLine = line
      const startCol = col
      const startOffset = i
      let j = i + 1
      while (j < n) {
        const c = src[j]
        if (isIdentPart(c) || c === '.') {
          j += 1
          continue
        }
        // exponent sign: 1e-9 / 1E+9
        if ((c === '+' || c === '-') && (src[j - 1] === 'e' || src[j - 1] === 'E')) {
          j += 1
          continue
        }
        break
      }
      push('number', src.slice(i, j), startLine, startCol, startOffset)
      col += j - i
      i = j
      continue
    }
    if (ch === '-' && src[i + 1] === '>') {
      push('symbol', '->', line, col, i)
      i += 2
      col += 2
      continue
    }
    if (ch === ':' && src[i + 1] === ':') {
      push('symbol', '::', line, col, i)
      i += 2
      col += 2
      continue
    }
    push('symbol', ch, line, col, i)
    i += 1
    col += 1
  }
  return tokens
}

/* ------------------------------------------------------------------ parser */

function isTypeDeclStart(tokens, i) {
  const t = tokens[i]
  if (!t) return false
  if (t.kind === 'keyword' && TYPE_DECL_KEYWORDS.has(t.value)) return true
  if (t.value === '@' && tokens[i + 1] && tokens[i + 1].value === 'interface') return true
  // `record` is a contextual keyword: only a type decl when followed by a name.
  if (t.kind === 'ident' && t.value === 'record' && tokens[i + 1] && tokens[i + 1].kind === 'ident') return true
  return false
}

/**
 * Parse a Java compilation unit into the declaration model used by the resolver.
 * The model is intentionally flat (one object per declaration) with the token
 * ranges the resolver needs.
 */
export function parseJava(text, fileRelHint) {
  const src = String(text || '')
  const tokens = tokenizeJava(src)
  const lines = src.split('\n')
  const model = {
    rel: fileRelHint || '',
    text: src,
    lines,
    tokens,
    tokensByLine: [],
    pkg: null,
    imports: [],
    types: [],
    methods: [],
    fields: [],
    locals: [],
    params: [],
    extras: [],
    enumConstants: [],
    methodNameTokenKeys: new Set(), // `${line}:${col}` of method declaration names
    constructorNameTokenKeys: new Set(),
  }
  for (const token of tokens) {
    if (!model.tokensByLine[token.line - 1]) model.tokensByLine[token.line - 1] = []
    model.tokensByLine[token.line - 1].push(token)
  }

  const readAnnotation = (index) => {
    // tokens[index] === '@'
    let k = index + 1
    let name = ''
    if (tokens[k] && (tokens[k].kind === 'ident' || tokens[k].kind === 'keyword')) {
      name = tokens[k].value
      k += 1
      while (tokens[k] && tokens[k].value === '.' && tokens[k + 1] && tokens[k + 1].kind === 'ident') {
        name += '.' + tokens[k + 1].value
        k += 2
      }
    }
    if (tokens[k] && tokens[k].value === '(') k = matchClose(k, '(', ')') + 1
    return { name, next: k }
  }

  const skipAngles = (index) => {
    // tokens[index] === '<'
    let depth = 0
    for (let k = index; k < tokens.length; k += 1) {
      const v = tokens[k].value
      if (v === '<') depth += 1
      else if (v === '>') {
        depth -= 1
        if (depth === 0) return k + 1
      } else if (v === '{' || v === ';') {
        return index + 1 // unbalanced: bail out at the token after '<'
      }
    }
    return tokens.length
  }

  const matchClose = (index, open, close) => {
    let depth = 0
    for (let k = index; k < tokens.length; k += 1) {
      const v = tokens[k].value
      if (v === open) depth += 1
      else if (v === close) {
        depth -= 1
        if (depth === 0) return k
      }
    }
    return tokens.length - 1
  }

  const matchBrace = (index) => matchClose(index, '{', '}')

  /**
   * Parse a type at `index`: [qualified ident | primitive] [generics] [arrays]
   * [varargs]. Returns { typeName, next } where typeName is the FIRST/most
   * significant identifier (like javalang's `node.type.name` for `Map.Entry`),
   * or null when the tokens do not look like a type.
   */
  const tryParseType = (index) => {
    let k = index
    const first = tokens[k]
    if (!first) return null
    if (first.kind === 'keyword') {
      if (!PRIMITIVES.has(first.value)) return null
    } else if (first.kind !== 'ident') {
      return null
    }
    const typeName = first.value
    k += 1
    if (tokens[k] && tokens[k].value === '<') k = skipAngles(k)
    while (tokens[k] && tokens[k].value === '.' && tokens[k + 1] && tokens[k + 1].kind === 'ident') {
      k += 2
      if (tokens[k] && tokens[k].value === '<') k = skipAngles(k)
    }
    while (tokens[k] && tokens[k].value === '[' && tokens[k + 1] && tokens[k + 1].value === ']') k += 2
    if (tokens[k] && tokens[k].value === '...') k += 1
    return { typeName, next: k }
  }

  const skipAnnotationsAndModifiers = (start, end) => {
    let k = start
    while (k < end) {
      const t = tokens[k]
      if (t.value === '@') {
        k = readAnnotation(k).next
        continue
      }
      if (t.kind === 'keyword' && MODIFIERS.has(t.value)) {
        k += 1
        continue
      }
      if (t.kind === 'ident' && t.value === 'var') return k // 'var' is a type name, not modifier
      break
    }
    return k
  }

  /* ----- member parsing (inside a type body) ----- */

  const parseMethodOrConstructor = (nameIndex, typeDecl, startInfo) => {
    const nameTok = tokens[nameIndex]
    let k = nameIndex + 1
    if (!tokens[k] || tokens[k].value !== '(') return null
    const params = []
    k += 1
    while (k < tokens.length && tokens[k].value !== ')') {
      const pstart = skipAnnotationsAndModifiers(k, tokens.length)
      k = pstart
      const ptype = tryParseType(k)
      if (!ptype) {
        k += 1
        continue
      }
      const pnameTok = tokens[ptype.next]
      if (!pnameTok || pnameTok.kind !== 'ident') {
        k = ptype.next
        continue
      }
      params.push({ name: pnameTok.value, line: startInfo.line, col: pnameTok.col, typeName: ptype.typeName })
      k = ptype.next + 1
      while (tokens[k] && tokens[k].value === '[' && tokens[k + 1] && tokens[k + 1].value === ']') k += 2
      if (tokens[k] && tokens[k].value === ',') k += 1
    }
    if (!tokens[k] || tokens[k].value !== ')') return null
    k += 1
    while (tokens[k] && tokens[k].value === '[' && tokens[k + 1] && tokens[k + 1].value === ']') k += 2
    if (tokens[k] && tokens[k].value === 'throws') {
      while (k < tokens.length && tokens[k].value !== '{' && tokens[k].value !== ';') k += 1
    }
    let bodyStart = -1
    let bodyEnd = -1
    let next = k
    if (tokens[k] && tokens[k].value === '{') {
      bodyStart = k
      bodyEnd = matchBrace(k)
      next = bodyEnd + 1
    } else if (tokens[k] && tokens[k].value === ';') {
      next = k + 1
    } else {
      next = k + 1
    }
    const method = {
      name: nameTok.value,
      line: startInfo.line,
      col: nameTok.col,
      params,
      annotations: startInfo.annotations.slice(),
      modifiers: startInfo.modifiers.slice(),
      returnType: startInfo.isConstructor ? '' : startInfo.returnType,
      typeName: typeDecl.name,
      isConstructor: !!startInfo.isConstructor,
      isInterface: typeDecl.kind === 'interface' || typeDecl.kind === 'annotation',
      bodyStart,
      bodyEnd,
    }
    if (!method.isConstructor) {
      model.methods.push(method)
      model.methodNameTokenKeys.add(`${nameTok.line}:${nameTok.col}`)
      for (const param of params) model.params.push({ ...param, methodName: method.name })
      if (bodyStart >= 0) scanLocals(bodyStart, bodyEnd, method)
    } else {
      model.constructorNameTokenKeys.add(`${nameTok.line}:${nameTok.col}`)
      for (const param of params) model.extras.push({ ...param, kind: 'constructor-param' })
      if (bodyStart >= 0) scanLocals(bodyStart, bodyEnd, method)
    }
    return { next }
  }

  const parseFieldOrMethod = (start, typeDecl, startInfo) => {
    // Constructor: identifier equal to the type name followed by '('.
    const t = tokens[start]
    if (t && t.kind === 'ident' && t.value === typeDecl.name && tokens[start + 1] && tokens[start + 1].value === '(') {
      return parseMethodOrConstructor(start, typeDecl, { ...startInfo, isConstructor: true })
    }
    const type = tryParseType(start)
    if (!type) return null
    const nameTok = tokens[type.next]
    if (!nameTok || nameTok.kind !== 'ident') return null
    const after = tokens[type.next + 1]
    if (!after) return null
    if (after.value === '(') {
      return parseMethodOrConstructor(type.next, typeDecl, { ...startInfo, returnType: type.typeName })
    }
    if (after.value === '=' || after.value === ';' || after.value === ',' || after.value === '[') {
      // Field declarator list: NAME (arrays) (= init)? (, NAME ...)* ;
      let k = type.next
      let guard = 0
      while (k < tokens.length && guard < 200) {
        guard += 1
        const declarator = tokens[k]
        if (!declarator || declarator.kind !== 'ident') break
        model.fields.push({
          name: declarator.value,
          line: startInfo.line,
          col: declarator.col,
          typeName: type.typeName,
          annotations: startInfo.annotations.slice(),
          modifiers: startInfo.modifiers.slice(),
          typeName: type.typeName,
          owner: typeDecl.name,
        })
        k += 1
        while (tokens[k] && tokens[k].value === '[' && tokens[k + 1] && tokens[k + 1].value === ']') k += 2
        let depth = 0
        while (k < tokens.length) {
          const v = tokens[k].value
          if (depth === 0 && (v === ';' || v === ',')) break
          if (v === '(' || v === '{' || v === '[') depth += 1
          else if (v === ')' || v === '}' || v === ']') depth -= 1
          k += 1
        }
        if (tokens[k] && tokens[k].value === ',') {
          k += 1
          continue
        }
        if (tokens[k] && tokens[k].value === ';') return { next: k + 1 }
        return { next: k }
      }
      return { next: k }
    }
    return null
  }

  /* ----- local declarations / extras inside a method body ----- */

  const parseLocalDeclaration = (start, limit) => {
    let k = skipAnnotationsAndModifiers(start, limit)
    // javalang sets the declaration position at the first token of the statement
    // (annotation/modifier included), not at the type token.
    const declLine = (tokens[start] || tokens[k] || {}).line || 0
    // `var x = ...` is not a javalang LocalVariableDeclaration; treat as extra.
    const isVar = tokens[k] && tokens[k].kind === 'ident' && tokens[k].value === 'var'
    const type = tryParseType(k)
    if (!type) return null
    const nameTok = tokens[type.next]
    if (!nameTok || nameTok.kind !== 'ident') return null
    const after = tokens[type.next + 1]
    if (!after) return null
    const declarators = [{ name: nameTok.value, line: declLine, col: nameTok.col }]
    let next = type.next + 1
    if (after.value === ':') {
      next = type.next + 2
      return { typeName: type.typeName, declarators, next, kind: 'foreach', isVar }
    }
    if (after.value !== '=' && after.value !== ';' && after.value !== ',' && after.value !== '[') return null
    let k2 = type.next
    let guard = 0
    while (k2 < limit && guard < 200) {
      guard += 1
      const declarator = tokens[k2]
      if (!declarator || declarator.kind !== 'ident') break
      if (k2 !== type.next) declarators.push({ name: declarator.value, line: declLine, col: declarator.col })
      k2 += 1
      while (tokens[k2] && tokens[k2].value === '[' && tokens[k2 + 1] && tokens[k2 + 1].value === ']') k2 += 2
      let depth = 0
      while (k2 < limit) {
        const v = tokens[k2].value
        if (depth === 0 && (v === ';' || v === ',')) break
        if (v === '(' || v === '{' || v === '[') depth += 1
        else if (v === ')' || v === '}' || v === ']') depth -= 1
        k2 += 1
      }
      if (tokens[k2] && tokens[k2].value === ',') {
        k2 += 1
        continue
      }
      if (tokens[k2] && tokens[k2].value === ';') return { typeName: type.typeName, declarators, next: k2 + 1, kind: 'local', isVar }
      return { typeName: type.typeName, declarators, next: k2, kind: 'local', isVar }
    }
    return { typeName: type.typeName, declarators, next: k2, kind: 'local', isVar }
  }

  const parseCatch = (openIndex, limit) => {
    // tokens[openIndex] === '(' of `catch (A | B e)`
    let k = openIndex + 1
    k = skipAnnotationsAndModifiers(k, limit)
    let firstType = null
    let nameTok = null
    while (k < limit && tokens[k].value !== ')') {
      const type = tryParseType(k)
      if (type) {
        if (!firstType) firstType = type.typeName
        k = type.next
        const maybeName = tokens[k]
        if (maybeName && maybeName.kind === 'ident' && tokens[k + 1] && tokens[k + 1].value === ')') {
          nameTok = maybeName
          k += 1
        }
        continue
      }
      k += 1
    }
    if (nameTok && firstType) {
      model.extras.push({ name: nameTok.value, line: nameTok.line, col: nameTok.col, typeName: firstType, kind: 'catch' })
    }
    return k
  }

  const parseTryResources = (openIndex, limit) => {
    // tokens[openIndex] === '(' of `try (Res a = ...; Res b = ...)`
    const closeIndex = matchClose(openIndex, '(', ')')
    let k = openIndex + 1
    while (k < closeIndex) {
      const decl = parseLocalDeclaration(k, closeIndex)
      if (decl && decl.kind !== 'foreach') {
        for (const declarator of decl.declarators) {
          model.extras.push({ name: declarator.name, line: declarator.line, col: declarator.col, typeName: decl.typeName, kind: 'try-resource' })
        }
        k = decl.next
        if (tokens[k] && tokens[k].value === ';') k += 1
        continue
      }
      k += 1
    }
    return closeIndex
  }

  const parseLambdaParams = (arrowIndex) => {
    const prev = tokens[arrowIndex - 1]
    if (!prev) return
    if (prev.kind === 'ident') {
      model.extras.push({ name: prev.value, line: prev.line, col: prev.col, typeName: '', kind: 'lambda' })
      return
    }
    if (prev.value !== ')') return
    // find the matching '(' backwards
    let depth = 0
    let open = -1
    for (let k = arrowIndex - 1; k >= 0; k -= 1) {
      const v = tokens[k].value
      if (v === ')') depth += 1
      else if (v === '(') {
        depth -= 1
        if (depth === 0) {
          open = k
          break
        }
      }
    }
    if (open < 0) return
    let k = open + 1
    while (k < arrowIndex) {
      const t = tokens[k]
      if (t.value === ',') {
        k += 1
        continue
      }
      if (t.value === '(' || t.value === ')') {
        k += 1
        continue
      }
      const type = tryParseType(k)
      if (type) {
        const nameTok = tokens[type.next]
        if (nameTok && nameTok.kind === 'ident') {
          model.extras.push({ name: nameTok.value, line: nameTok.line, col: nameTok.col, typeName: type.typeName, kind: 'lambda' })
          k = type.next + 1
          continue
        }
        k = type.next
        continue
      }
      if (t.kind === 'ident') {
        model.extras.push({ name: t.value, line: t.line, col: t.col, typeName: '', kind: 'lambda' })
        k += 1
        continue
      }
      k += 1
    }
  }

  const scanLocals = (bodyStart, bodyEnd, methodInfo) => {
    const limit = bodyEnd
    const starters = new Set(['{', ';', '}', '(', ')', 'else', 'do', 'finally'])
    for (let k = bodyStart + 1; k < limit; k += 1) {
      const t = tokens[k]
      if (!t) break
      if (t.value === 'catch' && tokens[k + 1] && tokens[k + 1].value === '(') {
        k = parseCatch(k + 1, limit)
        continue
      }
      if (t.value === 'try' && tokens[k + 1] && tokens[k + 1].value === '(') {
        k = parseTryResources(k + 1, limit)
        continue
      }
      if (t.value === '->') {
        parseLambdaParams(k)
        continue
      }
      const prev = tokens[k - 1]
      const startish = !prev || starters.has(prev.value)
      if (!startish) continue
      if (t.kind !== 'ident' && t.kind !== 'keyword' && t.value !== '@') continue
      const decl = parseLocalDeclaration(k, limit)
      if (!decl) continue
      // javalang models for-init / for-each declarations as plain
      // `VariableDeclaration` (no position), and they are therefore absent from
      // `_var_decls`. Keep them as "extras" so they only win when the
      // javalang-equivalent pool has no declaration of that name.
      const inForHeader = !!(prev && prev.value === '(' && tokens[k - 2] && tokens[k - 2].value === 'for')
      const target = decl.isVar || decl.kind === 'foreach' || inForHeader ? model.extras : model.locals
      for (const declarator of decl.declarators) {
        target.push({
          name: declarator.name,
          line: declarator.line,
          col: declarator.col,
          typeName: decl.typeName,
          kind: decl.isVar ? 'var' : decl.kind,
          ownerMethod: methodInfo ? methodInfo.name : '',
        })
      }
      k = decl.next - 1
    }
  }

  /* ----- type bodies ----- */

  const parseEnumConstants = (typeDecl) => {
    let k = typeDecl.bodyStart + 1
    let membersStart = typeDecl.bodyEnd
    while (k < typeDecl.bodyEnd) {
      const t = tokens[k]
      if (!t) break
      if (t.value === ';') {
        membersStart = k + 1
        break
      }
      if (t.value === '}') {
        membersStart = typeDecl.bodyEnd
        break
      }
      if (t.value === '@') {
        k = readAnnotation(k).next
        continue
      }
      if (t.kind === 'ident') {
        model.enumConstants.push({ name: t.value, line: t.line, col: t.col, owner: typeDecl.name })
        k += 1
        if (tokens[k] && tokens[k].value === '(') k = matchClose(k, '(', ')') + 1
        if (tokens[k] && tokens[k].value === '{') k = matchBrace(k) + 1
        continue
      }
      k += 1
    }
    return membersStart
  }

  const parseTypeBody = (typeDecl, membersStart) => {
    let i = membersStart
    const end = typeDecl.bodyEnd
    let annotations = []
    let modifiers = []
    while (i < end) {
      const t = tokens[i]
      if (!t) break
      if (t.value === ';') {
        annotations = []
        modifiers = []
        i += 1
        continue
      }
      if (isTypeDeclStart(tokens, i)) {
        const consumed = parseTypeDecl(i, typeDecl, { annotations, modifiers, line: t.line })
        annotations = []
        modifiers = []
        if (consumed && consumed.next > i) {
          i = consumed.next
          continue
        }
        i += 1
        continue
      }
      if (t.value === '@') {
        const annotation = readAnnotation(i)
        if (annotation.name) annotations.push(annotation.name.split('.').pop())
        i = annotation.next
        continue
      }
      if (t.kind === 'keyword' && MODIFIERS.has(t.value)) {
        modifiers.push(t.value)
        i += 1
        continue
      }
      if (t.value === '{') {
        // initializer block
        i = matchBrace(i) + 1
        annotations = []
        modifiers = []
        continue
      }
      if (t.value === '<') {
        // generic method type parameters
        i = skipAngles(i)
        continue
      }
      if (t.kind === 'ident' || t.kind === 'keyword') {
        // javalang's member position is the first token after modifiers
        // (i.e. the return type / 'void' / constructor name).
        const startLine = t.line
        const decl = parseFieldOrMethod(i, typeDecl, { annotations, modifiers, line: startLine })
        if (decl && decl.next > i) {
          i = decl.next
          annotations = []
          modifiers = []
          continue
        }
      }
      annotations = []
      modifiers = []
      i += 1
    }
  }

  const parseTypeDecl = (index, parentDecl, startInfo) => {
    let k = index
    let kind = 'class'
    if (tokens[k].value === '@') {
      kind = 'annotation'
      k += 2 // '@' + 'interface'
    } else {
      kind = tokens[k].value
      k += 1
    }
    const nameTok = tokens[k]
    if (!nameTok || nameTok.kind !== 'ident') return { next: index + 1 }
    k += 1
    const decl = {
      name: nameTok.value,
      kind,
      line: startInfo && startInfo.line ? startInfo.line : nameTok.line,
      col: nameTok.col,
      annotations: startInfo && startInfo.annotations ? startInfo.annotations.slice() : [],
      modifiers: startInfo && startInfo.modifiers ? startInfo.modifiers.slice() : [],
      typeParams: [],
      extendsNames: [],
      implementsNames: [],
      parent: parentDecl ? parentDecl.name : null,
      bodyStart: -1,
      bodyEnd: -1,
    }
    if (tokens[k] && tokens[k].value === '<') {
      // type parameters: collect names for completeness
      const endAngle = skipAngles(k)
      for (let j = k + 1; j < endAngle - 1; j += 1) {
        if (tokens[j].kind === 'ident' && (tokens[j - 1].value === '<' || tokens[j - 1].value === ',')) {
          decl.typeParams.push(tokens[j].value)
        }
      }
      k = endAngle
    }
    const readNameList = (untilValues) => {
      const names = []
      while (k < tokens.length) {
        const t = tokens[k]
        if (untilValues.has(t.value) || t.value === '{') break
        if (t.kind === 'ident') {
          // javalang's ReferenceType.name is the FIRST identifier of a qualified
          // name (`Map.Entry` -> 'Map'), so record that and skip the rest.
          names.push(t.value)
          k += 1
          if (tokens[k] && tokens[k].value === '<') k = skipAngles(k)
          while (tokens[k] && tokens[k].value === '.' && tokens[k + 1] && tokens[k + 1].kind === 'ident') {
            k += 2
            if (tokens[k] && tokens[k].value === '<') k = skipAngles(k)
          }
          while (tokens[k] && tokens[k].value === '[' && tokens[k + 1] && tokens[k + 1].value === ']') k += 2
          if (tokens[k] && tokens[k].value === ',') {
            k += 1
            continue
          }
          break
        }
        k += 1
        break
      }
      return names
    }
    while (k < tokens.length) {
      const t = tokens[k]
      if (t.value === '{') {
        decl.bodyStart = k
        decl.bodyEnd = matchBrace(k)
        break
      }
      if (t.value === 'extends') {
        k += 1
        decl.extendsNames = readNameList(new Set(['implements', 'permits', '{']))
        continue
      }
      if (t.value === 'implements') {
        k += 1
        decl.implementsNames = readNameList(new Set(['permits', '{']))
        continue
      }
      if (t.value === 'permits') {
        k += 1
        readNameList(new Set(['{']))
        continue
      }
      if (t.value === '(') {
        // record components
        const close = matchClose(k, '(', ')')
        let j = k + 1
        while (j < close) {
          const pstart = skipAnnotationsAndModifiers(j, close)
          j = pstart
          const ptype = tryParseType(j)
          if (!ptype) {
            j += 1
            continue
          }
          const pnameTok = tokens[ptype.next]
          if (pnameTok && pnameTok.kind === 'ident') {
            model.extras.push({ name: pnameTok.value, line: decl.line, col: pnameTok.col, typeName: ptype.typeName, kind: 'record-component' })
            j = ptype.next + 1
          } else {
            j = ptype.next
          }
          if (tokens[j] && tokens[j].value === ',') j += 1
        }
        k = close + 1
        continue
      }
      k += 1
    }
    model.types.push(decl)
    if (decl.bodyStart >= 0) {
      const membersStart = kind === 'enum' ? parseEnumConstants(decl) : decl.bodyStart + 1
      parseTypeBody(decl, membersStart)
    }
    return { next: decl.bodyEnd >= 0 ? decl.bodyEnd + 1 : k }
  }

  /* ----- compilation unit ----- */

  let i = 0
  let annotations = []
  let modifiers = []
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.value === ';') {
      i += 1
      continue
    }
    if (t.value === 'package') {
      let k = i + 1
      let name = ''
      while (k < tokens.length && tokens[k].value !== ';') {
        name += tokens[k].value
        k += 1
      }
      model.pkg = name || null
      i = k + 1
      continue
    }
    if (t.value === 'import') {
      let k = i + 1
      let isStatic = false
      if (tokens[k] && tokens[k].value === 'static') {
        isStatic = true
        k += 1
      }
      let importPath = ''
      let wildcard = false
      while (k < tokens.length && tokens[k].value !== ';') {
        if (tokens[k].value === '*') wildcard = true
        else importPath += tokens[k].value
        k += 1
      }
      model.imports.push({ path: importPath, static: isStatic, wildcard })
      i = k + 1
      continue
    }
    if (t.value === '@') {
      if (tokens[i + 1] && tokens[i + 1].value === 'interface') {
        const consumed = parseTypeDecl(i, null, { annotations, modifiers, line: t.line })
        annotations = []
        modifiers = []
        i = consumed.next > i ? consumed.next : i + 1
        continue
      }
      const annotation = readAnnotation(i)
      if (annotation.name) annotations.push(annotation.name.split('.').pop())
      i = annotation.next
      continue
    }
    if (t.kind === 'keyword' && MODIFIERS.has(t.value)) {
      modifiers.push(t.value)
      i += 1
      continue
    }
    if (isTypeDeclStart(tokens, i)) {
      const consumed = parseTypeDecl(i, null, { annotations, modifiers, line: t.line })
      annotations = []
      modifiers = []
      i = consumed.next > i ? consumed.next : i + 1
      continue
    }
    annotations = []
    modifiers = []
    i += 1
  }

  // Field declarations that are also enum constants and/or static-final constants
  // are covered by the text helpers below; nothing more to do here.
  return model
}

/* ------------------------------------------------------- text-level helpers */

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Lombok getter/setter/is method name -> field name (original `_getter_field_name`). */
export function getterFieldName(name) {
  const text = String(name || '')
  for (const prefix of ['get', 'set']) {
    if (text.startsWith(prefix) && text.length > 3 && text[3] >= 'A' && text[3] <= 'Z') {
      const field = text.slice(3)
      return field.length > 1 && field[1] >= 'A' && field[1] <= 'Z' ? field : field[0].toLowerCase() + field.slice(1)
    }
  }
  if (text.startsWith('is') && text.length > 2 && text[2] >= 'A' && text[2] <= 'Z') {
    const field = text.slice(2)
    return field.length > 1 && field[1] >= 'A' && field[1] <= 'Z' ? field : field[0].toLowerCase() + field.slice(1)
  }
  return null
}

export function hasLombokAnnotation(annotations) {
  for (const name of annotations || []) {
    const simple = String(name || '').split('.').pop()
    if (simple === 'Getter' || simple === 'Setter' || simple === 'Data') return true
  }
  return false
}

/**
 * Enum constant / static-final constant declaration line by text — the original
 * `_find_const_decl_line_text` (javalang enum constants have no position, so the
 * original also used a text scan here).
 */
export function findConstDeclLineText(content, name) {
  if (!content || !name) return null
  const escaped = escapeRegExp(name)
  const enumRe = new RegExp(`^\\s*${escaped}\\s*(?:\\(|,|;|=)`)
  const fieldRe = new RegExp(`\\bstatic\\s+final\\b[^;]*\\b${escaped}\\s*=`)
  const lines = String(content).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (enumRe.test(lines[index]) || fieldRe.test(lines[index])) return index + 1
  }
  return null
}

const CALL_KEYWORDS = new Set([
  'return', 'new', 'throw', 'throws', 'case', 'else', 'yield', 'await',
  'assert', 'instanceof', 'void', 'this', 'super',
])

/**
 * Method declaration line by text — port of the original `_find_method_decl_text`
 * (used there when javalang could not parse a file; here mostly as a safety net).
 */
export function findMethodDeclText(content, name) {
  if (!content || !name) return null
  const nameRe = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`)
  const typeHeadRe = /[\w$<>[\],]\s+$/
  const tailRe = /[^)]*\)\s*(?:throws[\w\s,.]*)?[{;]/
  const lines = String(content).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const s = raw.trim()
    if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue
    const m = nameRe.exec(raw)
    if (!m) continue
    const head = raw.slice(0, m.index)
    if (!typeHeadRe.test(head)) continue
    const headTokens = head.match(/[\w$<>[\],.]+/g) || []
    if (headTokens.length && CALL_KEYWORDS.has(headTokens[headTokens.length - 1])) continue
    tailRe.lastIndex = 0
    if (!tailRe.exec(raw.slice(m.index + m[0].length - 1))) continue
    return index + 1
  }
  return null
}

/** Type declaration line by text — port of the original `_find_type_decl_text`. */
export function findTypeDeclText(content, name) {
  if (!content || !name) return null
  const rx = new RegExp(
    `^\\s*(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed)\\s+)*` +
      `(?:class|interface|enum|record|@interface)\\s+${escapeRegExp(name)}\\b`,
  )
  const lines = String(content).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (rx.test(lines[index])) return index + 1
  }
  return null
}

/** `X.CONST` / `com.pvh.X.CONST` -> receiver type name (`X` or the qualified prefix). */
export function constReceiver(srcText, line, col1, name) {
  if (!srcText || !name) return null
  const lines = String(srcText).split('\n')
  if (line < 1 || line > lines.length) return null
  const text = lines[line - 1]
  let idx = col1 - 1
  if (idx < 0 || text.slice(idx, idx + name.length) !== name) {
    idx = text.indexOf(name)
    if (idx < 0) return null
  }
  const prefix = text.slice(0, idx).replace(/\s+$/, '')
  if (!prefix.endsWith('.')) return null
  const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(prefix.slice(0, -1).replace(/\s+$/, ''))
  return m ? m[1] : null
}

/** `X::method` on the clicked line -> qualifier ident (or null). */
export function findMethodRefText(lineText, col1, name) {
  const rx = /([A-Za-z_$][\w$]*)\s*::\s*([A-Za-z_$][\w$]*)/g
  let m
  const text = String(lineText || '')
  while ((m = rx.exec(text)) !== null) {
    if (m[2] !== name) continue
    const start = m.index + m[0].indexOf('::') + 2 + 1 // 1-based column of the member name
    const end = m.index + m[0].length
    if (start <= col1 && col1 <= end) return m[1]
  }
  return null
}

/**
 * Chain head identifier for a clicked method member at `member_col1` — port of
 * the original `_chain_head_ident`: 'svc.getUser().getName()' at getName -> 'svc'.
 */
export function chainHeadIdent(lineText, memberCol1) {
  const text = String(lineText || '')
  let prefix = text.slice(0, memberCol1 - 1).replace(/\s+$/, '')
  if (!prefix.endsWith('.')) return null
  let i = prefix.length - 1 // trailing '.'
  let head = null
  let guard = 0
  while (guard < 400) {
    guard += 1
    let j = i - 1
    while (j >= 0 && (prefix[j] === ' ' || prefix[j] === '\t')) j -= 1
    if (j < 0) return head
    if (prefix[j] === ')') {
      let depth = 0
      let k = j
      while (k >= 0) {
        if (prefix[k] === ')') depth += 1
        else if (prefix[k] === '(') {
          depth -= 1
          if (depth === 0) break
        }
        k -= 1
      }
      if (depth !== 0 || k < 0) return head
      j = k - 1
      while (j >= 0 && (prefix[j] === ' ' || prefix[j] === '\t')) j -= 1
    }
    let s = j
    while (s >= 0 && /[A-Za-z0-9_$]/.test(prefix[s])) s -= 1
    if (s === j) return head
    const ident = prefix.slice(s + 1, j + 1)
    head = ident
    let k = s
    while (k >= 0 && (prefix[k] === ' ' || prefix[k] === '\t')) k -= 1
    if (k < 0 || prefix[k] !== '.') return head
    i = k
  }
  return head
}

/* -------------------------------------------------------- token positioning */

/** Ident token at a click coordinate; tolerant when the client column is 1 off. */
export function findIdentTokenAt(model, line, col1, name) {
  const lineTokens = model.tokensByLine[line - 1] || []
  const matches = lineTokens.filter((token) => token.kind === 'ident' && (!name || token.value === name))
  if (!matches.length) return null
  const col = Number(col1) || 0
  const offsets = [col, col + 1, col - 1]
  for (const candidate of offsets) {
    for (const token of matches) {
      if (candidate >= token.col && candidate < token.col + token.value.length) return token
    }
  }
  if (matches.length === 1) return matches[0]
  // Several same-named tokens on the line: pick the nearest to the click column.
  let best = matches[0]
  let bestDistance = Infinity
  for (const token of matches) {
    const distance = Math.abs(token.col - col)
    if (distance < bestDistance) {
      best = token
      bestDistance = distance
    }
  }
  return best
}

export function tokenIndex(model, token) {
  if (!token) return -1
  return model.tokens.indexOf(token)
}

export function isMethodDeclTokenToken(model, token) {
  return !!token && model.methodNameTokenKeys.has(`${token.line}:${token.col}`)
}

export function isConstructorDeclToken(model, token) {
  return !!token && model.constructorNameTokenKeys.has(`${token.line}:${token.col}`)
}

/**
 * First identifier of the receiver chain that precedes a call token, e.g. for
 * `a.b().c()` clicked at `c` -> 'a'; for `this.foo()` -> 'this'; for a bare call
 * -> null. Mirrors what `qualifier.split('.')[0]` gives in the original.
 */
export function callQualifierFirstSegment(model, token) {
  const index = tokenIndex(model, token)
  if (index < 0) return null
  const tokens = model.tokens
  let k = index - 1
  // only a call if preceded by '.'
  if (!tokens[k] || tokens[k].value !== '.') return null
  k -= 1
  let first = null
  let guard = 0
  while (guard < 200) {
    guard += 1
    if (!tokens[k]) return first
    // previous element may be `)` (finished call) -> jump to its '('
    if (tokens[k].value === ')') {
      let depth = 0
      let j = k
      while (j >= 0) {
        if (tokens[j].value === ')') depth += 1
        else if (tokens[j].value === '(') {
          depth -= 1
          if (depth === 0) break
        }
        j -= 1
      }
      if (j < 0) return first
      k = j - 1
      continue
    }
    if (tokens[k].kind === 'ident' || (tokens[k].kind === 'keyword' && (tokens[k].value === 'this' || tokens[k].value === 'super'))) {
      first = tokens[k].value
      k -= 1
      if (tokens[k] && tokens[k].value === '.') {
        k -= 1
        continue
      }
      return first
    }
    return first
  }
  return first
}

/** True when the token is directly followed by '(' (a call / declaration shape). */
export function isCallShaped(model, token) {
  const index = tokenIndex(model, token)
  if (index < 0) return false
  const next = model.tokens[index + 1]
  if (!next || next.value !== '(') return false
  const prev = model.tokens[index - 1]
  if (prev && (prev.value === 'new' || prev.value === '@')) return false
  return true
}

/** Earliest method declaration with `name` (javalang `_find_method_decl`). */
export function earliestMethodDecl(model, name) {
  let best = null
  for (const method of model.methods) {
    if (method.name !== name) continue
    if (!best || method.line < best.line) best = method
  }
  return best
}

/** First type declaration with `name` (javalang `_find_type_decl`). */
export function findTypeDecl(model, name) {
  let best = null
  for (const decl of model.types) {
    if (decl.name !== name) continue
    if (!best || decl.line < best.line) best = decl
  }
  return best
}

/** Field declaration lines with `name`; with Lombok filter as in the original. */
export function findFieldLines(model, name, withLombok) {
  const lines = []
  for (const field of model.fields) {
    if (field.name !== name) continue
    if (withLombok) {
      const owner = model.types.find((decl) => decl.name === field.owner)
      const lombok = hasLombokAnnotation(field.annotations) || (owner && hasLombokAnnotation(owner.annotations))
      if (!lombok) continue
    }
    lines.push(field.line)
  }
  lines.sort((a, b) => a - b)
  return lines
}
