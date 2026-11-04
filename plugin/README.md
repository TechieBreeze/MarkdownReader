# Markdown Reader · DeepSeek Harness 插件

在 Harness Web UI 里读工作区文档、从文档点进源码行、按 git 分支/提交看文件改动。
这是一个 **DSH bundle**（Host + Client 同包），不是独立进程，也不需要 Python。

- 插件包名：`@local/markdown-reader`（本机 profile `desktop`）
- 入口：左侧面板图标区的「文档」图标 → 中央主面板 `markdown-reader`
- 元数据：`locale/en.json`、`locale/zh.json`、`icon.svg`

## 架构

```
┌ Client (React, client.js) ────────────────────────────────┐
│ sidebar.panellist 注册图标 │ main 注册整页（目录树/标签/内容）│
│ 数据：fetch('/markdown-reader/api/…')（同源）              │
└───────────────────────────────┬───────────────────────────┘
                                │ HTTP（DSH 自带 webServer）
┌ Host (index.js + lib/, Node) ─┴───────────────────────────┐
│ ctx.webServer.register({kind:'prefix', path:'/markdown-reader'}) │
│ lib/api.js    路由 + 只读文件/git/search/def               │
│ lib/state.js  多工作区根 + 路径解析（虚拟顶层前缀）          │
│ lib/defs.js   符号定义候选（Java 声明启发式 + JS/TS import） │
└───────────────────────────────────────────────────────────┘
```

- 不使用 iframe：页面是 Harness 主面板里的 React 组件，沿用 `--dsw-alias-*` 主题 token。
- 代码区固定 VSCode Dark+ 配色（代码阅读场景，与主题 chrome 区分）。
- Client 分片：`src-client/*.js` 在同一个 factory 作用域内按 `build.mjs` 的顺序拼接为 `client.js`；
  只允许 `require('react')`，无 npm/打包器。

## 安装

在本机 profile 里安装（Lead 已执行过一次）：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

安装是 **linked directory**：`~/.dsh/profiles/desktop/node_modules/@local/markdown-reader` 指向本目录，
所以本目录不能删；移动后需重新安装。

- **Client 改动**：`node build.mjs` → 刷新 Harness 页面即可。
- **Host 改动**（`index.js` / `lib/*`）：在插件管理器里把本 bundle **禁用再启用**（`set_bundle` false → true）
  即会重新加载 Host 模块，最新代码立刻生效（已验证：新增的 `/api/search`、`/api/def`、mermaid 资产白名单
  在 toggle 后直接可用）。整机重启 DSH 也能达到同样效果，但通常不需要。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: markdown-reader
      name: '@local/markdown-reader'
      config:
        roots: []      # 工作区根绝对路径数组；空 = 默认取插件目录上三级（本机为 tasks/20260917-微服务）
```

运行时通过页面「工作区」菜单添加/移除的根会持久化到 `~/.dsh/markdown-reader.state.json`，
与 config 合并；多根时路径以根目录名作前缀（`code/…`、`20260917-微服务/…`）。

## Host API（前缀 `/markdown-reader`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` `/api/meta` | 版本、工作区根（`{roots:[{name,path}],single}`） |
| POST | `/api/roots` | `{action:'add'\|'remove', path}` |
| GET | `/api/list?path=` | 目录列表（隐藏 `.git`/`node_modules` 等）；空 path 多根时返回虚拟顶层 |
| GET | `/api/markdown?path=` `/api/code?path=` | 文本内容（代码附 `lang`/`lineCount`） |
| GET | `/api/exists?path=…&path=…` | 批量路径解析（带 basename 搜索兜底） |
| GET | `/api/raw?path=` | 图片预览 |
| GET | `/api/git/meta?path=&branch=` | 分支 + 该分支最近 20 条涉及该文件的提交 |
| GET | `/api/git/diff?path=&commit=` | 解析后的 hunk（old_no/new_no 逐行） |
| GET | `/api/git/file?path=&commit=` | `git show <commit>:<path>` 完整文件 |
| GET | `/api/search?q=&limit=` | 项目内文本搜索（有界扫描/时间预算） |
| GET | `/api/files?q=&limit=` | 文件名快速索引（60s 缓存） |
| POST | `/api/def` | `{path, symbol}` → 定义候选 `{kind, path, line, snippet}` |
| GET | `/vendor/*` | marked / highlight.js / mermaid / gitgraph |

所有 git 命令都是只读的（`rev-parse` / `for-each-ref` / `log` / `show`），不 checkout、不改工作区。

## 开发

```
cd plugin
node build.mjs            # src-client/*.js -> client.js
node --check client.js    # 语法检查
```

没有重启 DSH 时验证 Host 逻辑：

```
node ../work/host-test.mjs            # http://127.0.0.1:8799
```

## 与独立版（原工具）的能力对照

| 能力 | 状态 |
|---|---|
| 目录树 / 标签页 / 多工作区根 / 项目前缀 | ✅ |
| markdown 渲染、代码块高亮、图片 | ✅ |
| 文档代码链接（`[x](path) \`123\``、`#L123`）→ 打开源码并行内高亮 | ✅ |
| 文档里裸反引号路径自动变链接（`/api/exists` 批量解析） | ✅ |
| 代码视图：行号、语法高亮、跳行 | ✅ |
| 标签页与目录展开记忆（localStorage） | ✅ |
| 分支/提交 diff（完整文件 + 增删行标记） | 🚧 |
| 项目内搜索 / 快速打开 / JSON 工具 | 🚧 |
| mermaid（懒渲染、串行、img 化） | 🚧 |
| Ctrl+点击跳定义（Java/JS/TS/Vue/SOA） | 部分：Host 已支持，客户端待接 |
| 工作台任务 chip / git graph / 同步检查更新 / SOA 适配层 | ⏳ 未移植 |

## 已知限制

- 代码定义查找是**有界源码扫描**（不是 javalang AST）：Java 重载/同名方法会返回多个候选；
  JS/TS 仅解析相对 import。
- 搜索/快速打开有扫描上限与时间预算，巨型仓库可能截断（返回 `truncated`）。
- 单文件超过 1500 行的虚拟滚动、mermaid 渲染效果需浏览器实测。
