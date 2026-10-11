# -*- coding: utf-8 -*-
"""JS / TS / Vue 前端定义跳转解析（供 server.py 的 /api/web/def 使用）。

与 Java 的 javalang AST 方案不同：前端没有等价的标准解析器，这里用行级正则+
小状态机，覆盖实际开发中最高频的跳转场景：

  1. import ... from '<path>'        → 解析 <path> 到具体文件（相对路径 / @别名）
  2. import { x } from './a.js'      → 跳到 a.js 里 x 的定义行（具名导入）
     import D from './a.ts'          → 跳到 a.ts 里 default 导出的定义行
     import * as ns from './a'       → 跳到 a 的文件头
  3. require('./x') / require("@/x") → 同 2
  4. Vue SFC：<FooBar />、<foo-bar> 组件标签 → 同目录/常见子目录下的 FooBar.vue
     <RouterLink> 这类内置/全局组件不跳（未在项目内找到同名 .vue）
  5. Vue SFC 内 <script setup> 里的顶层 const/function/interface/type/class 声明行
  6. <style>、普通 JS/TS 内的本地声明（const/let/var/function/class/interface/type/enum）

设计约束：
  · 只做「行 → 文件/行」的定位，不做完整作用域/类型推导；
  · 解析失败一律返回 None（前端保持"未找到定义"，不误跳）；
  · 路径解析限定在来源文件所属项目内（与 _search_file 一致，不跨项目）。
"""

import os
import re

# ---------- 语言判定 ----------

class _Sentinel:
    __slots__ = ("_label",)

    def __init__(self, label):
        self._label = label

    def __repr__(self):
        return "<%s>" % self._label


_MISS = _Sentinel("MISS")        # 该 import 子句里没有这个符号
_NAMESPACE = _Sentinel("NS")     # import * as ns —— 对端无具名符号
_DEFAULT = "default"


_JS_EXT = (".js", ".jsx", ".mjs", ".cjs")
_TS_EXT = (".ts", ".tsx", ".mts", ".cts")
_WEB_EXT = _JS_EXT + _TS_EXT + (".vue",)

