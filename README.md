# Markdown Reader · 简易 markdown 阅读辅助工具

本地 markdown 阅读器：分 tab 打开 markdown、代码阅读与编辑，**代码链接一键跳转源码（带行号）**。

## 快速开始

```bash
cd tools/markdown-reader
python server.py            # 默认 http://127.0.0.1:8765/
python server.py --port 9000   # 换端口
python server.py --root D:/other/workspace   # 换工作区根目录
```

浏览器打开 http://127.0.0.1:8765/

> 工作区根 = `tools/markdown-reader` 上两级（即本任务根目录），文件树与路径解析都以它为基准。

## 工作区根（单根 / 多项目聚合）

- 默认单根：`python server.py` → 根 = 工具目录上两级（旧行为不变）
- 指定根：`python server.py --root D:/proj`
- **多项目聚合**（任务之上加一层"项目"）：单实例同时浏览多个工作区根

  ```
  python server.py --root C:/projA --root D:/projB        # 或 --roots "C:/projA,D:/projB"
  ```

  文件树顶层显示各项目目录（按根目录名，同名自动加 `_2/_3`），每个项目内部结构
  （docs/gits/tools…）与路径均以 `<项目名>/` 为前缀，代码跳转/全局搜索/快速打开/
  Git 视图跨项目全部可用。旧文档的相对路径链接自动归属当前文档所在项目。

## 项目管理（前端，Alt+P / 顶栏「项目」按钮）

- 弹窗：项目列表（当前项目高亮 ✓）、**切换**（目录树顶层跟随当前项目）、
  **添加**（输入根目录绝对路径，回车/按钮）、**移除**（同时关闭该项目标签页）
- **任务绑定项目**：每个项目有独立的任务/标签集——切换项目时任务栏同步切换，
  各项目任务独立持久化（`mdreader.tasks.<项目名>.v1`），切回/刷新自动恢复；
  单根/聚合模式用默认 key（兼容历史任务）
- 添加/移除持久化到 `projects.json`（工具目录），下次启动自动加载（与 `--roots` 合并）；
  projects.json 里目录已被移动/删除的根启动时自动跳过（不报错退出）
- Esc 关闭弹窗；顶栏按钮显示当前状态（"项目: xxx" / "项目(全部)"）

## 检查更新（前端，Alt+U / 顶栏「同步」按钮）

服务器上开发、公司电脑上手动同步最新修改——不用敲 git 命令，也不用改远程地址。

- **远程地址内置默认值**（`server.py` 里的 `DEFAULT_SYNC_REPO` = 本仓库的 **SSH 地址**，
  分支 `master`）。换地址不用改代码：写 `sync.json`（工具目录，已 gitignore）
  或启动时加 `--sync-repo <地址> --sync-branch <分支>`。
  优先级：**CLI 参数 > sync.json > 代码内置默认值**。
- **为什么默认 SSH 而不是 HTTPS**：HTTPS 在没配凭据的机器上会直接报
  `could not read Username for 'https://github.com'`（这台开发服务器就撞过一次）；
  SSH 只需要一把部署密钥。公司电脑若没配 SSH，见下方「没配 SSH 怎么办」。
- **两步走，不越权**：「检查更新」只 `git fetch`（只读），显示落后几个提交 +
  逐条列出提交信息；**只有你点「拉取更新」才会真正 `git pull`**——
  改工作区文件的破坏性操作永远由人点一下确认。
- **origin 自动纠正**：`origin` 不存在就加、指向别处就改写成配置的地址，
  并在面板里明说改了什么（换机器/换远端后不用手动改）。
- **安全网**：
  - 有未提交的**已跟踪**文件修改时拒绝拉取并列出文件名（未跟踪的新文件不算，
    它们不影响 pull）；
  - 只用 `git pull --ff-only`，不会产生合并提交、不会悄悄改写你的本地历史；
  - 本地与远端**分叉**（本地有提交、远端也有新提交）时不硬来，改为说明情况并
    给出 `git push` / `git reset --hard` 两条命令让你自己选。
- 本地领先远端时只提示，不覆盖、不警告刷屏。

