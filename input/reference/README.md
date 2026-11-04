# Markdown Reader

本地 markdown 阅读器 + 源码追踪器：读文档的同时**在源码里追链路**。

- **文档 → 代码**：md 里的代码链接一键打开源码并定位到行
- **代码 → 代码**：Ctrl+点击符号跳到定义（Java / Kotlin / JS / TS / Vue / SOA 远程调用）
- **代码 → 历史**：按 git 分支或提交看同一份文件，带 diff 标记
- **多项目聚合**：一个实例同时浏览多个工作区，任务 / 搜索 / git 视图都按项目隔离

单文件前端 + 标准库 Python 后端，**零外部依赖**（marked / mermaid / javalang 全部本地化），
工具目录可整体拷走即用。

---

## 快速开始

### 最快路径

- Windows：双击 `start.bat`
- 任意平台：`python launch.py`（自动开浏览器）

### 手动启动

```bash
cd tools/markdown-reader
python server.py                  # 默认 http://127.0.0.1:8765/
```

### 命令行参数

`launch.py`（一键启动）：

| 参数 | 说明 |
|------|------|
| `--root <路径>` | 工作区根，可重复给（= 多项目聚合） |
| `--roots "A,B"` | 同上，逗号分隔 |
| `--port <端口>` | 监听端口（默认 8765）；端口已被占用时提示改用其它端口 |
| `--no-open` | 不自动打开浏览器 |
| `--reuse` | 端口已被占用时直接打开浏览器（假定已有实例在跑） |

`server.py`（本体）另外支持：

| 参数 | 说明 |
|------|------|
| `--sync-repo <地址>` | 检查更新用的远程仓库（默认内置 SSH 地址，见「检查更新」） |
| `--sync-branch <分支>` | 同步分支（默认 master） |

工作区根 = 工具目录上两级（= 本任务根目录）；文件树与所有路径解析都以它为基准。

> 改 `server.py` / `soa_defs.py` 必须**重启服务**；只改 `index.html` 刷新浏览器即可生效。

---

## 界面结构

```
┌ 顶栏  打开输入框 │ 项目 │ 同步 │ Git 图 │ 主题 │ JSON ┐
├ 任务栏  工作台任务 chip（可拖拽排序，按项目隔离持久化）    ┤
├ 目录树（可拖宽 / 横滚）│ 标签栏 + 内容区                ┤
```

两种代码视图，用途不同：

| 视图 | 打开方式 | 特点 |
|------|----------|------|
| **代码弹窗** | 点 md 里的代码链接；在代码弹窗里 Ctrl+点击跳到别的文件（内容就地替换） | 带行号、语法高亮、git 分支/提交下拉、「← 返回」、「开成标签页」 |
| **代码标签页** | 弹窗右上「开成标签页」；快速打开 / 搜索里直接开代码文件；代码 tab 里 Ctrl+点击会**开成新标签页** | 与文档标签页并列，可切分支/提交 |

两者都能按 **git 分支** 或 **提交** 渲染（见「看 git 版本」）。

---

## 五分钟上手

1. **打开文档** —— 左侧目录树点选，或顶栏输入相对路径回车。
2. **从文档跳到源码** —— md 里的代码链接是绿色徽章 + 行号角标，点击弹出代码弹窗并高亮定位到那一行。
3. **从源码追链路** —— 代码视图里 **Ctrl+点击** 符号：接口方法 → 实现类、调用处 → 声明、
   类型 → 类文件、枚举值 → 枚举声明。弹窗右上「← 返回」退回原处，`Alt+← / Alt+→` 也能前后走。
4. **看某次提交改了什么** —— 代码弹窗顶部选「分支 / 提交」→ 选一个提交 → 文件按该提交渲染，
   改动行**绿底（新增）/ 红底划线（删除）/ 灰底（上下文）**。
5. **找东西** —— `Ctrl+F` 搜当前文件、`Ctrl+Shift+F` 搜整个项目、`Ctrl+P` 按文件名快速打开。

---

## 工作区与项目

- **单根**：`python server.py` → 根 = 工具目录上两级（旧行为不变）
- **多根（多项目聚合）**：任务之上加一层「项目」，单实例同时浏览多个工作区

  ```bash
  python server.py --root C:/projA --root D:/projB      # 或 --roots "C:/projA,D:/projB"
  ```

  文件树顶层显示各项目目录（按根目录名，同名自动加 `_2/_3`），项目内部结构与路径
  都以 `<项目名>/` 为前缀；代码跳转 / 全局搜索 / 快速打开 / Git 视图跨项目全部可用。
  旧文档的相对路径链接自动归属当前文档所在项目。

