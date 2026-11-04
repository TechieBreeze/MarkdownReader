# Round 7 · 继续迁移原版功能点（跳转对齐 + 路径右键复制）

本轮起点：用户验收 v0.1 后提出两件事，并提示「可以看原版最近的 commit 来看功能点」。

1. **右键菜单能复制路径**（原版 `2fab45a`「文件路径右键一键复制」）。
2. **代码链接识别 + 代码弹窗里的跳转要和原版一致**：
   - 例：`20260917-微服务/docs/codereview/20261104_ck-dev-1105_th-dev-1105_vs_基线_1105版本_codereview.md`
     §三「Reference vs Feature 差异总览」表格前两行第一列 `` `UserCookieMapper.java` `` / `` `UserCookieServiceImpl.java` ``，
     原版能识别成代码链接，插件识别不到。
   - 代码弹窗里 Ctrl+点击**变量**没有结果（插件给的是「候选」列表且为空），原版直接定位到声明位置。

## 原版最近的 commit（功能点来源）

用 `git -C <原版目录> log` 看，本插件重写发生在原版最后一轮提交之后，因此这些都应视为「已存在功能」：

| commit | 能力 | 本轮是否覆盖 |
|--------|------|--------------|
| `2fab45a` | 枚举值可高亮可跳转；文件路径右键一键复制 | 右键复制本轮做；枚举常量随跳转一起做 |
| `6b8a095` | 方法签名里参数的类型能识别、能 Ctrl+点击 | 本轮做 |
| `b9d5714` | 泛型返回类型 / `List<X>` / import 类名的高亮与跳转；点击延迟 2.4s→80ms | 本轮做 |
| `4653783` | SOA（ody）跳转适配层 | 本轮**不做**（记为后续） |
| `08b68fc` / `05839fa` / `798442f` | 弹窗返回高亮行、diff 删除行不可跳、diff 视图跳转后不丢标记 | 已有等价实现，回归确认 |

## 本轮已完成（Lead）

- **裸文件名链接识别**（host `plugin/lib/api.js`）：原实现用「每个根一个写死深度」的 BFS
  （第一个根 12 层、其余 8 层），而 `20260917-微服务` 是第二个根，`gits/<svc>/src/main/java/...` 深 10 层，
  于是 `.xml`（7 层）能解析、`.java`（10 层）全部解析不到。改为**文件名索引**（懒建、90s TTL、
  深度 18、跨两个根），并新增 `from=<当前文档>` 参数让索引优先命中**文档所在项目**。
  实测同一文档 4 个裸文件名（2 个 `.java` + 2 个 `.xml`）全部命中。
- **路径右键菜单 + toast**（client `00-core.js`、`30-tree.js`、`40-tabs.js`、`25-search.js`）：
  右键路径（代码弹窗头 / 代码标签页头 / HTML 标签页头 / 图片名 / 搜索结果 / 目录树行 / 标签页）
  →「复制路径」「复制文件名」，剪贴板三级回退（clipboard → execCommand → 提示手动复制），
  并补了 `toast(message, kind)`。

## 本轮待办（本文件是接口契约）

### A. Host：Java 符号解析对齐原版（`plugin/lib/defs.js` + 新增 `plugin/lib/javasym.js` + `plugin/lib/api.js` 的 def 路由）

现状问题：现在 `/api/def` 只按「类名/方法名/字段名」在仓库里正则扫声明，返回**候选列表**；
它对**局部变量、方法参数、catch/for-each/lambda 参数、枚举常量、链式调用、跨文件接收者类型**
全都没有能力，所以点变量必然 0 候选。

**新契约（v2）** —— `POST {ROUTE}/api/def`

