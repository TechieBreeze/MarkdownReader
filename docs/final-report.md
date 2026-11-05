# 交付报告：Markdown Reader → DSH 插件

日期：2026-11-04 · 负责人：lead · 状态：已交付待人工目测（browser check pending）

## 1. 结论

`tasks/20260917-微服务/tools/markdown-reader` 已按「原生 React 重写 + 自包含插件包」交付为
DeepSeek Harness 插件，**已安装并运行在当前 profile `desktop`**：

- bundle：`@local/markdown-reader` v0.1.0（本地 linked dir，`~/.dsh/profiles/desktop/node_modules/` 下）
- 入口：左侧面板图标区「文档」图标 → 中央主面板 `markdown-reader`
- 源码：本任务目录 [`../plugin/`](../plugin/)；插件说明见 [`../plugin/README.md`](../plugin/README.md)
- 原工具目录未被修改：仓库仍在 `master`、工作区 clean（仅创建过一个空分支后已删除）

## 2. Agent 侧已验证（可复现证据）

| 验证 | 方式 | 结果 |
|---|---|---|
| 插件安装 | `plugin_manager install_bundle` | `application: applied`，bundle 出现在 profile，`enabled: true` |
| 两个 slot 注册 | `cordis_inspect_query Slots.listSubTree` | `sidebar.panellist` 有 `markdown-reader`（order 20）；`main` 有 key `markdown-reader`；均 `active: true` |
| Host 路由 | 真实 HTTP 请求 → `127.0.0.1:57377/markdown-reader/api/*` | `ping/meta/list/markdown/code/exists/git meta/diff/file/search/files/def` 全部 200 且形状正确 |
| 符号定义 | `POST /api/def` 实测 | Java：`IDataStorage`→接口行、`write`→接口+3 个实现（带 kind/line/snippet）；TS：`RequireAuth` 经相对 import 解析到 `auth/RequireAuth.tsx:5` |
| mermaid 资产 | `GET /vendor/mermaid.min.js` | 200，3,337,857 bytes |
| 多根解析 | `/api/list?path=` 空值 + `/api/exists` | 返回虚拟顶层 `20260917-微服务`/`code`；裸相对路径经 basename 搜索兜底命中 |
| 构建 | `node build.mjs` + `node --check client.js` | 11 个分片 → `client.js` 108,368 bytes，语法通过 |
| Host 免重启重载 | `set_bundle` false→true 后立即请求新端点 | `/api/search`、`/api/def`、mermaid 白名单立即生效 |

> 无浏览器控制：以上不含浏览器渲染结果；渲染/交互需按
> [`./acceptance-checklist.md`](./acceptance-checklist.md) 目测。

## 3. 功能覆盖（相对原独立版）

已实现：目录树、标签页（+ 持久化）、多工作区根、markdown 渲染、代码块高亮、图片、
文档代码链接 → 源码行跳转（含行内高亮）、裸反引号路径自动链接、代码视图（行号/高亮/跳行/大文件虚拟滚动）、
git 分支/提交（完整提交版本 + 增删行标记 + 作者/时间/+N−M）、项目内搜索、快速打开、JSON 工具、
mermaid 懒渲染、Ctrl+点击定义跳转（Java 声明启发式 + JS/TS import 解析）、工作区根增删。

未移植（后续可选）：工作台任务 chip、git graph、同步检查更新、SOA（ody）适配层、性能日志。

## 4. 架构与关键决定

- Host：`ctx.webServer.register({kind:'prefix', path:'/markdown-reader'})` 同源路由；`lib/api.js`（文件/git/搜索/
  定义/静态资产）、`lib/state.js`（多根 + 路径解析）、`lib/defs.js`（符号候选）。
- Client：`sidebar.panellist` + `main` 两个 slot；`src-client/*.js` 分片由 `build.mjs` 拼成 `client.js`，
  只依赖内置 `react`；主题走 `--dsw-alias-*` token，代码区固定 VSCode Dark+。