### 项目面板（Alt+P / 顶栏「项目」）

- 列表里**切换**（目录树顶层跟随当前项目）、**添加**（输入根目录绝对路径）、
  **移除**（同时关闭该项目标签页）
- **任务绑定项目**：每个项目一套独立任务/标签，切换项目时任务栏同步切换，
  独立持久化（`mdreader.tasks.<项目名>.v1`）；单根/聚合模式用默认 key（兼容历史任务）
- 增删持久化到工具目录的 `projects.json`，下次启动自动加载（与 `--roots` 合并）；
  里面目录已被移动/删除的根启动时自动跳过（不报错退出）
- Esc 关闭弹窗；顶栏按钮显示当前状态（"项目: xxx" / "项目(全部)"）

---

## 读代码：Ctrl+点击跳转

代码视图里 **Ctrl+点击** 任意符号 → 跳到它的定义。三类解析层各管各的语言：

| 语言 / 场景 | 跳到哪 | 解析层 |
|------|------|------|
| Java / Kotlin | 方法声明行、类声明文件、枚举常量声明行、字段 | `server.py` + javalang AST（`vendor_py/`） |
| JS / TS / Vue | import 目标文件与具名导入的定义行、default / 命名空间导入、`require(...)`、Vue 组件标签 `<FooBar/>`、`<script setup>` 顶层声明、局部 `const/function/class` | `web_defs.py`（行级正则 + 小状态机） |
| SOA 远程调用（ody） | SDK 接口方法 → 服务端实现类的同名方法；请求/响应 DTO → DTO 类文件 | `soa_defs.py` 适配层 |

**识别范围**

- **泛型**：`OutputDTO<Map<Long, Boolean>>` 里的 `OutputDTO` / `Boolean`、
  `List<Foo>` 里的 `List` 与 `Foo` 都能高亮并跳转；方法签名里的参数类型、
  import 路径里的类名同样可点。
- **枚举值**（`X.CONST`）可高亮、可跳到枚举声明行。
- **接口 → 实现**：Service 接口方法跳到 `XxxServiceImpl` 的对应方法行；
  Mapper 接口方法跳到同名 `XxxMapper.xml` 的 SQL 行。

**辅助操作**

- **Peek 预览**：`Alt+点击` 出悬浮卡片（目标文件 + 行号 + 前后片段），不跳转；
  卡片内「跳转」按钮可直达定义。
- **查找引用**：`Ctrl+Shift+点击` 打开全局搜索并填入该符号名。

**两个刻意的限制**

- **diff（提交）视图里删除行整行不支持跳转**。删除行的行号属于**旧版本**，
  而代码区渲染的是**新版本全文**，行号与文本整体错位，跳过去必然落到错误位置或
  解析失败（实测会弹「未找到定义」）。所以整行连「可跳转」的 hover 提示
  （下划线 / pointer）都不给。
- **不跨项目跳**。搜索边界 = 当前项目，项目内以 git 仓库为基本单位排序，
  本项目找不到宁可不跳，也不跳到别的项目的同名类。

**性能**：项目内建 FQN→文件 的**类索引**（启动后台预热，TTL 5 分钟），
一次点击的类型探测从 2.4s 降到 ~80ms。

---

## 看 git 版本

代码弹窗 / 代码标签页顶部都有**分支**与**提交**两个下拉：

- 选**分支** → 按该分支的文件内容渲染；
- 选**提交** → 按该提交的文件内容渲染，并叠加这次提交的改动标记：
  **新增绿底 / 删除红底划线（旧行号，内联在原位置）/ 上下文灰底**，
  顶部显示作者、日期、提交说明与增删统计；
- 提交视图下**跳转 / 返回都不丢 diff**：弹窗「← 返回」与 `Alt+←` 回到原位置时，
  改动块仍在；
- 该提交没改这个文件时给出明确提示（而不是静默显示工作区版本）。

### Git 版本树（顶栏「Git 图」）

选仓库（自动定位当前文件所属仓库）→ canvas 渲染分支/合并/提交图，**点击 commit**
右侧面板显示作者 / 日期 / 所属分支 / 标签 / 父提交 / 提交说明；merge commit 显示双父。

