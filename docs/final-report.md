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
