# Round 7 · 原版最近提交 × 插件功能点差异审计

- 生成时间：2026-11-04（round 7 验证轮）
- 原版参考（只读）：`C:/Users/1/Desktop/work/tasks/20260917-微服务/tools/markdown-reader/`（HEAD `5bc1ecd`，工作区干净）
- 插件：`C:/Users/1/Desktop/work/code/agent-workspace/20261104-markdown-reader-plugin/plugin/`
- 判定口径：以「用户可见行为」是否与 oracle（原版 `server.py` + `index.html`）一致为准；行号均为当前 HEAD/当前插件源码行号。
- 证据来源：`work/work-def-parity.mjs`（最新 host 下 oracle 成功样本 **46/46 一致**，含 12 个 web 样本）、`work/harnesses/{code,defs,copy-menu,panels,html,load,boot}-check.mjs`、以及直接 grep/HTTP 探测。

## 1. 总览

| # | 原版 commit | 能力 | 状态 | 一句话证据 |
|---|-------------|------|------|-----------|
| 1 | `2fab45a` | 枚举值可高亮、可 Ctrl+点击跳转 | **已移植** | 插件 `hljs-constant` + `kind=constant`；parity 样本 `e01/e02/e07/e08/e11/e12` 全部一致（见 §2.1） |
| 2 | `2fab45a` | 文件路径右键一键复制（复制路径/文件名 + toast） | **已移植（并扩展）** | 原版 4 类路径标签；插件覆盖 7 类（代码弹窗头/代码标签页头/HTML 标签页头/图片名/搜索结果/目录树行/标签页），三级剪贴板回退 |
| 3 | `6b8a095` | 方法签名里的参数类型识别/高亮/跳转 | **已移植** | 插件参数列表后处理 `hljsPostProcJavaKtTokens` + `enhanceJavaKtTypes` |
| 4 | `b9d5714` | 泛型返回类型 / `List<X>` / import 类名高亮跳转 | **已移植** | 插件 `enhanceJavaKtTypes` 泛型头/实参 + `isImportPathText`；code-check `fence palette covers param types` 等 |
| 5 | `b9d5714` | Ctrl+点击延迟 2.4s → 80ms | **已移植（无延迟，等价或更好）** | 插件事件绑定直连，无 2400ms 定时器（code-check 显式断言） |
| 6 | `4653783` | SOA（ody）跳转适配层（可拆卸） | **缺失** | 原版 `soa_defs.py` + `server.py` 适配钩子；插件无对应模块（后续轮次清单第 1 项） |
| 7 | `08b68fc` | 代码弹窗「返回」后高亮行不被重置到视口中心 | **已移植** | 插件 `24-modal.js` 快照含 `scrollTop`，`goBack` 恢复 |
| 8 | `05839fa` | diff 删除行整行不可 Ctrl+点击跳转 | **已移植** | 插件 `definitionHitAt` 删除行守卫 + CSS hover 禁用；code-check/defs-check 双重断言 |
| 9 | `798442f` | diff 视图跳转/返回后不丢 diff 标记 | **已移植** | 插件 tab/modal 均以 `viewKey`/`commit` 重建 diff 视图；code-check 新增「跳转后 add/del 标记仍在」 |
| 10 | `d128568` | 仓库视角 GitLab/GitHub 链接解析成本地文件（相邻轮次） | **已移植** | 插件 `lib/gitlinks.js`；`work/compare-link-resolve.mjs` 对拍 |
| 11 | `6e324db` | 搜索结果打开代码视图 + 命中高亮改标目标文本（相邻） | **部分移植** | 插件搜索保留命中高亮，但点击打开为**标签页**（`25-search.js:146`），原版为代码弹窗 |
| 12 | `717fdf2` | md 代码块高亮与代码视图统一（相邻） | **已移植** | 插件 `10-markdown.js` 用 hljs，共享 `20-code.js` 的 FENCE_CSS 调色板 |
| 13 | `e66629d` | md 链接 `#L行号` 定位（相邻） | **已移植** | 插件 `10-markdown.js:13` 数字 token + `:148` `#L\d+` 兜底 |
| 14 | `5bc1ecd` | README 信息架构重写 | **不适用** | 纯文档提交，本轮由 lead 维护插件 README |

状态统计：已移植 11 项（其中路径复制为扩展实现、点击延迟为等价替代）、部分移植 1 项、缺失 1 项、不适用 1 项。

## 2. 逐条证据

### 2.1 `2fab45a` 枚举常量高亮 + 可跳转 — 已移植