- 不使用 iframe（原生 React）；mermaid 不用内联 SVG（`<img>` + data URL，防全局 CSS 泄漏）。
- Java 定义查找不用 javalang AST（去掉 Python 依赖），改为有界源码扫描 + 声明形态启发式。

## 5. 风险与后续

1. **浏览器目测未完成**：清单见 `acceptance-checklist.md`；若有问题按条目回归。
2. linked dir 安装：本任务目录不能删/移，否则插件失效；移动后需重新 `install_bundle`。
3. Java 定义启发式：重载/同名方法返回多候选（已有候选选择器）；如需精确到 AST，可后续接 tree-sitter-java。
4. 搜索/快速打开有界（时间预算 + 文件上限），超大仓库可能 `truncated`。

## 附录：第 2-3 轮迭代（2026-11-04 晚）

用户第 1 轮验收反馈的 6 项全部处理并复验：

| 反馈 | 修复 | 复验 |
|---|---|---|
| 代码点击应开弹窗 | CodeModal（`24-modal.js`）：/api/code 加载、CodeBody 渲染、行号高亮、分支/提交、Ctrl+点击就地跳转 + ← 返回栈 + 开成标签页 | ✅ 用户确认 |
| 顶栏多出「打开」 | 移除「打开/搜索」按钮（保留 Ctrl+P / Ctrl+Shift+F），改为 工作区/同步/Git 图/JSON/刷新 | ✅ 用户确认 |
| 没有 Git 视图按钮 | GitGraphModal（`28-gitgraph.js`）：`/api/git/repos` + `/api/git/graph`，手绘 SVG 车道、分支 chips、提交详情、复制 hash | ✅ 用户确认 |
| 没有同步更新按钮 | SyncPanel（`27-sync.js`）+ Host `/api/sync/{status,pull}`；已把插件分支推到 `dsh-plugin` 并写入 config | ✅ 用户确认已连接（文案占位已修） |
| 目录树切面板后一直加载中 | App 在 remount 后按 expanded 路径重拉目录，inflight 去重，加载失败/空目录状态 | ✅ 用户确认 |
| 滚动位置丢失（md 标签/切面板） | 根因：卸载 cleanup 时 DOM 已切换/摘除，`scrollTop` 归零覆盖了正确值。改为「滚动时持续保存 + 切换前主动保存 + beforeunload flush」，无存档回顶部 | ✅ 用户确认三种路径都保住 |

同步远程：`git@github.com:TechieBreeze/MarkdownReader.git` 分支 `dsh-plugin`（本任务镜像分支，原仓库 master 未改动）。
拉取后生效方式：Client 刷新页面；Host 代码在插件管理器里 bundle 禁用→启用。

## 附录：第 4 轮迭代（对齐原版设计）

用户第 2 轮反馈的 8 项：

| 反馈 | 修复 |
|---|---|
| 原版分层：项目 → 任务 | App 重写为两层：项目（=工作区根，顶栏/Alt+P 切换·添加·移除，树/任务/展开记忆按项目隔离）；任务（工作台 chip：新建/切换/双击重命名/×/拖拽排序，每个任务独立标签集+滚动，持久化 `tasks.<project>.v1`）。搜索/快速打开/Git 图都按当前项目过滤 |
| git 代码链接适配 | Host `/api/git/resolve`：把 GitLab/GitHub `/-/blob/<ref>/<path>#Lnn` 仓库链接按后缀匹配到本地文件，返回 path/line/ref/refExists；md 渲染时批量解析，命中后点击走本地代码（带 branch 版本），Shift+点击/右键仍打开仓库原链接 |
| HTML 默认不应打开源码 | 新增 html 标签页：默认 iframe 渲染（`/api/html` 服务端把相对 src/href/srcset/url() 重写为 `/api/raw`，注入 charset、去 `<base>`），头部「源码视图/渲染视图」切换并持久化；图片也有独立 image 标签页（适配/100% 缩放） |
| Ctrl+点击有时没跳到目标行 | 跳转改为「显式跳转优先于滚动记忆恢复」：新开/复开标签、内容迟到、diff 视图都保证定位；同一行重复跳转也生效 |
| 跳转行应持续标黄 | `.mdr-cl.hit` 由 targetLine 派生，不再有 2.4s 定时清除；弹窗同样常驻 |
| Ctrl+点击 token 缺 hover | `.mdr-code-body.jump-hover`（Java/Kotlin 门控）+ 原版下划线/亮度/指针效果，删除行不参与 |
| 代码高亮有问题 | 移植原版整文件一次 hljs + 按行拆分（跨行注释/字符串正确开闭）+ Java/Kotlin 后处理（import 类型、方法名→function_、变量→variable、参数、常量）；真实 Service 文件未着色行 153/118/11 → 0，标识符着色覆盖 36/46/43% → 96/99/98% |
| 跳转后的返回按钮 | 顶栏 ← / →（nav history，Alt+←/→，跳转时入栈，返回恢复标签+行+滚动）；代码标签页在被跳转打开时（tab.navFrom）头部显示「← 返回」，调用同一个 goNav(-1) |