```jsonc
// request
{
  "path": "20260917-微服务/gits/user/src/main/java/com/pvh/user/service/impl/UserCookieServiceImpl.java",
  "line": 32,          // 1-based，点击的 token 所在行（代码文本的行号）
  "col": 20,           // 1-based，该行代码文本内的字符列
  "name": "cookiePO",  // 点击的标识符
  "kind": "variable",  // method | type | variable | constant | ""（空 = 自动 method→type→variable 依次尝试）
  "text": "…完整文件文本…", // 可选；缺省时 Host 自己从磁盘 / git 版本读取
  "branch": "ck-dev-1105",  // 可选：当前视图是分支版本时
  "commit": null            // 可选：当前视图是指定提交时
}

// success（HTTP 200）
{ "ok": true, "file": "<client 可见相对路径>", "line": 26, "kind": "variable",
  "defName": "cookiePO", "impl": null }        // impl = {file, line} | null（接口→实现）

// not found（HTTP 400，message 就是用户看到的提示）
{ "ok": false, "error": "未找到定义" }
{ "ok": false, "error": "外部/框架方法，无本地定义" }
```

语义必须对齐原版 `server.py::_resolve_java_def`（参考实现：
`input/reference/server.py` 第 930–3080 行；原版跑起来当 oracle，见下）：

- **variable**：`x.field` 先按接收者 `x` 的类型跨文件找字段；否则在本文件里找**最近的**声明
  （局部变量 / 方法参数 / catch / for-each / lambda / try-with-resources），按作用域遮蔽取最近的；
  再退到本类字段。声明行之前的引用也可以命中（Java 要求先声明，但原版取最小行号）。
- **constant**：enum 常量 / `static final` 常量，本文件优先，其次 `X.CONST` 的接收者类型文件。
- **type**：本文件类型声明；否则按 import/同包/通配符/`java.lang` 解析到文件；
  接口命中时 `impl` 给出「谁 implements 它」（仓库内扫描，找不到就是 null）。
- **method**：本文件方法；否则按接收者类型跨文件；未命中沿 `extends`/`implements` 继承链最多 3 层；
  再按 Lombok getter/setter/is 反推字段行；`a.b().c()` 这类链尾按行文本回溯链头。
- **自动探测**：`kind` 为空时按 method→type→variable 依次尝试，返回第一个成功的结果，
  全失败返回第一个 error（原版就是这么定的，错误文案更可解释）。
- **commit/branch 视图**：用 `git show <rev>:<repo 内路径>` 取那个版本的内容来解析（读不到就退化为工作区内容）。

实现自由度：允许不逐行照搬 Python（javalang AST vs 自写扫描器），但**行为结果**要与 oracle 一致；
不得引入 npm 依赖（宿主侧只用 node 内置模块），不得起 Python 子进程。

### B. Client：Ctrl+点击跳转对齐原版（`src-client/22-defs.js`、`20-code.js`、`24-modal.js`、`50-app.js`）

现状问题：客户端只传 `{path, symbol, context}`，服务端只能回候选列表，用户看到「N 个候选」而不是直接跳。

对齐原版 `index.html::ctrlTokenInfo / ctrlJump`：

- **kind 判定靠 hljs class**：`function_` → method；`hljs-type` / `class_` → type；
  `hljs-constant` → constant（Java/Kotlin）；`hljs-variable` → variable；其它（纯文本）按列取词后当 variable。
- **col 计算**：token 在**该行代码文本**内的 1-based 字符列（不含行号列宽）。
- 请求带 `text`（当前视图完整文本，含 commit 视图）、`branch` / `commit`（当前视图版本）。
- 结果：同文件 → 滚到目标行 + 常驻高亮；跨文件 → 打开（弹窗内跳转保留返回栈，标签页内跳转开新标签/复用），
  行为与原版 `openTarget` 一致；失败 → **toast**（`toast(msg,'err')`，用于本次新增）显示服务端 error 文案，
  不要静默。
- 删除行（`.mdr-git-del`）保持不可跳。

### C. 高亮对齐原版（`src-client/20-code.js`，与 B 同一 owner）