```jsonc
// sync.json（可选，不写就用代码里的默认地址 = git@github.com:...）
{ "repo": "git@github.com:TechieBreeze/MarkdownReader.git", "branch": "master" }
```

### 没配 SSH 怎么办

公司电脑上如果没配 SSH 密钥，`git fetch` 会报
`could not read Username for 'https://github.com'` 或 `Permission denied (publickey)`。

**方案 A（推荐）：配一把部署密钥给 GitHub**

1. 生成（Windows 用 Git Bash / PowerShell 都行）：

   ```bash
   ssh-keygen -t ed25519 -C "you@company-pc"
   ```

2. 公钥（`~/.ssh/id_ed25519.pub`）贴到 GitHub → Settings → SSH and GPG keys → New SSH key
3. 验证：

   ```bash
   ssh -T git@github.com     # 看到 "Hi <用户名>! You've successfully authenticated" 即成功
   ```

**方案 B：用 Personal Access Token 走 HTTPS**

写 `sync.json` 覆盖地址即可：

```jsonc
{ "repo": "https://github.com/TechieBreeze/MarkdownReader.git", "branch": "master" }
```

Token 在 GitHub → Settings → Developer settings → Personal access tokens 生成，
权限只需 `repo`。**注意**：配之前先把账号里其它旧 token 轮换掉
（Personal access tokens 页面可以列出并删除历史 token），别用新建的替代旧的。

## 一键启动（launch.py / start.bat）

```bash
python launch.py                              # 默认根 + 8765 + 自动开浏览器
python launch.py --roots C:/projA,D:/projB    # 多项目聚合
python launch.py --port 8766                  # 换端口（多开：每个实例独立端口/origin）
start.bat                                     # Windows 双击版（可带同样参数）
```

工具目录**可整体移到任意位置**（无任何路径绑定，server.py/index.html 全相对路径），
移走后用 `--root/--roots` 指向工作区即可。server 在独立窗口运行，关掉启动窗口不影响。

## E2E 测试

`e2e/jump_nav_e2e.py`：模拟真实 debug/梳理业务场景——大 Java 文件里 Ctrl+点击逐层
追踪业务链（Controller→Service→Impl→Facade→DTO），随时 Alt+←/→ 返回前进，穿插
变量/Lombok getter/方法引用/接口→实现/多仓库同名类跳转。

覆盖：业务链逐层追踪与全链回退前进、跳转历史栈不变式（去重/幂等/前进分支截断/
容量 200）、同文件与跨文件跳转落地 flash 反馈、多仓库跳转、「未找到定义」零误报、
性能护栏（P95 < 1s）。全部用真实浏览器 + CDP 真实事件驱动，47 项断言。

运行（server 运行中 + Hermes browser_exec 通道）：

```python
exec(open(r"<绝对路径>/e2e/jump_nav_e2e.py", encoding="utf-8").read())
```

结束自动清理 localStorage 7 键还原默认状态；退出码 0=全过，1=有失败。

**daemon 稳定性限制与分批跑**：browser-harness daemon（0.1.13 + Chrome 155）在
单会话约 5 次真实 Ctrl+点击后可能卡死（IPC 无响应，环境工具链问题，非本工具缺陷）。
e2e 支持环境变量按场景/子段分批跑（每个 browser_exec 调用是独立 daemon）：

```python
os.environ["MDREADER_SCENES"] = "scene1"          # 只跑场景1
os.environ["MDREADER_SCENES"] = "scene2"; os.environ["MDREADER_S2"] = "b"   # 场景2 后半段
os.environ["MDREADER_SCENES"] = "scene3"
os.environ["MDREADER_SCENES"] = "scene4,scene5"
```

daemon 卡死后：杀 chrome.exe + 清理 `C:/Users/1/.config/browser-harness/runtime/`
下的 bu-*.pid/port/spawnlock，再手动起调试 Chrome
（`chrome.exe --remote-debugging-port=9222 --user-data-dir=<临时目录>`）。

## 功能