Host 新增/放宽：`/api/html`、`/api/git/resolve`、`project=` 作用域（search/files/git repos）、`/api/raw` 支持 css/js/字体等静态资源（HTML 预览的外部资源）。全部已实测（57377 热重载后）。

## 附录：第 5 轮迭代（用户第 3 批反馈）

| 反馈 | 修复 |
|---|---|
| 链接适配要和原版一致 | 已对照原版 `/api/git/resolve` 做真机对比：5225 个（文档×仓库链接）中抽样 121 个逐个比较，120 个命中完全一致、0 个只原版命中、0 个只我们命中（唯一未命中原版同样未命中）；另外补齐「嵌套仓库/多模块目录」候选查找兜底（按目录名 = 远端项目名全根查找），仓库链接初始样式/标题/Shift+点击·右键原生行为对齐原版 |
| 图片预览点击会清空、不能缩放/拖拽 | ImageView 重写：始终单 `<img>`、src 只由 path 派生（点击/滚轮/拖拽绝不清空）；点击切换适配↔100%；滚轮/Ctrl+滚轮 1.2× 步进（25%–400%，以光标为锚点）；双击还原；放大后可拖拽平移；ResizeObserver 适配面板；SVG width=100% 兜底；缩放/滚动状态按 tab 持久化 |
| markdown 代码块高亮要和原版一致 | 原版 fenced code 用与代码视图同一管线（`renderHighlightedCode` + `hljsLang` 归一化 + Java/Kotlin 类型/方法/变量补色 + 分片执行）。插件新增 `renderFenceCodeHtml`/`hljsLangNormalized`（20-code.js），10-markdown 的代码块改为调用它并按 60ms 预算分片；验证与代码标签页输出**逐字节一致**（java/vue/json/js/kt/properties/xml/bat，含 1382 行真实 Java 文件） |

## 附录：第 6 轮（收尾 bug）

| 反馈 | 修复 |
|---|---|
| 打开 SVG 后切会话再回插件弹「目录不存在: X/X/docs/…」 | 双项目前缀 bug：`locateInTree` 对已带 vtop 前缀的路径又拼了一次当前项目，并把 `X/X/…` 持久化到展开集合，重挂载时去 list 报错。修复：已带真实项目名时原样使用；新增 `collapseDoubledVtopPrefix` 自愈（多根且首段是真实项目、循环处理三重），持久化集合重挂载/切换项目时清洗并回写；`loadDir` 防御性清洗。Host `/api/list` 也容忍「重复前缀但重复形式不存在」的旧状态。 |
| SVG 显示很小、放到最大也勉强窗口 | SVG 无固有像素宽（`width="100%"` + viewBox）。ImageView 改为 fetch `/api/raw` 读 SVG 文本，解析 `viewBox`（优先）/数字 width/height 作为 intrinsic；flow-order.svg 解析为 1265.67×1587.52，默认 fit 撑满面板（约 478×600），100% = 1266×1588 可滚动，缩放上限 8× fit；解析失败回退实测盒，png/jpg 仍走 naturalWidth；不改/清 src。 |