- 原版：
  - `index.html:1895` `.hljs-constant` 配色；`index.html:5168` 全大写 token 标成 `hljs-constant`；`index.html:5438` `cls.includes("hljs-constant") → kind=constant`。
  - `server.py:1042` `_find_enum_const_line()`（javalang 的 `EnumConstantDeclaration` 无 position，走文本行兜底）。
- 插件：
  - `plugin/src-client/20-code.js:137`（全大写 → `hljs-constant`）、`20-code.js:77`（类型增强后处理）。
  - `plugin/src-client/22-defs.js:51` `defKindFromClass()`：`hljs-constant` → Java/Kotlin 为 `constant`。
  - `plugin/lib/javasym.js:683` `parseEnumConstants()` / `:702` 记录枚举常量行；`plugin/lib/defs.js:12` 契约注释。
- 验证：`work/work-def-parity.mjs` 样本 `e01-constant`、`e02-constant2`、`e07-constant-cross`、`e08-constant-chain`、`e11-constant-bind`、`e12-constant-channel` 全部与 oracle 一致（`file+line`）。

### 2.2 `2fab45a` 文件路径右键一键复制 — 已移植（扩展）

- 原版：`index.html:6690-6763`（`ctxMenuOpen/Close` + `#ctx-menu` + 「复制路径/复制文件名」），`index.html:6732` `copyToClipboard()`；只绑定 4 类路径标签。
- 插件：
  - `plugin/src-client/00-core.js:141` `copyText()`（`navigator.clipboard` → `execCommand` → 手动选中的三级回退）、`:153` `copyTextFallback()`、`:172` `toast()`、`:187` `copyWithToast()`。
  - `00-core.js:206` `PATH_MENU_SELECTOR`（7 类目标：`.mdr-code-path/.mdr-cmodal-path/.mdr-html-path/.mdr-image-name/.mdr-search-path/.mdr-tr/.mdr-tab`）、`:236` `pathMenuOpen()`、`:286` `contextmenu` 委托、`:267` `pathOfElement()`（data-path → title 去 `:line` → 文本）。
- 验证：`work/harnesses/copy-menu-check.mjs` **66/66**：右键 `.mdr-code-path`/`.mdr-tr`/`.mdr-tab` 弹出 2 项菜单、文案、`writeText` 收到正确文本、clipboard 不可用走 `execCommand`、toast 出现与 2.6s 自动消失、Escape/外部点击关闭、定位 clamp。

### 2.3 `6b8a095` 方法签名参数类型 — 已移植

- 原版：`index.html:5197-5199`（参数列表补类型注释）、`index.html:1899-1901`（`.hljs-params.hljs-type/.hljs-variable/.hljs-keyword` 配色）、`index.html:5153` `hljsPostProcJavaKtTokens()`。
- 插件：`plugin/src-client/20-code.js:167-218`（`hljs-params` 内参数类型/参数名补全，同一套后处理）、`20-code.js:123` `hljsPostProcJavaKtTokens()`、`:210` `enhanceJavaKtTypes()`。
- 验证：code-check 的调色板断言 `fence palette covers param types` 通过；md 代码块与代码视图共用后处理。

### 2.4 `b9d5714` 泛型 / `List<X>` / import 类名 — 已移植

- 原版：`index.html:5106-5118`（泛型头/泛型实参）、`index.html:5149-5166`（import 路径里的 PascalCase → `hljs-type`）、`index.html:5262`（判断 import 路径）。
- 插件：`plugin/src-client/20-code.js:77` `enhanceJavaKtTypes()`、`:123` `hljsPostProcJavaKtTokens()`、`:134-135`（import 路径类名 → `hljs-type`）、`:152` `isImportPathText()`、`:230` `inImport` 接线。
- 点击延迟：原版从 2400ms 改为 80ms；插件事件绑定直连（无定时器），code-check 断言 `no 2.4s highlight timer in tab code`。
- 验证：code-check `fence palette covers hljs-constant / param types` 等调色板断言 + defs-check `defKindFromClass` 类型/kg 映射。

### 2.5 `4653783` SOA（ody）跳转 — 缺失（后续清单）