轨道（lane）分配交给 `git log --graph` 本身——它内置 lane swapping，
这是「拉临时分支 → 合并 → 删除」能画紧凑的唯一前提，前端不自研轨道分配。
提交**分页懒加载**（滚动到底再拉下一批），统计栏显示「已加载 N / 总数」而不是静默截断。

---

## 找东西

| 场景 | 快捷键 | 说明 |
|------|--------|------|
| 文件内搜索 | `Ctrl+F` | 代码弹窗打开时搜弹窗里的代码，否则搜当前标签页（代码 tab / md 正文）；命中用浏览器原生 **Custom Highlight API** 标在**目标文本**上（可跨多个语法高亮 span）；回车下一个 / Shift+Enter 上一个 / Esc 关闭；优先选中当前视口内最靠上的命中 |
| 全局搜索 | `Ctrl+Shift+F` | 当前项目按文件搜索（不区分大小写），文件可展开看匹配行，点行即打开并定位；输入以 `r/` 开头为正则（忽略大小写）；扩展名输入框按类型过滤；历史记录一键重搜 |
| 快速打开 | `Ctrl+P` | 全工作区文件名/路径模糊匹配（文件名前缀 > 后缀 > 边界子串排序），↑↓ 选择回车打开 |
| 最近文件 | `Ctrl+E` | 最近打开的文件（去重置顶、跨会话持久化），可过滤 |
| 符号大纲 | `Ctrl+Shift+O` | 当前代码文件的结构视图（类/接口 + 方法签名 + 行号，轻量解析不建 AST），回车跳转 |
| 跳转行 | `Ctrl+G` | 输入行号回车跳转（越界提示） |
| 书签 | `Ctrl+B` | 书签列表，回车跳转；代码行号区点击即可加/去书签 |

> 搜索类接口默认**只搜当前项目**（扫描类接口跨项目要显式 `project=`）——
> 微服务项目 ~3900 文件、baseline ~18800 文件，跨项目搜既慢又会命中别的项目的同名文件。

---

## 文档里的链接怎么写

### 代码链接（md-code-jump 规范）

```markdown
[FooController.java](../../module/src/main/java/com/example/api/FooController.java) `297`
```

- href 是**相对当前 md** 的相对路径（只到文件，不含行号）
- 行号写在链接外的反引号里
- 链接文字用短文件名，阅读时显示绿色徽章 + 黄色行号角标，点击即跳

两跳（Controller → Service）：

```markdown
[FooController.java](../../module/src/main/java/com/example/api/FooController.java) `182` → [FooServiceImpl.java](../../module/src/main/java/com/example/service/impl/FooServiceImpl.java) `66`
```

### md → md 也支持行号

`[业务说明.md](doc/业务说明.md#L85)` → 打开并定位到第 85 行。

### 仓库视角链接自动解析

md 里的 GitLab（`/-/blob/<ref>/<path>`）、GitHub（`/blob/<ref>/<path>`）链接
会自动解析成本地工作区文件（URL 里的分支/标签对应本地 git 版本，本地没有该 ref
就退回工作区版本）：点击开本地代码弹窗，`Ctrl+点击` 开成标签页，`Shift+点击` / 右键
仍走浏览器原生（拿到的还是原始远端 URL）。解析不到则保持原链接行为。

---