## 附录：第 7 轮（继续迁移原版功能点，2026-11-04 晚）

用户第 4 批反馈（原话要点）：**「右键菜单能复制路径」**、**「代码链接的识别」**——举
`20260917-微服务/docs/codereview/20261104_ck-dev-1105_th-dev-1105_vs_基线_1105版本_codereview.md`
§三「差异总览」表格前两行第一列的 `.java` 文件名，原版能识别成代码；**「代码弹窗中变量不存在候选什么的，原版直接能定位到位置」**。
并提示「可以看原版最近的 commit 来看功能点」。

| 反馈 | 根因 | 修复 |
|---|---|---|
| 表格里的裸文件名（`.java`）识别不到代码 | Host `/api/exists` 的 basename 兜底用「第一个根 12 层、其余根 8 层」的写死深度 BFS；`20260917-微服务` 是第二个根，而 `gits/<svc>/src/main/java/...` 深 10 层 → `.xml`（7 层）能解析、`.java` 全部解析不到 | `plugin/lib/api.js`：改成**文件名索引**（懒建、90s TTL、深度 18、跨根、40 万文件上限），新增 `from=<当前文档>` 让索引优先命中**文档所在项目**；客户端 `10-markdown.js` 带上 `from` |
| 右键没有复制路径 | 未移植原版 `2fab45a` 的路径右键菜单 | `00-core.js`：`copyText()`（clipboard → execCommand → 手动 Ctrl+C 三级回退）、`toast()`、`pathMenuOpen()` + 全局 `contextmenu` 委托；覆盖代码弹窗头/代码标签页头/HTML 头/图片名/搜索结果/目录树行/标签页（原版 4 类，这里扩到 7 类） |
| 代码弹窗里点变量没有结果（只给「候选」且为空） | `/api/def` 只有「正则扫声明 + 返回候选列表」，没有局部变量/参数/枚举常量/接收者类型/继承/Lombok 能力（原版是 Python javalang AST 单目标解析） | **推倒重做**：新增 `plugin/lib/javasym.js`（Java 词法器 + 声明/作用域树，含 catch/for-each/lambda/try-with-resources/record/var），重写 `plugin/lib/defs.js` 逐条对齐原版 `_resolve_java_def`（variable/constant/type/method、接收者链 ≤3、接口→impl、Mapper→XML 语句行、链尾 `a.b().c()`、`commit`/`branch` 视图）+ 移植原版 `/api/web/def` 的 JS/TS/Vue 分支；接口改单目标 `{file,line,kind,defName,impl}`，客户端 `22-defs.js` 按 hljs class 判 kind + 行内列号，删除候选选择器 |
| 枚举值/常量、方法签名参数类型、泛型/`List<X>`/import 类名的高亮与可跳 | 原版 `2fab45a`/`6b8a095`/`b9d5714` 的等价实现前几轮已移植，本轮补断言确认 | 用探针复核（`hl-real` 32/32 真实文件、`hl-probe` 25/25 合成）确认 `hljs-constant`、`hljs-params` 内类型、泛型头/实参、import 类名均已高亮且无重复包裹，未改高亮代码 |

**验证（第 7 轮，agent 侧可复现）**

- 与原版 `/api/java/def`、`/api/web/def` **逐点击对拍**：`work/work-def-parity.mjs` 53 个真实样本（Java 41 + web 12），
  原版成功 46 个 → **46/46 file+line 一致，0 仅原版、0 不一致，RESULT: PASS**（7 个双方失败样本是原版也失败的负样本，文案逐字一致）。
- 广扫对拍：`work/defs-oracle-sweep.mjs` 32 个文件 / **1014 次真实 token 点击**（覆盖 user/order/product/customer/core
  多模块 + `.js`/`.vue`）→ 原版成功 392 次，**file+line 一致 392/392**，0「原版能跳、插件失败」；插件延迟 p50 6–9ms（原版 27–47ms）。
