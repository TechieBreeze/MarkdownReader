# Markdown Reader → DSH 插件（原生化重写）

| 项 | 值 |
|---|---|
| 任务 ID | 20261104-markdown-reader-plugin |
| 状态 | done（v0.1 已验收 2026-11-04；第 7 轮增量已交付，待用户目测确认） |
| 负责人 | lead（各客户端分片 / Host 符号解析由 teammate 并行） |
| 开始日期 | 2026-11-04 |
| 写入范围 | 本任务目录；插件运行时代码整包在 `plugin/`（安装为 DSH bundle） |

## 目标

把 `C:\Users\1\Desktop\work\tasks\20260917-微服务\tools\markdown-reader`（原 Python http.server + 单文件 442KB
index.html 阅读器）重写为 **DeepSeek Harness 原生插件**：装进 Harness Web UI 的面板里，Host 用 Node 重写 API，
Client 用 React 重写界面，不依赖原工具目录、不启 Python 服务。

验收标准（按阶段勾）：

- [x] 插件可安装（bundle 安装成功、Host 路由可用、`sidebar.panellist` + `main` 两个 slot 注册 active）
- [x] 目录树 / 标签页 / markdown 渲染 / md→代码行跳转 / 代码行号+高亮
- [x] 多工作区根（添加/移除、虚拟顶层目录）
- [x] 标签页与目录展开状态本地持久化
- [x] Host API：meta/roots/list/markdown/code/exists/raw/git(meta diff file)/search/files/def/vendor
- [x] 代码页 git 分支/提交 diff 视图（teammate）
- [x] 项目内搜索 / 快速打开 / JSON 工具（teammate）
- [x] mermaid 懒渲染（teammate）
- [x] Ctrl+点击定义跳转（第 7 轮起：Host `/api/def` v2 单目标解析，变量/参数/字段/枚举常量/类型/方法/链式/继承/Lombok
  全部对齐原版 javalang 版结果；旧的「候选选择器」已删除）
- [x] 路径右键复制（复制路径 / 复制文件名 + toast + 三级剪贴板回退，覆盖代码弹窗头/代码标签页头/HTML 头/图片名/
  搜索结果/目录树行/标签页）
- [x] 裸文件名链接识别（文档表格里的 `` `UserCookieMapper.java` `` 这类裸文件名经 `/api/exists?from=` 解析成代码链接；
  原实现按「每个根一个固定深度」BFS，第二根下 10 层的 Java 文件全部解析不到，改为文件名索引 + 文档所在项目优先）
- [x] Host 最新版生效（无需重启 DSH：禁用→启用 bundle 会重新加载 Host 模块，已实测）
- [x] 浏览器实测（用户刷新后按 `docs/acceptance-checklist.md` 逐项确认；含代码弹窗、项目/任务分层、git 链接、
  HTML/图片预览、代码高亮/hover/常驻标黄/跳转/返回、同步面板、SVG 适配与目录树恢复，全部通过）

## 输入

- 原工具源码（只读副本）：`input/reference/`（index.html / server.py / web_defs.py / soa_defs.py / README.md / vendor / vendor_py），来源：`tasks/20260917-微服务/tools/markdown-reader`，2026-11-04 拷贝。原目录保持不动、未切分支、未改文件。
- 插件运行时资产：`plugin/vendor/`（marked v15 / highlight.js 11.9 / mermaid / gitgraph，来自原工具 vendor 目录）。

## 交付物

- `plugin/`：自包含 DSH bundle（`@local/markdown-reader`）
  - `index.js` + `lib/`：Host 半边（同源 `/markdown-reader` 前缀路由 + 只读 git / 搜索 / 符号查找）
  - `src-client/*.js` → `build.mjs` → `client.js`：Client 半边（React，无打包器依赖）
  - `locale/{en,zh}.json` + `icon.svg`：插件展示元数据
- `plugin/README.md`：架构、安装、开发流程、已知限制
- `work/host-test.mjs`：独立 Host API 测试服务（不重启 DSH 也能验证 Host 改动）
- `docs/acceptance-checklist.md`：浏览器目测清单
- `docs/final-report.md`：交付报告（验证证据 / 功能对照 / 风险）
- `docs/round-7-feature-parity-plan.md`：第 7 轮契约与分工（`/api/def` v2 接口定义在此）
- `docs/round-7-report.md`：第 7 轮验证报告（parity 100%、7 个 harness 全绿）
- `docs/feature-gap-audit.md`：原版最近提交 × 插件功能点差异审计（后续轮次清单）
- `docs/demo-diff-fence.md`：**markdown 里的 diff 代码块演示文档**（真实提交补丁，插件里可直接打开看渲染效果）

## 过程记录