- 原版：`server.py:51-65`（`soa_defs` 可拆卸适配层 import/降级）、`server.py:1522-1525`（`_SoaCtx`）、`server.py:2562`/`:2596`（`soa_defs.resolve_type` / `resolve_impl` 钩子）、`tools/markdown-reader/soa_defs.py`（9.7KB，规则全在该文件）。
- 插件：`plugin/lib/` 无 SOA/ody 适配模块，`plugin/lib/defs.js`/`javasym.js` 无对应钩子。
- 影响：SOA 框架（ody）类型/实现跳转在插件里会落到「未找到定义」。
- 建议：后续轮次新增 `plugin/lib/soa-defs.js`，在 `defs.js` 的 `type/method` 解析失败后按「可拆卸适配层」调用（保持与原版一样可删/可空）。

### 2.6 `08b68fc` 弹窗返回后高亮行保持 — 已移植

- 原版：`index.html:5025`（返回时用 `viewportLine` 重定位的注释）、`index.html:5951`/`:5956`（`_backStack` 显隐与 `modalGoBack()`）、`index.html:4664`（`_backStack` 初始化）。
- 插件：`plugin/src-client/24-modal.js:44-47` `readModalScroll()`、`:73` `history` 状态、`:178-183` 快照携带 `scrollTop`、`:200-214` `goBack()`（弹栈 + `setRestoreScroll({top})`）、`:353-357` 返回按钮。
- 验证：code-check `[5]` 返回按钮/`onBack` 接线；`work/harnesses/defs-check.mjs` 断言 modal 走 `setupDefinitionClick`（同一导航栈）。

### 2.7 `05839fa` diff 删除行不可点击 — 已移植

- 原版：`index.html:2505-2509`（`.cl-line.g-del` hover 取消可点击样式）、`index.html:5418-5423`（`ctrlTokenInfo` 里 `.cl-line.g-del` → null）。
- 插件：`plugin/src-client/22-defs.js:178`（`defElementClosest(target, '.mdr-git-del')` → null）、`plugin/src-client/15-git.js:380-382`（`.mdr-cl.mdr-git-del` 红色行）、`:425`（删除行 hover 禁用）。
- 验证：code-check `deleted row is not highlighted`、`ctrl+click skips deleted diff rows`；defs-check `deleted diff row -> null`、`deleted row sends nothing`（0 次 `/api/def`）。

### 2.8 `798442f` diff 视图跳转/返回不丢标记 — 已移植

- 原版：`index.html:3375-3517`（tab 上的 `diffOn/branchContent/commit/diffData` 状态）、`index.html:4966` `renderFileWithDiff()`、`:4883`/`:4918` delta 行 class。
- 插件：`plugin/src-client/20-code.js:552-553`（`mdr-git-add/mdr-git-del` 行 class）、`:569` `useCodeRows()`、`:839` `diffMode`、`:910` `viewKey`（含 diff/base + branch/commit，重建时保留 diff 视图）；`plugin/src-client/22-defs.js:219-235` 请求带当前视图 `text/branch/commit`；`plugin/src-client/24-modal.js:168-214` `navigateInPlace` 保留 `nextView`、返回栈快照含 view。
- 验证：code-check 新增 `diff add/del markers kept after jump`，连同 `diff target highlight lands on added row`/`deleted row is not highlighted` 全绿。

## 3. 后续轮次清单（按优先级）

1. **SOA（ody）跳转适配层**（`4653783`，唯一功能缺失）：新增 `plugin/lib/soa-defs.js` + `defs.js` 钩子；补 parity 样本（真实 ody 调用点）。
2. **搜索结果打开方式对齐**（`6e324db`，部分移植）：插件现在开标签页；如用户要求原版的「代码弹窗」体验，需要 `25-search.js` 增加打开弹窗回调（`openPath` 之外再传 `openCodeModal`）。
3. **泛型跳转的 parity 样本**：高亮已对齐，但 `work/work-def-parity.mjs` 的 Java 样本未覆盖「泛型返回类型的方法调用」；下一轮可补 2-3 个真实样本（如 `Result<UserPO>` 返回值链路）。
4. **点击延迟**：原版 80ms 是为避免误触；插件 0 延迟，如用户反馈「按住 Ctrl 划过就跳」，再评估加最小延迟（不建议先加）。

## 4. 本轮验证命令（可复现）

```bash
cd 20261104-markdown-reader-plugin
node work/work-def-parity.mjs            # oracle vs 插件 /api/def 对齐（--json / --json-file <p>）
node work/harnesses/copy-menu-check.mjs  # 右键复制 + toast + 三级剪贴板
node work/harnesses/defs-check.mjs       # 22-defs 单目标跳转（含删除行不可跳）
node work/harnesses/{load,boot,code,html,panels}-check.mjs
```