# 解析时可接受的补全扩展名（按优先级）
_RESOLVE_EXT_ORDER = (".ts", ".tsx", ".vue", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
# index 形式补全
_INDEX_NAMES = ("index.ts", "index.tsx", "index.js", "index.jsx", "index.vue",
                "index.mjs", "index.cjs", "index.mts", "index.cts")


def is_web_file(path):
    return (path or "").lower().endswith(_WEB_EXT)


def is_vue_file(path):
    return (path or "").lower().endswith(".vue")


# ---------- import 语句识别 ----------

# import ... from 'xxx'   /  import 'xxx'   /  import('xxx') 动态导入
_RE_IMPORT_FROM = re.compile(
    r"""(?:^|[^\w$.])import\s+(?P<clause>[^'"();]*?)\s*from\s*['"](?P<mod>[^'"]+)['"]""",
    re.M)
_RE_IMPORT_BARE = re.compile(
    r"""(?:^|[^\w$.])import\s*['"](?P<mod>[^'"]+)['"]""", re.M)
_RE_REQUIRE = re.compile(
    r"""require\s*\(\s*['"](?P<mod>[^'"]+)['"]\s*\)""")
_RE_DYNAMIC = re.compile(
    r"""\bimport\s*\(\s*['"](?P<mod>[^'"]+)['"]\s*\)""")
# export ... from 'xxx'  → re-export
_RE_EXPORT_FROM = re.compile(
    r"""(?:^|[^\w$.])export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+)\s+from\s*['"](?P<mod>[^'"]+)['"]""",
    re.M)


def _iter_module_specs(src_text):
    """产出 (module_spec, line_no, clause) —— clause 为该 import 的导入子句原文。

    行号以「模块说明符引号所在位置」为准（不是 import 关键字），
    正则的前缀 (?:^|[^\w$.]) 会多匹配一个字符，用 m.start('mod') 才准确。
    去重按 (mod, line) —— 同一模块可能在文件里被 import 多次（不同行），
    只按 mod 去重会丢掉后面的行，导致点击那些行时匹配不到。
    """
    seen = set()
    for rx in (_RE_IMPORT_FROM, _RE_EXPORT_FROM):
        for m in rx.finditer(src_text):
            mod = m.group("mod")
            pos = m.start("mod")
            line = src_text.count("\n", 0, pos) + 1
            key = (mod, line)
            if key in seen:
                continue
            seen.add(key)
            clause = m.groupdict().get("clause") or ""
            yield mod, line, clause
    for rx in (_RE_IMPORT_BARE, _RE_DYNAMIC, _RE_REQUIRE):
        for m in rx.finditer(src_text):
            mod = m.group("mod")
            line = src_text.count("\n", 0, m.start("mod")) + 1
            key = (mod, line)
            if key in seen:
                continue
            seen.add(key)
            yield mod, line, ""


# ---------- 模块路径 → 候选文件 ----------

_RE_JS_ALIAS = re.compile(
    r"""(?:^|\s)(?:const|let|var)\s+(\w+)\s*=\s*['"]([^'"]+)['"]""")


def _dir_of(rel_path):
    p = (rel_path or "").replace("\\", "/")
    return p.rsplit("/", 1)[0] if "/" in p else ""


def _join_rel(base_dir, *parts):
    out = base_dir
    for p in parts:
        if not p:
            continue
        if out:
            out = out + "/" + p
        else:
            out = p
    # 规范化 . / ..
    segs = []
    for s in out.split("/"):
        if s in ("", "."):
            continue
        if s == "..":
            if segs:
                segs.pop()
            continue
        segs.append(s)
    return "/".join(segs)


def resolve_module(spec, src_rel, src_text=None, exists=None):
    """模块说明符 → 候选相对路径列表（已按优先级排序；不做存在性过滤，由调用方逐个试）。

    src_rel 是「项目内相对路径」（不含多项目 vtop 前缀）。
    exists 注入时只返回首个存在的候选；不注入则返回全部候选。

    解析基准：
      · './a' '../b'  → 相对来源文件所在目录
      · '@/a'        → 别名。先试「项目内任一 src 根」下的 a，再试「来源目录向上回退到 src」，
                        最后试来源目录同层（少数项目 @ 直接指向根）
      · '~/a'        → 同 @/（常见于 vite/vue-cli 别名）
      · '/a'         → 项目根下的 a
      · 裸名 'vue'   → 外部依赖，返回 []
    """
    spec = (spec or "").strip()
    if not spec or spec.startswith(("http:", "https:", "//", "data:")):
        return []
    if not (spec.startswith((".", "~", "@", "/"))):
        return []          # 裸包名 = 外部依赖，不在项目内查找

    base_dir = _dir_of(src_rel)

    # --- 别名/绝对写法：剥掉前缀，得到「去掉 src/ 前缀」的相对片段 ---
    if spec.startswith("~"):
        alias = spec[1:]
    elif spec.startswith("@/"):
        alias = spec[2:]
    elif spec.startswith("@"):
        alias = spec[1:]           # '@src/a' → 'src/a'
    elif spec.startswith("/"):
        alias = spec.lstrip("/")   # '/src/a' → 'src/a'
    else:
        alias = None

    if alias is None:
        # 相对路径：以来源目录为基准
        bases = [_join_rel(base_dir, spec)]
    else:
        # 别名：多个可能的锚点，按常见度排序
        alias = alias.lstrip("./")
        stripped = re.sub(r"^(?:src|lib|app|packages)/", "", alias)
        bases = []
        # a) 走完整别名（含 src/ 前缀，如 '@src/a'）—— 项目内锚点
        bases.append(alias)
        # b) 剥掉 src/ 前缀后，锚到来源文件向上回退找到的 src 根
        src_root = _find_src_root(base_dir)
        if src_root is not None and stripped:
            bases.append(_join_rel(src_root, stripped))
            bases.append(src_root + "/" + stripped)
        # c) 项目根（从 base_dir 逐级向上，最多 6 层）
        proj_root = _find_proj_root(base_dir)
        if proj_root is not None and stripped:
            bases.append(_join_rel(proj_root, stripped))
        # d) 兜底：来源目录同层
        bases.append(_join_rel(base_dir, stripped))
        if stripped != alias:
            bases.append(_join_rel(base_dir, alias))

    cands, seen = [], set()
    for b in bases:
        if not b or b in seen:
            continue
        seen.add(b)
        for ext in _RESOLVE_EXT_ORDER:      # .ts .tsx .vue .js ...
            cands.append(b + ext)
        cands.append(b)
        for nm in _INDEX_NAMES:            # b/index.ts
            cands.append(b + "/" + nm)

    # 去重保序（exists 注入时只返回首个命中）
    out, seen2 = [], set()
    for c in cands:
        if c in seen2:
            continue
        seen2.add(c)
        if exists is not None:
            if exists(c):
                return [c]
            continue
        out.append(c)
    return out


def _find_src_root(base_dir):
    """从来源目录逐级向上找最近的 src 目录（返回不含末尾斜杠的项目内相对路径，找不到 None）。"""
    parts = [p for p in (base_dir or "").split("/") if p and p != "."]
    for i in range(len(parts), -1, -1):
        head = "/".join(parts[:i])
        if head.rsplit("/", 1)[-1] in ("src", "lib", "app"):
            return head
        # 当前层就叫 src/lib/app
        if i < len(parts) and parts[i] in ("src", "lib", "app"):
            return "/".join(parts[:i + 1])
    return None


def _find_proj_root(base_dir):
    """从来源目录逐级向上找「项目根」标志（package.json / tsconfig.json 所在目录）。
    纯字符串近似：向上最多 8 层，遇到含 package.json/tsconfig.json/vite.config 的目录即止。
    仅用于生成候选（不做 IO），实际存在性由调用方用 exists 校验。"""
    parts = [p for p in (base_dir or "").split("/") if p and p != "."]
    for i in range(len(parts), -1, -1):
        head = "/".join(parts[:i])
        if not head:
            return None
        # 目录名像项目根（含 -/+ 或常见命名）
        last = head.rsplit("/", 1)[-1]
        if "-" in last or "_" in last or last.lower() in ("web", "frontend", "app", "ui", "client"):
            return head
        if i == 0:
            return ""
    return ""


# ---------- 目标文件内的定义行定位 ----------

# export default function name / export default class Name / export default identifier
_RE_EXPORT_DEFAULT_FN = re.compile(r"^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)")
_RE_EXPORT_DEFAULT_CLASS = re.compile(r"^\s*export\s+default\s+class\s+(\w+)")
_RE_EXPORT_DEFAULT_IDENT = re.compile(r"^\s*export\s+default\s+([A-Za-z_$][\w$]*)")
_RE_DECL_FN = re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)")
_RE_DECL_CLASS = re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)")
_RE_DECL_CONST_FN = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")
_RE_DECL_CONST = re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=")
_RE_DECL_INTERFACE = re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)")
_RE_DECL_TYPE = re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)")
_RE_DECL_ENUM = re.compile(r"^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)")
_RE_CLASS_MEMBER = re.compile(r"^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*"
                              r"([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*[:{]")