- **枚举值/常量**：enum 常量与大写常量渲染成 `hljs-constant`（原版 `2fab45a`），可点（kind=constant）。
- **方法签名里的参数类型**（原版 `6b8a095`）：`public void foo(Bar bar, List<Baz> list)` 里的 `Bar`/`List`/`Baz` 要高亮成类型。
- **泛型返回类型 / `List<X>` / import 类名**（原版 `b9d5714`）：`List<UserPO> get()`、`import com.x.Foo;` 的类名现在没有类型色。

## 环境 / 开发循环

| 用途 | 命令 / 地址 |
|------|-------------|
| 原版 oracle（只读参考，**不要改 `input/reference`**） | `cd work/oracle && python server.py --port 8790 --root "C:/Users/1/Desktop/work/code" --root "C:/Users/1/Desktop/work/tasks/20260917-微服务"` → `http://127.0.0.1:8790` |
| 插件 Host 独立测试服务（直接 import `plugin/lib/*.js`，改完立即生效） | `node work/host-test.mjs "C:/Users/1/Desktop/work/code" "C:/Users/1/Desktop/work/tasks/20260917-微服务"` → `http://127.0.0.1:8799/api/...`（无 `/markdown-reader` 前缀） |
| 线上插件（DSH GUI） | `http://127.0.0.1:57377/markdown-reader/api/...`；Host 改动要在插件管理器里 bundle 禁用→启用才热重载；Client 改动 `cd plugin && node build.mjs && node --check client.js` 后刷新页面 |
| 回归 harness | `node work/harnesses/{load,boot,code,panels,html}-check.mjs` |
| 语法 | `node --check plugin/client.js`（构建产物）；Host 用 `node -e "import('./plugin/lib/api.js')"` |

**oracle 对照注意**：两个服务的根顺序不同（oracle 先 `20260917-微服务`、插件先 `code`），比较时只看
`file`（带 vtop 前缀的相对路径）与 `line`，不要比较 `repo` 之类派生字段。

## 文件归属（避免并行冲突）

| 路径 | Owner |
|------|-------|
| `plugin/lib/javasym.js`（新）、`plugin/lib/defs.js`、`plugin/lib/api.js` | host-defs |
| `plugin/src-client/22-defs.js`、`20-code.js`、`24-modal.js`、`50-app.js` | client-defs |
| `plugin/src-client/00-core.js`、`10-markdown.js`、`25-search.js`、`30-tree.js`、`40-tabs.js`、`34-html.js` | lead |
| `work/**`（含 `work/harnesses/**`、`work/oracle/**`） | verifier |
| `docs/round-7-report.md`、`docs/feature-gap-audit.md` | verifier |
| `docs/final-report.md`、`docs/round-7-feature-parity-plan.md`、`README.md`、`plugin/README.md` | lead |
| `plugin/client.js`（构建产物） | lead 统一构建（B 可自行构建自测，最终以 lead 构建为准） |

## 验收标准

1. **oracle 对齐**：≥40 个真实点击样本（覆盖 variable/constant/type/method/跨文件/继承/Lombok/链式），
   插件 `/api/def` 与 oracle `/api/java/def` 的 `file` + `line` 一致率 ≥ 95%，且不得出现「原版能跳、插件未找到定义」。
2. **用户报的两个场景**：
   - 该 codereview 文档 §三 表格前两行第一列的 `.java` 文件名在页面里渲染成代码链接（点击打开代码弹窗）；
   - 代码弹窗里 Ctrl+点击局部变量（如 `UserCookieServiceImpl.java` 的 `cookiePO` / `queryWrapper` / `dict` / `dto`）
     直接定位到声明行。
3. 高亮：enum 常量、签名参数类型、泛型/`List<X>`/import 类名有类型色（用户视觉确认）。
4. 回归：`load-check`/`boot-check`/`code-check`/`html-check` 全绿；`panels-check` 的 3 个 sync 断言与真实仓库状态绑定，
   允许更新断言而不是改产品代码（由 verifier 判断并说明）。
5. 构建与交付：`node build.mjs` 成功、`client.js` 语法检查通过、文档更新、提交并推送 `dsh-plugin` 分支。
