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