_RE_OBJ_PROP_FN = re.compile(r"^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(]")


def _strip_comments_line(line):
    """粗略去掉行尾 // 注释（不影响字符串内的 //，够用）。"""
    out, in_s, in_dq, in_sq, q = [], False, False, False, ""
    i = 0
    while i < len(line):
        c = line[i]
        nxt = line[i + 1] if i + 1 < len(line) else ""
        if in_s or in_dq or in_sq:
            out.append(c)
            if c == "\\":
                if i + 1 < len(line):
                    out.append(line[i + 1])
                i += 2
                continue
            if (in_s and c == q) or (in_dq and c == '"') or (in_sq and c == "'"):
                in_s = in_dq = in_sq = False
                q = ""
        else:
            if c == "/" and nxt == "/":
                break
            if c == "/" and nxt == "*":
                break
            if c in "\"'`":
                in_s, q = True, c
            out.append(c)
        i += 1
    return "".join(out)


def find_decl_line(target_text, name):
    """在目标文件内容里找标识符 name 的声明行；找不到返回 None。

    依次尝试：具名导入符号（export const/function/class/interface/type/enum/class 成员）
    → default 导出 → 任意顶层声明 → 对象字面量方法。
    """
    if not target_text or not name:
        return None
    lines = target_text.split("\n")
    # Vue SFC：先只搜 <script> 段（避免 <template> 里的同名标签误命中）
    script_lo, script_hi = 0, len(lines)
    for i, ln in enumerate(lines):
        if "<script" in ln:
            script_lo = i
        if "</script>" in ln:
            script_hi = i + 1
            break

    in_script = script_hi - script_lo > 0

    def scan(lo, hi):
        for i in range(lo, hi):
            raw = lines[i]
            ln = _strip_comments_line(raw)
            if not ln.strip():
                continue
            for rx, grp in ((_RE_DECL_FN, 1), (_RE_DECL_CLASS, 1),
                             (_RE_DECL_INTERFACE, 1), (_RE_DECL_TYPE, 1),
                             (_RE_DECL_ENUM, 1), (_RE_DECL_CONST_FN, 1),
                             (_RE_DECL_CONST, 1)):
                m = rx.match(ln)
                if m and m.group(grp) == name:
                    return i + 1
            # class 成员方法
            m = _RE_CLASS_MEMBER.match(ln)
            if m and m.group(1) == name:
                return i + 1
        return None

    hit = scan(script_lo, script_hi if in_script else len(lines))
    if hit:
        return hit
    # 兜底：整个文件（含 <template>）再找一次顶层声明
    if in_script:
        hit = scan(0, len(lines))
        if hit:
            return hit
    # default 导出（具名符号优先）
    for i in range(script_lo, script_hi if in_script else len(lines)):
        ln = _strip_comments_line(lines[i])
        for rx in (_RE_EXPORT_DEFAULT_FN, _RE_EXPORT_DEFAULT_CLASS, _RE_EXPORT_DEFAULT_IDENT):
            m = rx.match(ln)
            if m and m.group(1) == name:
                return i + 1
    return None