- **线上 Host 验收**（bundle 禁用→启用热重载后，`work/live-acceptance.mjs`）：
  该 codereview 文档里 9 个可解析裸路径 **9/9** 命中（含 §三 表格前两行的 `UserCookieMapper.java` / `UserCookieServiceImpl.java`）；
  `UserCookieServiceImpl.java` 上 13 个点击（参数 `token`、`queryWrapper`、`cookiePO`、`dict`、`dto`、类型 `UserCookiePO`、
  import 的 `UserCookieMapper`/`UserCookieService`）与原版 **12/12 成功目标一致**，另 1 个双方同样未找到定义。
- 回归 harness 全绿：load 8/8、boot、code 177/177、html 159/159、panels 100/100、**copy-menu 66/66（新增）**、
  **defs 63/63（新增）**；`node build.mjs` → `client.js` 322.2KB / 16 parts，`node --check` 通过。
- 原版最近提交的功能点差异审计（含逐条文件行号证据）：[`feature-gap-audit.md`](./feature-gap-audit.md)
  （14 项：已移植 11、部分 1、缺失 1=SOA 适配层、不适用 1）；本轮验证细节：[`round-7-report.md`](./round-7-report.md)；
  接口契约与分工：[`round-7-feature-parity-plan.md`](./round-7-feature-parity-plan.md)。

**待用户目测（无浏览器控制，未做渲染断言）**：表格裸文件名是否渲染成可点链接、Ctrl+点击变量是否直接跳到声明行且常驻高亮、
接口类型是否出现「实现: XxxImpl」入口条、跨文件跳转后 ←返回/Alt+← 是否回到点击位置、右键菜单与 toast 的视觉。

## 附录：第 8 轮（目录树同级行左侧对不齐）

**反馈**：目录里同级的文件左侧对不齐，举例 `20260917-微服务/docs/杂项/查询员工不可内购商品-YApi-高效、易用、功能强大的可视化接口管理平台.html`
与同目录的另一个文件。

**根因（实测，不是推测）**：目录树行是 flex 行（`.mdr-tr`），前导列是缩进箭头（`.mdr-caret`，宽 12px）+ 文件图标。
`.mdr-caret` 写了 `width:12px` 但**没有 `flex-shrink:0`**，于是当某行文件名很长、行内容超过 262px 树宽时，
flexbox 会按「各子项基准宽度比例」压缩它 —— 压缩量取决于**该行自己的文件名长度**，因此不同同级行的
图标/文字起始 x 各不相同。

用 headless Chrome 量得（`work/tree-layout-probe.mjs`，262px 树宽，同级 4 行）：

| 行 | 箭头宽 | 图标 left | 文字 left |
|----|--------|-----------|-----------|
| `需求梳理.md` | 12.00 | 50.00 | 68.00 |
| `查询员工不可内购商品-YApi-…html` | **4.13** | **42.13** | **60.13** |
| `20261104-1105版本需求梳理.md` | **9.53** | **47.53** | **65.53** |

即长文件名那一行整体左移 7.88px，中等长度那行左移 2.47px —— 与用户看到的现象一致。

**修复**（`plugin/src-client/00-core.js` 的 `APP_CSS`）：

- `.mdr-caret` → `flex:0 0 12px`（前导列永不压缩，所有同级行严格对齐）；
- `.mdr-tname` → `flex:none; overflow:visible; text-overflow:clip`（文件名不再被省略号截断）；
- `.mdr-tr` → `width:max-content; min-width:100%`（行宽跟内容，树列横向滚动，与原版一致）；
- `.mdr-tree-toolbar` 补 `left:0`（横向滚动时工具条保持钉在左边，不跟着跑）。

**修复后实测**（同一脚本）：四行的图标/文字 left 全部 = 50.00 / 68.00，**偏移差 0.00px**；
长文件名完整显示（562.92px，不再截断）；树可横向滚动（`canScrollX=true`，`scrollLeft` 可设）；
工具条横向滚动后仍钉在左侧（left=-0.08px ≈ 0）；无文件名被裁剪（`namesClipped=false`）。

