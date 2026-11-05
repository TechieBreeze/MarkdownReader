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
| GET | `/api/exists?path=…&path=…&from=` | 批量路径解析。裸文件名走**文件名索引**（懒建、90s TTL、深度 18、跨根）；`from=<当前文档>` 让同名的文件优先命中文档所在项目 |
| GET | `/api/raw?path=` | 图片预览 / HTML 预览引用的静态资源（css/js/字体/媒体） |
| GET | `/api/html?path=` | HTML 预览（注入 `<base>` 指向 `/api/raw`，相对资源可加载） |
| GET | `/api/git/meta?path=&branch=` | 分支 + 该分支最近 20 条涉及该文件的提交 |
| GET | `/api/git/diff?path=&commit=` | 解析后的 hunk（old_no/new_no 逐行） |
| GET | `/api/git/file?path=&commit=` | `git show <commit>:<path>` 完整文件 |
| GET | `/api/search?q=&limit=` | 项目内文本搜索（有界扫描/时间预算） |
| GET | `/api/files?q=&limit=` | 文件名快速索引（60s 缓存） |
| POST | `/api/def` | 单目标符号解析，见下 |
| GET | `/api/sync/status?fetch=1` | 同步状态：仓库/分支/远程/落后领先/脏改动/待拉提交 |
| POST | `/api/sync/pull` | `git fetch` + `pull --ff-only`（脏工作区拒绝） |
| GET | `/api/git/repos` | 工作区下的 git 仓库清单（版本树用） |
| GET | `/api/git/graph?path=&limit=` | 全分支提交图（parents/refs，供手绘 SVG） |
| GET | `/vendor/*` | marked / highlight.js / mermaid / gitgraph |

所有 git 命令都是只读的（`rev-parse` / `for-each-ref` / `log` / `show` / `cat-file`），不 checkout、不改工作区；
唯一的写操作是用户点击「拉取更新」时的 `git fetch` + `git pull --ff-only`。

### `POST /api/def`（v2 单目标解析）

请求：`{path, line, col, name, kind?, text?, branch?, commit?}`

- `line` 1-based、`col` 是该行源码内 1-based 字符列（不含行号列）；`kind` ∈ `method|type|variable|constant|''`
  （空 = 按 method→type→variable 自动探测，对齐原版）。
- `text` 是当前视图的完整文本（commit/branch 视图传该版本文本）；缺省时 Host 自己读盘或 `git cat-file`。
- 成功：`200 {ok:true, file, line, kind, defName, impl:{file,line}|null}`；未找到：`400 {ok:false,error}`
  （`未找到定义` / `外部/框架方法，无本地定义`）。

实现：`lib/javasym.js`（Java 词法器 + 声明/作用域树：package/imports、类/接口/枚举/record、方法+参数、字段、
局部变量、枚举常量，含 catch/for-each/lambda/try-with-resources/record 分量/`var`）+ `lib/defs.js`
（逐条对齐原版 `server.py::_resolve_java_def`：接收者类型跨文件、接收者链 ≤3、继承链、Lombok getter/setter/is、
Mapper 接口→XML 语句行、接口→impl、链尾 `a.b().c()`；另移植原版 `/api/web/def` 的 JS/TS/Vue 分支与 `.kt` 行级近似）。
与原版 javalang 版对拍 46/46（`work/work-def-parity.mjs`）、1014 次真实点击 392/392（`work/defs-oracle-sweep.mjs`）。

## 同步 / 检查更新

插件的「同步」面板对应独立版的「检查更新」：把插件包所在 git 仓库的远程分支作为更新源。

- 当前配置（`cordis.patch.yml`）：`syncRepo: git@github.com:TechieBreeze/MarkdownReader.git`、
  `syncBranch: dsh-plugin` —— 本任务的插件分支已推送到
  <https://github.com/TechieBreeze/MarkdownReader/tree/dsh-plugin>。
- 工作流：在开发机 `git push origin master:dsh-plugin` → 本机插件面板「检查更新」看到落后 →
  「拉取更新」fast-forward；Client 刷新页面生效，Host 代码在插件管理器里把 bundle 禁用→启用。
- 未配置远程时面板会给出 `syncRepo/syncBranch` 或 `git remote add origin` 的操作提示。

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
| 项目 → 任务（工作台 chip）分层、按项目持久化 | ✅ |
| markdown 渲染、代码块高亮、图片、mermaid | ✅ |
| 文档代码链接（`[x](path) \`123\``、`#L123`）→ 打开源码并行内高亮 | ✅ |
| 文档里 ```diff 代码块 → 按提交 diff 视图渲染（行号列 / +− 符号 / 绿红灰配色） | ✅ |
| 文档里裸反引号路径自动变链接（`/api/exists` 文件名索引 + `from` 项目优先） | ✅ |
| 仓库视角链接（GitLab/GitHub `/-/blob/<ref>/<path>#L`）→ 本地文件 + 对应 git 版本 | ✅ |
| 代码视图：行号、语法高亮、跳行、虚拟滚动、常驻高亮、←返回/Alt+← | ✅ |
| 分支/提交 diff（完整文件 + 增删行标记） | ✅ |
| 项目内搜索 / 快速打开 / JSON 工具 | ✅ |
| Ctrl+点击跳定义（Java/Kotlin/JS/TS/Vue，单目标：变量/参数/字段/枚举常量/类型/方法） | ✅（本轮对齐原版） |
| 路径右键复制（复制路径 / 复制文件名） | ✅（本轮新增） |
| 同步检查更新 / Git 版本树 | ✅ |
| SOA（ody）适配层 | ⏳ 未移植（唯一功能缺失） |
| 性能日志 / 行折叠 / 书签 / 大纲 | ⏳ 未移植 |

## 已知限制

- Java 符号解析用自写词法器 + 声明/作用域树（不是 javalang AST）：行为已与原版对拍到 46/46，但**原版解析失败的文件**
  可能给出比原版更多的结果（超集）；多候选场景仍按原版规则取单目标。
- Kotlin 只做行级近似解析（原版完全不支持 `.kt` 跳转）。
- 搜索/快速打开有扫描上限与时间预算，巨型仓库可能截断（返回 `truncated`）。
- 单文件超过 1500 行的虚拟滚动、mermaid 渲染效果需浏览器实测。