def find_imported_symbol(src_text, name):
    """本文件 import 进来的符号 name → (module_spec, 对端符号名)。

    支持：
      import { a, b as c } from './m'   → name 命中 a 返回 ('./m','a')；命中 c 返回 ('./m','a')
      import D from './m'               → name==D 返回 ('./m', 'default')
      import * as ns from './m'         → name==ns 或 ns.xxx 返回 ('./m', None)
      import D, { a } from './m'        → 分别处理
      const { a } = require('./m')      → 同解构
    找不到返回 None。
    """
    if not name or not src_text:
        return None

    # 1) import 子句 + 模块：逐条 import 语句匹配
    for m in _RE_IMPORT_FROM.finditer(src_text):
        clause = (m.group("clause") or "").strip()
        mod = m.group("mod")
        got = _match_import_clause(clause, name)
        if got is not _MISS:
            return mod, got

    # 2) require 解构：const { a, b } = require('./m') / const x = require('./m')
    for m in re.finditer(r"""(?:const|let|var)\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
                         src_text):
        clause, mod = m.group(1), m.group(2)
        got = _match_import_clause(clause, name)
        if got is not _MISS:
            return mod, got

    # 3) import * as ns from './m'（namespace 导入：对端没有具名符号，用 _NAMESPACE 标记）
    for m in re.finditer(r"""import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]""", src_text):
        ns, mod = m.group(1), m.group(2)
        if name == ns:
            return mod, _NAMESPACE
    return None


def _match_import_clause(clause, name):
    """在 import 子句里找 name；返回对端符号名（具名 / 'default' / _NAMESPACE），未命中返回 _MISS。

    注意判断顺序：先看是否在花括号具名列表里，再看 default/namespace 前缀形式。
    不能让 default 的正则（^ident(,|$)）先跑——否则 'computed, ref' 这种
    「花括号被正则 [^'\"();]*? 吃掉」的子句会把首项误判成 default。"""
    clause = (clause or "").strip()
    if not clause:
        return _MISS

    has_brace = bool(re.search(r"\{", clause))

    # 1) 花括号具名（可多个，支持 as 重命名：{ b as c } → 本地名 c，原名 b）
    bm = re.search(r"\{([^}]*)\}", clause)
    if bm:
        for part in bm.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                # 'b as c' → 本地名 c，对端原名 b
                orig, local = [x.strip() for x in part.split(" as ", 1)]
            else:
                local = orig = part
            if not re.match(r"^[A-Za-z_$][\w$]*$", local):
                continue
            if local == name:
                return orig
        # 花括号里没有 name：若子句还带一个 default 形参（D, { a }），继续看 default
        if not has_brace:
            return _MISS

    # 2) namespace 导入：import * as ns
    nm = re.match(r"^\*\s+as\s+([A-Za-z_$][\w$]*)$", clause)
    if nm:
        return _NAMESPACE if nm.group(1) == name else _MISS

    # 3) default 导入：import D from  /  import D, { a } from
    #    仅当子句里没有花括号时才把首项当 default；有花括号说明是 'D, { a }' 形式，
    #    首项仍是 default，但花括号内的符号已在第 1 步处理过。
    dm = re.match(r"^([A-Za-z_$][\w$]*)\s*(?:,|$)", clause)
    if dm:
        return "default" if dm.group(1) == name else _MISS
    return _MISS




def find_default_export_line(target_text):
    """目标文件的 default 导出定义行（import D from './x' 用）。"""
    if not target_text:
        return None
    lines = target_text.split("\n")
    for i, raw in enumerate(lines):
        ln = _strip_comments_line(raw)
        if _RE_EXPORT_DEFAULT_FN.match(ln) or _RE_EXPORT_DEFAULT_CLASS.match(ln):
            return i + 1
    # export default identifier;  → 找该标识符的声明
    for i, raw in enumerate(lines):
        ln = _strip_comments_line(raw)
        m = _RE_EXPORT_DEFAULT_IDENT.match(ln)
        if m:
            ident = m.group(1)
            hit = find_decl_line(target_text, ident)
            return hit if hit else i + 1
    # 可能是 export default { ... } 之类：跳到 export default 行
    for i, raw in enumerate(lines):
        if re.match(r"^\s*export\s+default\b", _strip_comments_line(raw)):
            return i + 1
    return None


# ---------- Vue 模板里的组件标签 ----------

# <FooBar />  <foo-bar>  <router-link>  <el-button>
_RE_VUE_TAG = re.compile(r"<\s*([A-Za-z][\w.-]*)\b")
# 组件名黑名单（内置/全局/HTML 标签，无需跳）
_VUE_BUILTIN = {
    "template", "script", "style", "div", "span", "p", "a", "ul", "ol", "li", "table", "thead",
    "tbody", "tr", "td", "th", "form", "input", "button", "select", "option", "label", "img",
    "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "nav", "section",
    "article", "aside", "main", "canvas", "svg", "path", "g", "circle", "rect", "line", "polyline",
    "iframe", "video", "audio", "textarea", "pre", "code", "strong", "em", "small", "span-",
}
_VUE_DIRECTIVE_PREFIX = (":", "@", "#", "v-", "v:", "slot")


def find_component_tag_line(vue_text, click_line, name_hint):
    """Vue SFC template 段里某组件标签所在行（用于点击 <FooBar/> 定位）。"""
    if not vue_text or not click_line or click_line < 1:
        return None
    lines = vue_text.split("\n")
    # template 段范围
    lo, hi = 0, len(lines)
    for i, ln in enumerate(lines):
        if "<template" in ln:
            lo = i
        if "</template>" in ln:
            hi = i + 1
            break
    for i in range(lo, hi):
        if i + 1 != click_line:
            continue
        ln = _strip_comments_line(lines[i])
        for m in _RE_VUE_TAG.finditer(ln):
            tag = m.group(1)
            if tag.lower() in _VUE_BUILTIN or tag in _VUE_BUILTIN:
                continue
            if name_hint and tag.lower() != name_hint.lower():
                continue
            return i + 1
    return None


def pascal_from_tag(tag):
    """kebab-case 标签名 → PascalCase：foo-bar → FooBar"""
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[-_]", tag) if p)


def vue_component_candidates(tag_name, src_rel):
    """组件名 → 可能的 .vue 相对路径（按项目常见布局排序）。

    同目录优先，其次 ./components/*、./views/*、../components/*、./xxx/* 等。
    """
    pascal = pascal_from_tag(tag_name)
    base_dir = _dir_of(src_rel)
    rel_dir = base_dir
    cands = []
    subs = ("", "components", "views", "pages", "component", "widget", "widgets", "ui")
    for sub in subs:
        d = _join_rel(rel_dir, sub) if sub else rel_dir
        cands.append(d + "/" + pascal + ".vue")
        cands.append(d + "/" + tag_name + ".vue")
    # 上级目录常见布局
    for up in ("..", "../.."):
        for sub in ("components", "views", "pages"):
            cands.append(_join_rel(base_dir, up, sub) + "/" + pascal + ".vue")
            cands.append(_join_rel(base_dir, up, sub) + "/" + tag_name + ".vue")
    # 全局 components 目录
    cands.append("src/components/" + pascal + ".vue")
    cands.append("src/views/" + pascal + ".vue")
    cands.append("components/" + pascal + ".vue")
    # 去重保序
    out, seen = [], set()
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out