**回归**：`load` / `boot` / `code 177/177` / `html 159/159` / `panels 100/100` / `copy-menu 66/66` / `defs 63/63` 全绿；
`node build.mjs` → `client.js` 322.4 KB / 16 parts，`node --check` 通过。

## 附录：第 9 轮（HTML 预览：自包含页面的图表不渲染）

**反馈**：`20260917-微服务/docs/公众号身份重复门店8888-stage数据全景.html` 里有些图表渲染不出来。

**实测（headless Chrome + CDP，`work/html-preview-probe.mjs`）**：

| 加载方式 | canvas | 尺寸正常的 canvas | `window.echarts` | 控制台 |
|---|---|---|---|---|
| `file://` 直接打开（原文件） | 3 | **3** | 有 | 无报错 |
| 插件预览 `/api/html?path=…`（修复前） | **0** | **0** | **无** | `echarts missing` + `SyntaxError: Invalid regular expression flags` |

**根因**：HTML 预览的资源重写是**按原始文本**做的，于是 CSS 风格的 `url(...)` 规则和 `src=`/`href=` 规则
也命中了 JavaScript。该页面把 ECharts 整库内联在 `<script>` 里，压缩后的 `getDataURL(t)` 被改写成
`getDataurl(/markdown-reader/api/raw?path=…/docs/t)`，同一规则还把一个正则字面量改坏 →
库在**解析期**就报错 → 所有图表全空。

对照原版：原版**根本不做重写**，只注入 `<base>`（其 docstring 写明「自包含 HTML（内联 echarts 等）无需重写也能正常渲染」）。
我们为了「相对资源可加载」做得更宽，代价是误伤了脚本。

**修复**（`plugin/lib/htmlpreview.js`）：重写前先把内联 `<script>` **正文**遮蔽，重写后再还原；
`<script>` 开标签仍然重写（`<script src="app.js">` 照常可用），脚本外的 `img` / `href` / `srcset` / CSS `url()`
仍然重写到 raw 代理。

**修复后实测**：该文档的预览与磁盘文件**逐字节一致**（头部、2 段脚本正文、尾部均相同），
渲染出 **3 个尺寸正常的 canvas**（与 `file://` 基线一致），控制台无报错。

**回归**：新增 `work/harnesses/html-preview-check.mjs`（合成文档 + 该真实文档各验一遍「脚本正文逐字节不变、
img/href/css url() 仍被重写」）；load/boot、code 177/177、html 159/159、panels 100/100、copy-menu 66/66、
defs 63/63 全绿。

## 附录：第 10 轮（去掉压在 Harness 窗口底层的「已复制路径」提示）

**反馈**：「已复制路径」提示显示在 Harness 窗口最底层，去掉。

**根因**：第 7 轮加的提示条 `toast()` 挂在 `document.body` 上、`position:fixed; bottom:38px`，
所以它落在 **Harness 窗口底部**（压在宿主 UI 上，而不是阅读器面板里）；复制动作还额外弹一条
「已复制路径」，对用户就是一层没必要的浮层。

**修复**（`plugin/src-client/00-core.js`）：

- **复制不再有任何浮层**：确认信息留在用户刚打开的**菜单项本身**
  （`复制路径 ✓`，0.9 秒后菜单自动收起；失败则显示「复制失败，请手动复制」，1.8 秒后收起）；
  新增 `copyWithFeedback()` 返回 `ok` / `err` / `empty`，删除 `copyWithToast()`。
- **其余提示（跳转失败等）改为锚在插件面板内**：`toast()` 现在挂到 `.mdr-root`
  （面板根是 `position:relative`）并用 `position:absolute`，不再落到 Harness 窗口底部；
  没有面板时回退到 `document.body` + `mdr-toast-fixed`。
- 菜单增加 `.mdr-ctx-ok` / `.mdr-ctx-err` 两种状态色。