| 功能 | 说明 |
|------|------|
| 分 tab 打开 md | 左侧文件树点选，或顶部输入框直接输入相对路径（回车） |
| 目录树 | 树与内容区之间有**拖拽分隔条**可调宽度（宽度记忆在本地，刷新保留）；长文件名/深路径超出树宽时**可横向滚动**，顶部工具栏横向滚动时保持可见 |
| 任务拖拽排序 | 任务栏（工作台）里的任务 chip 可**按住拖动调整顺序**，松手即持久化；拖到栏边缘自动横向滚动 |
| 标签页拖拽排序 | 标签页可按住拖动调整当前任务内的顺序 |
| 代码链接一键跳转 | 识别 **md-code-jump 规范**链接：`[文件名](相对路径) \`行号\``——链接显示为绿色徽章 + 行号，点击弹出代码弹窗并**滚动高亮目标行** |
| 代码阅读 | 弹窗内行号 + 语法高亮；代码窗口左上角路径**hover 显示完整路径**（超长省略时） |
| 定位 | 任意标签页（markdown / 代码 / HTML / 图片）工具条点「定位」→ 左侧目录树**自动展开到该文件的全部父目录**并高亮滚动到该文件；展开状态持久化，刷新后仍在 |
| 树中当前文件高亮 | 打开的文件若在目录树中可见（父目录已展开），对应条目**持续高亮**（左侧蓝条 + 亮色文件名）；切换标签/展开折叠/刷新树/重新加载都会跟随同步 |
| 文件内搜索 | **Ctrl+F** 呼出浮动搜索条（拦截浏览器自带查找；再按一次 Ctrl+F 自动收起）：输入后**回车触发搜索**（逐字不高亮，避免大文件卡顿），代码/源码按行高亮、md 高亮渲染文本，回车下一个 / Shift+Enter 上一个 / Esc 关闭；支持 **大小写 / 全字 / 正则** 三个开关（切换即重搜） |
| 全局搜索 | **Ctrl+Shift+F** 弹窗：整个工作区按文件搜索（不区分大小写），文件可**展开查看匹配行**，点行即打开该文件定位到对应行；输入以 **`r/` 开头为正则**（忽略大小写），**扩展名输入框**按类型过滤，**历史记录**可一键重搜 |
| ctrl+点击跳实现 | 代码视图内 **Ctrl+点击**：接口方法声明 → 跳到实现 —— Service 接口方法 → `XxxServiceImpl` 对应方法行；Mapper 接口方法 → 同名 `XxxMapper.xml` 对应 SQL 语句行（精确到行）；**调用处 → 定义**（`obj.method()` 跳到方法声明）、**类名 → 类文件**（类型引用跳到该类的声明文件）同样支持 |
| 查找引用 | 代码视图内 **Ctrl+Shift+点击** 任意符号 → 自动打开全局搜索并填入该符号名（查看所有引用处） |
| Peek 定义预览 | 代码视图内 **Alt+点击** 符号 → 悬浮卡片预览定义（目标文件 + 行号 + 前后代码片段），不跳转；卡片内「跳转」按钮可直达定义 |
| 全局跳转历史 | 顶栏 **←/→** 按钮或 **Alt+← / Alt+→**：树点击 / 代码链接 / Ctrl+点击跳转 / 搜索点行 都记录为位置，可后退/前进；同位置去重、新跳转截断前进分支 |
| 快速打开 | **Ctrl+P**：全工作区文件名/路径模糊匹配（文件名前缀 > 后缀 > 边界子串排序），↑↓ 选择回车打开 |
| 最近文件 | **Ctrl+E**：最近打开的文件（去重置顶、跨会话持久化），可过滤 |
| 符号大纲 | **Ctrl+Shift+O**：当前代码文件的结构视图（类/接口 + 方法签名 + 行号，轻量解析不建 AST），回车跳转 |
| 跳转行 | **Ctrl+G**：输入行号回车跳转（越界提示） |
| 书签 | 代码行号区**点击切换书签**（行号金色 + 行底微黄，跨会话持久化）；**Ctrl+B** 查看全部书签列表，回车跳转 |
| 代码折叠 | **Ctrl+Shift+[** 折叠光标所在行的方法/类块（行尾显示 `▸ N 行`），**Ctrl+Shift+]** 展开，点击折叠行也可展开；持久化 |
| 括号配对 | 点击代码括号 `( ) [ ] { }` → 配对两端所在行左右黄边高亮（跨行配对应答） |
| 面包屑定位树 | 点击代码/HTML/图片标签页头部路径 或 代码弹窗路径 → 目录树自动展开到该文件并高亮定位 |
| Git 版本树 | 顶栏「**Git 图**」：选仓库（自动定位当前文件所属仓库）→ canvas 渲染分支/合并/提交图（gitgraph.js），**点击 commit 右侧面板显示** 作者/日期/所属分支/标签/父提交/提交说明；分支按第一父链推断、merge commit 显示双父 |
| 提交查看 | 代码弹窗内**选分支 → 下拉最近提交**，选中后该提交对当前文件的改动行**绿色(新增)/灰色(上下文)高亮**，顶部显示作者/日期/提交说明/改动统计 |
| JSON 工具 | 顶栏 🛠 JSON：输入 JSON → 格式化(2空格)/压缩/校验，输出语法高亮，错误精确到行:列 |
| mermaid 渲染 | md 中 ` ```mermaid ` 代码块自动渲染成图（本地 vendor/mermaid.min.js，离线可用） |
| 图片/资源 | md 内相对路径图片自动代理到本地文件 |
| 跨 md 跳转 | md 里指向其他 `.md` 的链接在 tab 中打开 |
| 安全 | 所有路径限制在工作区根内，`../` 越界被拒绝 |

## 代码链接格式（与 md-code-jump 一致）

```markdown
[FooController.java](../../module/src/main/java/com/example/api/FooController.java) `297`
```

- 链接 href 是**相对当前 md** 的相对路径（只到文件，不含行号）
- 行号写在链接外的反引号里
- 链接文字用短文件名，阅读时显示绿色徽章 + 黄色行号角标，点击即跳

两跳（Controller → Service）：

```markdown
[FooController.java](../../module/src/main/java/com/example/api/FooController.java) `182` → [FooServiceImpl.java](../../module/src/main/java/com/example/service/impl/FooServiceImpl.java) `66`
```

## 目录结构

```
tools/markdown-reader/
├── server.py        # Python 本地服务（http.server 标准库，无第三方依赖）
├── index.html       # 前端单页（tab + 文件树 + 代码弹窗）
├── vendor/
│   ├── marked.min.js    # markdown 渲染（已本地化）
│   └── mermaid.min.js   # mermaid 图渲染（已本地化）
└── README.md
```

## API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/list?path=` | GET | 目录列表（文件树） |
| `/api/files` | GET | 全量可打开文件清单（快速打开 Ctrl+P 用；TTL 60s 缓存） |
| `/api/markdown?path=` | GET | 读 markdown 内容 |
| `/api/code?path=` | GET | 读任意代码文件（前端高亮行号） |
| `/api/raw?path=` | GET | 读任意文件（图片等资源代理） |
| `/api/git/meta?path=&branch=` | GET | 文件所属仓库：分支列表 + 最近 30 条提交（作者/日期/说明） |
| `/api/git/graph?path=` | GET | Git 版本树数据：全部分支/标签引用 + 最近 250 条提交（id/parents/作者/日期/消息），`truncated` 标记超限 |
| `/api/git/repos` | GET | 枚举工作区下所有 git 仓库（Git 版本树仓库下拉） |
| `/api/git/diff?path=&commit=` | GET | 某提交对当前文件的 diff hunks（含提交作者信息） |
| `/api/exists?path=` | GET | 路径是否存在 |
| `/api/sync/status?fetch=1` | GET | 同步状态：仓库地址/分支/本地版本/领先落后/待拉取提交列表；`fetch=1` 才联网取远端，默认不联网 |
| `/api/sync/pull` | POST | 执行 `git pull --ff-only`（唯一会改写工作区的同步接口；脏工作区/分叉时返回 `ok:false` + 原因） |
| `/api/search?q=&re=&ext=` | GET | 全局搜索：整个工作区扫文本文件，返回文件 + 匹配行（不区分大小写，限量防阻塞）；`re=1` 正则模式、`ext=扩展名` 类型过滤 |

> 提交查看原理：后端在文件所属 git 仓库执行 `git log` / `git show`；前端按 diff hunks 的行号把「新增/上下文」行高亮在代码视图上（删除行在当前文件中已不存在，只计入统计）。