## 快捷键总表

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+点击` | 跳转到定义（Java / Kotlin / JS / TS / Vue / SOA） |
| `Alt+点击` | Peek 定义预览（不跳转） |
| `Ctrl+Shift+点击` | 查找引用（打开全局搜索并填入符号名） |
| `Ctrl+F` / `Ctrl+Shift+F` | 文件内搜索 / 全局搜索 |
| `Ctrl+P` / `Ctrl+E` | 快速打开 / 最近文件 |
| `Ctrl+Shift+O` / `Ctrl+G` / `Ctrl+B` | 符号大纲 / 跳转行 / 书签 |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 折叠 / 展开代码块 |
| `Alt+←` / `Alt+→` | 跳转历史后退 / 前进 |
| `Alt+P` / `Alt+U` | 项目管理 / 检查更新 |
| `Esc` | 关闭当前浮层（弹窗内先关搜索条，再按一次才关弹窗） |

---

## 功能速查

**读文档**：分 tab 打开 md（树 / 顶栏输入 / `Ctrl+P` / 搜索结果）；目录树可拖宽、
长路径可横向滚动、带层级引导线、当前文件持续高亮、「定位」展开全部父目录；
md 表格 / mermaid 图 / 图片代理 / HTML 预览；md 代码块高亮与代码视图统一。

**读代码**：行号 + 语法高亮；大文件自动虚拟滚动（行宽按真实 `scrollWidth` 计算，
可横向滚动）；点括号高亮配对两端；行号点击加书签；折叠 / 展开；大纲；跳行；
文件路径**右键一键复制**（代码弹窗头 / 代码 tab 头 / md 工具条 / 搜索结果）。

**看 git**：分支 / 提交视图 + diff 标记；Git 版本树（分页懒加载、点 commit 看详情）；
md 里的仓库链接直接按 git 版本打开。

**管理**：项目面板（项目隔离）；检查更新面板；明暗主题切换；JSON 工具
（格式化 / 压缩 / 校验，错误精确到行:列）。

**安全**：所有路径限制在工作区根内，`../` 越界被拒绝。

---

## 检查更新（Alt+U / 顶栏「同步」）

服务器上开发、公司电脑上手动同步最新修改——不用敲 git 命令，也不用改远程地址。

- **远程地址内置默认值**（`server.py` 的 `DEFAULT_SYNC_REPO` = 本仓库的 **SSH 地址**，
  分支 `master`）。换地址不用改代码：写 `sync.json`（工具目录，已 gitignore）
  或启动时加 `--sync-repo <地址> --sync-branch <分支>`。
  优先级：**CLI 参数 > sync.json > 代码内置默认值**。
- **为什么默认 SSH 而不是 HTTPS**：HTTPS 在没配凭据的机器上会直接报
  `could not read Username for 'https://github.com'`；SSH 只需要一把部署密钥。
- **两步走，不越权**：「检查更新」只 `git fetch`（只读），显示落后几个提交 +
  逐条列出提交信息；**只有你点「拉取更新」才会真正 `git pull`**——
  改工作区文件的破坏性操作永远由人点一下确认。
- **origin 自动纠正**：`origin` 不存在就加、指向别处就改写成配置的地址，
  并在面板里明说改了什么。
- **安全网**：有未提交的**已跟踪**文件修改时拒绝拉取并列出文件名（未跟踪的新文件不算）；
  只用 `git pull --ff-only`（不产生合并提交、不改写本地历史）；
  本地与远端**分叉**时不硬来，改为说明情况并给出 `git push` / `git reset --hard`
  两条命令让你自己选；本地领先远端时只提示，不覆盖。

```jsonc
// sync.json（可选，不写就用代码里的默认地址）
{ "repo": "git@github.com:TechieBreeze/MarkdownReader.git", "branch": "master" }
```

### 没配 SSH 怎么办

`git fetch` 报 `could not read Username for 'https://github.com'` 或
`Permission denied (publickey)` 时，两条路：

**方案 A（推荐）：配一把部署密钥给 GitHub**

1. `ssh-keygen -t ed25519 -C "you@company-pc"`
2. 公钥（`~/.ssh/id_ed25519.pub`）贴到 GitHub → Settings → SSH and GPG keys → New SSH key
3. 验证：`ssh -T git@github.com`（看到 `Hi <用户名>! You've successfully authenticated` 即成功）

**方案 B：Personal Access Token 走 HTTPS** —— 写 `sync.json` 覆盖地址即可：

```jsonc
{ "repo": "https://github.com/TechieBreeze/MarkdownReader.git", "branch": "master" }
```

Token 在 GitHub → Settings → Developer settings → Personal access tokens 生成，权限只需 `repo`。
**注意**：配之前先把账号里其它旧 token 轮换掉（Personal access tokens 页面可以列出并删除
历史 token），别用新建的替代旧的。

---

## E2E 测试

两种形态，都要求**服务先跑起来**（`python server.py`，端口 8765）。

### 1. 场景化回归：`e2e/jump_nav_e2e.py`

模拟真实 debug / 梳理业务场景——大 Java 文件里 Ctrl+点击逐层追踪业务链
（Controller→Service→Impl→Facade→DTO），随时 Alt+←/→ 返回前进，穿插变量/Lombok
getter/方法引用/接口→实现/多仓库同名类跳转。

覆盖：业务链逐层追踪与全链回退前进、跳转历史栈不变式（去重/幂等/前进分支截断/
容量 200）、同文件与跨文件跳转落地 flash 反馈、多仓库跳转、「未找到定义」零误报、
性能护栏（P95 < 1s）。全部用真实浏览器 + CDP 真实事件驱动，47 项断言。

```python
exec(open(r"<绝对路径>/e2e/jump_nav_e2e.py", encoding="utf-8").read())
```