**回归**：`work/harnesses/copy-menu-check.mjs` 随契约更新（70/70）——断言复制**不产生任何 toast**、
确认文字出现在菜单项里、toast 挂在 `.mdr-root` 内且仍会 2.6 秒自动消失；
其余 harness 全绿：load/boot、code 177/177、html 159/159、panels 100/100、defs 63/63、html-preview 全通过。

## 附录：第 11 轮（提交 diff 视图：hunk 之后的第一行内容变空）

**反馈**：`20260917-微服务/gits/report/src/main/resources/mapper/SyncEzrMapper.xml`，
看 `ck-dev-1105` 分支最新提交（`538a44a`）的 diff 时，**634 行的内容没了**。

**根因（实测）**：`git show --patch` 的输出以换行结尾，`split('\n')` 会多出一个空串；
而 `parseDiff()` 把「空行」当成上下文行，于是 **hunk 末尾凭空多出一行**（`new_no=634`、文本为空）。
这一行还会**吃掉提交版本文件里的真实第 634 行**（客户端按 ctx/+ 行推进文件游标），
所以 diff 视图里 634 行显示为空白，而真实内容是 `            #{item}`。

用真实数据复现（hunk 头声明 `@@ -622,10 +622,12 @@`，即新文件 622–633 行）：

```
解析出的 hunk 行数 = 16（真实应为 15）   ← 多出来的就是那个空的 634 行
rows[634] = ctx ""                      ← 应为 plain "            #{item}"
```

**影响范围**：不止这一个文件 —— 凡是「hunk 后面紧跟的那一行」都会显示为空（尾部还会整体错位一行）。

**修复**（`plugin/lib/api.js::parseDiff`）：**以 hunk 头声明的行数为权威**——
`old_count` / `new_count` 用完即止，剩余行不再当作上下文行；
空内容行仍算上下文行（有些工具会剥掉尾随空格），但只在 hunk 还在等行时才成立。

**修复后实测**：该提交的行序列里 `634` 行 = `            #{item}`（与提交版本文件一致），
hunk 行数 = 15（与头声明一致），文件 663 行 + 3 个删除行 = 666 行，整段无错位。

**回归**：新增 `work/harnesses/git-diff-check.mjs` —— 解析器单元用例（尾部换行不产生幻影行、hunk 计数与头一致、
空内容行仍算上下文）+ 真实提交校验（每个文件行恰好出现一次且内容正确、hunk 后第一行不为空、报告中的 634 行内容正确）；
load/boot、code 177/177、html 159/159、panels 100/100、copy-menu 70/70、defs 63/63、html-preview 全绿。

## 验收结论（2026-11-04）

用户共提出 3 批反馈（17 项），全部回归通过，用户确认「没有其它问题了」：

- 第 1 批：弹窗/按钮/目录树加载/滚动保存等 → 修复并确认；
- 第 2 批：项目→任务分层、git 仓库链接适配、HTML/图片标签页、代码高亮/hover/常驻标黄/跳转可靠/返回按钮 → 修复并确认；
- 第 3 批：md 代码块高亮与代码视图同源、图片缩放拖拽、SVG 固有尺寸、双项目前缀导致的目录报错 → 修复并确认。

最终状态：
- 插件 bundle `@local/markdown-reader` 安装于本机 profile `desktop`（linked dir），Client 刷新页面即生效；Host 代码经「禁用→启用 bundle」热重载。
- 插件分支已推送 `git@github.com:TechieBreeze/MarkdownReader.git` 的 `dsh-plugin`，本地与远端一致；原工具仓库 `master` 未改动。
- 回归工具：`work/harnesses/*.mjs`（fake React/DOM 断言）、`work/host-test.mjs`（Host API 独立服务）、`work/compare-link-resolve.mjs`（与原版 /api/git/resolve 对照）。

未移植（后续可选）：SOA（ody）适配层（唯一功能缺失，见 `feature-gap-audit.md`）、性能日志上报、原版部分快捷操作
（行折叠/书签/大纲等）、搜索结果打开为代码弹窗（当前为标签页）。