- 关键决策：
  - **不做 iframe 包装**：用户选择原生 React 重写；Host API 走 `ctx.webServer.register` 同源前缀路由，
    Client 用 `fetch('/markdown-reader/...')`，避免跨进程/跨源。
  - **不使用 Node 打包器**：`src-client/*.js` 为共享作用域的分片，`node build.mjs` 拼成 client.js；
    只 `require('react')`（Harness 内置模块表）。
  - **Host 代码可免重启生效**：不用重启 DSH——在插件管理器里把本 bundle 禁用再启用（toggle）会重新
    import Host 模块，新增的 `/api/search`、`/api/def`、mermaid 白名单均已实测立即生效；Host 逻辑仍用
    `work/host-test.mjs` 单独验（端口 8799），避免依赖 UI 操作。
  - **Java 符号解析第 7 轮推倒重做（不再用候选列表）**：先用自写 Java 词法器 + 声明/作用域树
    （`plugin/lib/javasym.js`）替换原来的正则扫描，再在 `plugin/lib/defs.js` 里逐条对齐原版
    `_resolve_java_def`：局部变量/参数/字段/枚举常量/类型/方法/接收者链 ≤3 层/继承/Lombok getter-setter/
    链尾 `a.b().c()`/Mapper 接口→XML 语句行/接口→impl/`commit`·`branch` 视图，并移植了原版 `/api/web/def`
    的 JS/TS/Vue 分支。原版用 Python javalang AST，插件只用 Node 内置模块，靠 oracle（原版服务）对拍把
    行为做到一致（1014 次真实点击、原版成功样本 392/392 file+line 全一致）。
  - **mermaid 不内联 SVG**：沿用原工具结论（内联 SVG 的全局 `<style>` 会拖垮页面），渲染成
    `<img src="data:image/svg+xml;base64,...">`，且只在可见时渲染、串行排队、带缓存。
- 风险：
  - 无浏览器控制：渲染结果只能由用户刷新后目测，agent 侧已验证 JSON/语法/注册状态/接口形状/与原版对拍。
  - Kotlin 只做行级近似（原版完全不支持 `.kt` 跳转）；SOA（ody）适配层仍未移植。
  - 原工具的「git graph 交互细节 / SOA 适配层 / 性能日志 / 行折叠·书签·大纲」尚未移植（见
    `docs/feature-gap-audit.md`）。
- 未决问题：
  - 是否把「工作台任务 chip / git graph / 同步检查更新 / SOA 适配」也移植（原工具的后半部分功能）。
  - 插件包是否需要发布/共享（当前是本机 `@local` bundle）。

## 下一步

- [x] 用户按验收清单目测，反馈的 3 批问题全部回归通过
- [x] 第 7 轮增量（用户第 4 批）：路径右键复制、裸文件名链接识别、变量/枚举/类型/方法 Ctrl+点击跳转对齐原版 → 已交付，待用户目测
- [ ] 需要时移植原工具剩余功能：SOA（ody）适配层（唯一功能缺失）、性能日志、行折叠/书签/大纲、搜索结果打开为代码弹窗
- [ ] 插件分支已推送到 `git@github.com:TechieBreeze/MarkdownReader.git` 的 `dsh-plugin` 分支，作为插件版目标分支（原仓库 master 未改动）

| 回归工具 | 位置 |
|---|---|
| fake React/DOM 断言（代码高亮/弹窗/工作台/面板/图片/右键复制/定义跳转） | `work/harnesses/*.mjs` |
| Host API 独立测试服务（不重启 DSH 验证 lib/* 改动） | `work/host-test.mjs`（:8799） |
| 与原版 `/api/java/def`、`/api/web/def` 逐点击对拍（46/46 一致） | `work/work-def-parity.mjs` |
| 原版全量扫描对拍（32 文件 / 1014 次点击） | `work/defs-oracle-sweep.mjs` |
| 跳转特性断言（Mapper→XML、接口→impl、分支/提交视图、v1 兼容） | `work/defs-feature-checks.mjs` |
| 线上 Host 验收（文档裸路径 9/9 + 13 个点击与原版一致） | `work/live-acceptance.mjs` |
| 原版 oracle 重建（`input/reference` → `work/oracle`，gitignored） | `work/oracle-setup.mjs` |
| 与原版 /api/git/resolve 逐条对照 | `work/compare-link-resolve.mjs` |
| 目录树同级行左侧对齐（headless Chrome 实测 x 偏移） | `work/tree-layout-probe.mjs` |
| HTML 预览是否真的画出图表（headless Chrome + CDP，canvas/控制台） | `work/html-preview-probe.mjs` |
| HTML 预览重写契约（脚本正文必须逐字节不变） | `work/harnesses/html-preview-check.mjs` |
| 提交 diff 视图（hunk 解析 + 行序列，行号/内容必须对得上） | `work/harnesses/git-diff-check.mjs` |
| markdown ```diff 代码块（行模型/分段/转义/无幻影行/无行号列） | `work/harnesses/diff-fence-check.mjs` |
| markdown ```diff 真实渲染（headless Chrome：无行号列 + 有语法高亮） | `work/harnesses/diff-fence-render-check.mjs` |
