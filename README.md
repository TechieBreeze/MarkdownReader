# Markdown Reader → DSH 插件（原生化重写）

| 项 | 值 |
|---|---|
| 任务 ID | 20261104-markdown-reader-plugin |
| 状态 | done（已验收，2026-11-04） |
| 负责人 | lead（git 视图 / 搜索+JSON / mermaid 三个客户端分片由 teammate 并行） |
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
- [x] Ctrl+点击定义跳转（Host `/api/def` + CodeView 候选选择器）
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

## 过程记录

- 关键决策：
  - **不做 iframe 包装**：用户选择原生 React 重写；Host API 走 `ctx.webServer.register` 同源前缀路由，
    Client 用 `fetch('/markdown-reader/...')`，避免跨进程/跨源。
  - **不使用 Node 打包器**：`src-client/*.js` 为共享作用域的分片，`node build.mjs` 拼成 client.js；
    只 `require('react')`（Harness 内置模块表）。
  - **Host 代码可免重启生效**：不用重启 DSH——在插件管理器里把本 bundle 禁用再启用（toggle）会重新
    import Host 模块，新增的 `/api/search`、`/api/def`、mermaid 白名单均已实测立即生效；Host 逻辑仍用
    `work/host-test.mjs` 单独验（端口 8799），避免依赖 UI 操作。
  - **Java 定义查找不用 AST**：原工具靠 Python javalang AST；插件改为有界源码扫描 + 声明形态
    启发式（class/interface/enum/record/method/field）+ JS/TS import 解析，返回候选列表。
  - **mermaid 不内联 SVG**：沿用原工具结论（内联 SVG 的全局 `<style>` 会拖垮页面），渲染成
    `<img src="data:image/svg+xml;base64,...">`，且只在可见时渲染、串行排队、带缓存。
- 风险：
  - 无浏览器控制：渲染结果只能由用户刷新后目测，agent 侧已验证 JSON/语法/注册状态/接口形状。
  - Java defs 为启发式，重载/同名方法可能多候选；后续可按候选列表 UI 收敛。
  - 原工具的「工作台 chip / git graph / 同步检查更新 / SOA 适配层」尚未移植。
- 未决问题：
  - 是否把「工作台任务 chip / git graph / 同步检查更新 / SOA 适配」也移植（原工具的后半部分功能）。
  - 插件包是否需要发布/共享（当前是本机 `@local` bundle）。

## 下一步

- [x] 用户按验收清单目测，反馈的 3 批问题全部回归通过
- [ ] 需要时移植原工具剩余功能：工作台任务 chip 已做；剩余 git graph 交互细节、同步之外的「检查更新」远端策略、SOA（ody）适配层、性能日志
- [ ] 插件分支已推送到 `git@github.com:TechieBreeze/MarkdownReader.git` 的 `dsh-plugin` 分支，作为插件版目标分支（原仓库 master 未改动）

| 回归工具 | 位置 |
|---|---|
| fake React/DOM 断言（代码高亮/弹窗/工作台/面板/图片） | `work/harnesses/*.mjs` |
| Host API 独立测试服务（不重启 DSH 验证 lib/* 改动） | `work/host-test.mjs`（:8799） |
| 与原版 /api/git/resolve 逐条对照 | `work/compare-link-resolve.mjs` |