结束自动清理 localStorage 7 键还原默认状态；退出码 `0`=全过，`1`=有失败。

**daemon 稳定性限制与分批跑**：browser-harness daemon（0.1.13 + Chrome 155）在
单会话约 5 次真实 Ctrl+点击后可能卡死（IPC 无响应，环境工具链问题，非本工具缺陷）。
支持按场景/子段分批跑（每个 browser_exec 调用是独立 daemon）：

```python
os.environ["MDREADER_SCENES"] = "scene1"          # 只跑场景1
os.environ["MDREADER_SCENES"] = "scene2"; os.environ["MDREADER_S2"] = "b"   # 场景2 后半段
os.environ["MDREADER_SCENES"] = "scene3"
os.environ["MDREADER_SCENES"] = "scene4,scene5"
```

daemon 卡死后：杀 chrome.exe + 清理 `C:/Users/1/.config/browser-harness/runtime/`
下的 bu-*.pid/port/spawnlock，再手动起调试 Chrome
（`chrome.exe --remote-debugging-port=9222 --user-data-dir=<临时目录>`）。

### 2. 单点回归套件：`e2e/*.js`（14 个）

每个套件自己拉起**真实无头 Chrome**、用**真实 Ctrl+点击**驱动，断言打在用户能感知的
路径上（不靠注入 JS 调函数）。

```bash
node e2e/diff_nav_check.js     # 一次跑一个；也可按顺序跑全部
```

退出码：`0` = 全过、`1` = 有失败、`2` = 样本缺失（无法验证）。
puppeteer 从环境变量 `MDREADER_PUPPETEER` 或本机默认路径查找。

| 套件 | 覆盖 |
|------|------|
| `modal_search_check` | Ctrl+F 文件内搜索（代码弹窗/代码 tab/md 正文）、命中高亮标在目标文本上、视口内优先选中、Esc 互不干扰 |
| `param_type_jump_check` | 方法签名里的参数类型识别与跳转 |
| `enum_const_jump_check` | 枚举常量高亮与跳转 |
| `java_type_highlight_check` | 泛型返回值 / `List` / import 类名的高亮与跳转 |
| `soa_jump_check` | SOA（ody）SDK 接口 → 服务端实现、DTO 跳转、JDK 类型不乱跳 |
| `diff_view_check` | 提交 diff 视图不丢行、不补空行 |
| `diff_nav_check` | diff 视图下跳转/返回不丢 diff；删除行整行不跳转、hover 无「可跳转」提示 |
| `modal_line_check` | 弹窗跳转行号定位、返回后高亮行不漂 |
| `highlight_consistency_check` | md 代码块与代码视图高亮一致 |
| `repo_link_check` | 仓库视角链接（GitLab/GitHub）→ 本地文件 |
| `path_copy_check` | 路径右键一键复制 |
| `tabbar_scroll_check` | 标签栏横向滚动 |
| `mermaid_dark_check` | mermaid 暗色主题下 classDef 节点不再压暗 |
| `gitgraph_check` | Git 版本树渲染 |

> 批量跑**务必串行**：并行跑多个套件会把服务端压到超时（git 子进程慢），
> 表现为个别套件偶发失败——那是环境负载，不是产品回归。

---

## 架构与扩展

分三层，**换框架 / 换语言只动对应那一层**：

```
server.py   核心：路径与项目边界、git 仓库发现、类索引、通用 Java AST
   ├─ soa_defs.py   远程调用框架适配（注册表 + adapter，可整层删掉）
   └─ web_defs.py   前端语言（JS/TS/Vue）解析
```

- **适配层可拆卸**：`server.py` 只在「通用 Java 解析没命中」时调用 `soa_defs.py`
  的两个钩子（`resolve_type` / `resolve_impl`）。删掉本文件、或把 `ADAPTERS` 清空
  → 回到纯通用行为，其它功能不受影响。
- **加一个远程调用框架** = 写一个 `SoaAdapter` 子类并 `register()`，`server.py` 一行不用改：

  ```python
  class MyAdapter(SoaAdapter):
      name = "my-soa"
      def resolve_impl(self, ctx):
          ...          # 返回实现类相对路径，或 None（本框架不处理）
  register(MyAdapter())
  ```

- 当前适配器 `OdySoaAdapter` 按 odianyun（ody）SOA 约定工作：客户端 SDK 接口
  `@SoaServiceClient(name="<服务池>", interfaceName="<接口 FQN>")` →
  另一个 maven 模块里的服务端实现 `@SoaServiceRegister(interfaceClass=<接口 FQN>.class)`；
  请求/响应 DTO 在 `ody.soa.<域>.request|.response` 包下，常被业务模块通配符导入
  （`import ody.soa.product.request.*`），类型定义在 `soa-sdk-jar` 里。

---

## 参考

### 目录结构

```
tools/markdown-reader/
├── server.py        # Python 本地服务（http.server 标准库；Java 解析依赖 vendor_py/javalang）
├── soa_defs.py      # SOA 远程调用跳转适配层（可拆卸：换个框架 = 加一个 adapter）
├── web_defs.py      # JS / TS / Vue 定义跳转解析（/api/web/def）
├── index.html       # 前端单页（tab + 文件树 + 代码弹窗 + Git 图）
├── launch.py        # 一键启动（根 / 端口 / 自动开浏览器）
├── start.bat        # Windows 双击版
├── projects.json    # 项目列表 + 当前项目（本地持久化，已 gitignore）
├── e2e/             # 回归套件（14 个 node 套件 + 1 个场景化 python 套件）
├── vendor/          # marked.min.js / mermaid.min.js（离线）
├── vendor_py/       # javalang（Java 源码解析，纯离线）
└── README.md
```

### API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/list?path=` | GET | 目录列表（文件树） |
| `/api/files` | GET | 全量可打开文件清单（快速打开 Ctrl+P 用；TTL 60s 缓存） |
| `/api/markdown?path=` | GET | 读 markdown 内容 |
| `/api/code?path=` | GET | 读任意代码文件（前端高亮行号） |
| `/api/raw?path=` | GET | 读任意文件（图片等资源代理） |
| `/api/html?path=` | GET | HTML 预览（注入 `<base>` 指向资源代理，避免 iframe srcdoc 的跨域/嵌套坑） |
| `/api/save` | POST | 保存文件（编辑后回写） |
| `/api/meta` | GET | 当前项目信息（根、是否单根、当前项目名） |
| `/api/projects` | GET/POST | 项目列表 / 增删（持久化到 `projects.json`） |
| `/api/git/meta?path=&branch=` | GET | 文件所属仓库：分支列表 + 最近 30 条提交（作者/日期/说明） |
| `/api/git/graph?path=&offset=&limit=` | GET | Git 版本树数据：全部分支/标签引用 + 提交分页（id/parents/作者/日期/消息），回带 `total`/`hasMore` |
| `/api/git/repos?project=` | GET | 枚举工作区下所有 git 仓库（Git 版本树仓库下拉；缺省当前项目） |
| `/api/git/diff?path=&commit=` | GET | 某提交对当前文件的 diff hunks（含提交作者信息） |
| `/api/git/file?path=&commit=` | GET | 某提交版本的文件内容（diff 视图的底稿） |
| `/api/git/resolve?url=` | GET | 仓库视角链接（GitLab/GitHub）→ 本地文件路径 + 行号 + git 版本 |
| `/api/java/def` | POST | Java/Kotlin 符号定义（javalang AST）：`path`/`line`/`col`/`text`（+`branch`/`commit`/`name`/`kind`） |
| `/api/web/def` | POST | JS/TS/Vue 符号定义（`web_defs.py`），参数同上 |
| `/api/exists?path=` | GET | 路径是否存在 |
| `/api/search?q=&re=&ext=&project=` | GET | 全局搜索：当前项目扫文本文件，返回文件 + 匹配行（不区分大小写）；`re=1` 正则模式、`ext=扩展名` 类型过滤；回带 `scope`/`scanned` |
| `/api/sync/status?fetch=1` | GET | 同步状态：仓库地址/分支/本地版本/领先落后/待拉取提交列表；`fetch=1` 才联网取远端，默认不联网 |
| `/api/sync/pull` | POST | 执行 `git pull --ff-only`（唯一会改写工作区的同步接口；脏工作区/分叉时返回 `ok:false` + 原因） |
| `/api/mermaid/render` | POST | mermaid 批量渲染（图片导出用） |
| `/api/perf-log` | POST | 前端性能埋点（点击耗时等） |

> 提交查看原理：后端在文件所属 git 仓库执行 `git log` / `git show` / `git cat-file`；
> 前端按 diff hunks 把**新增 / 删除 / 上下文**三种行渲染在代码视图上（删除行用旧行号
> 内联在原位置）。删除行**不支持** Ctrl+点击跳转——它的行号属于旧版本，与新版本全文
> 错位，跳了必错。
