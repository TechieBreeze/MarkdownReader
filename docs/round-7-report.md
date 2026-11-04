# Round 7 · 验证报告（跳转对齐 / 右键复制 / 回归）

- 生成时间：2026-11-04（round 7，verifier）
- 任务根：`C:/Users/1/Desktop/work/code/agent-workspace/20261104-markdown-reader-plugin`
- 本轮验证范围：oracle 跳转对齐、右键复制菜单、回归 harness、原版功能点缺失审计
- 相关文档：[`feature-gap-audit.md`](./feature-gap-audit.md)（原版最近提交逐条对比）
- 最终确认：**最新 :8799（host-defs v2）下 parity PASS（46/46）**，7 个 harness 全绿（见 §3）。
- 纪律：未起浏览器；全部结论来自 Node harness + 两个 HTTP 服务；未改 `plugin/**` 产品源码（仅按 lead 要求 `node plugin/build.mjs` 重建生成产物 `plugin/client.js`）。

## 1. 环境

| 用途 | 地址 / 命令 | 状态 |
|------|-------------|------|
| 原版 oracle（Python） | `http://127.0.0.1:8790`（`work/oracle/server.py`，根：`code` + `20260917-微服务`） | UP |
| 插件 Host 独立服务（最新 `plugin/lib/*`，host-defs v2 + javasym） | `http://127.0.0.1:8799`（lead 已于 17:06 用最新代码重启） | UP，本轮权威对照 |
| 线上 DSH 插件 | `http://127.0.0.1:57377/markdown-reader` | UP，但仍是**安装时旧 Host**（`/api/def` 返回 `无效的符号名`，见 §4） |
| 构建 | `cd plugin && node build.mjs && node --check client.js` | 通过：`client.js written (322.2 KB) from 16 parts` |
| 样本数据 | 两组真实工作区根：`C:/Users/1/Desktop/work/code`、`C:/Users/1/Desktop/work/tasks/20260917-微服务` | — |

## 2. 本轮交付物

新增 / 修改（全部在 `work/**` 与 `docs/**`，未改产品源码）：

| 文件 | 说明 |
|------|------|
| `work/work-def-parity.mjs` | Java + web 点击样本对齐工具；`--json` / `--json-file` / 退出码；「一致/不一致/仅原版/仅插件/双方失败/插件未就绪/响应形状异常」分类 |
| `work/harnesses/defs-check.mjs` | **新增**：22-defs 单目标跳转（v2 请求体、hljs→kind、caret 取词、col 去 gutter、删除行/行号列不可跳、失败 toast、busy guard） |
| `work/harnesses/copy-menu-check.mjs` | **新增**：右键复制菜单 + toast + 三级剪贴板回退（fake DOM）+ 构建产物新鲜度断言 |
| `work/harnesses/panels-check.mjs` | 修 3 条与真实仓库状态绑定的 sync 断言（见 §6.1） |
| `work/harnesses/code-check.mjs` | 22-defs 旧候选面板断言 → 单目标跳转契约；新增「diff 跳转后标记仍在」断言 |
| `docs/feature-gap-audit.md` | **新增**：原版最近 6 个 feature commit（+3 个相邻 commit）逐条「已移植/部分移植/缺失」+ 双方行号证据 |
| `docs/round-7-report.md` | 本报告 |

## 3. 验证命令与结果

| # | 命令 | 结果 |
|---|------|------|
| 1 | `node work/work-def-parity.mjs`（默认 :8799） | **PASS**：53 个有效样本（Java 41 / web 12），oracle 成功 46，**一致 46 / 46（100%）**，0 仅原版、0 不一致、0 仅插件；7 个双方失败均为「原版也失败」的负样本；退出码 0 |
| 2 | `node work/harnesses/load-check.mjs` | 8/8 通过 |
| 3 | `node work/harnesses/boot-check.mjs` | 通过：factory 求值 + `apply()` 注册 2 个 slot |
| 4 | `node work/harnesses/code-check.mjs` | **177/177** 通过 |
| 5 | `node work/harnesses/html-check.mjs` | **159/159** 通过 |
| 6 | `node work/harnesses/panels-check.mjs` | **100/100** 通过（修完 3 条 sync 断言后） |
| 7 | `node work/harnesses/copy-menu-check.mjs` | **66/66** 通过 |
| 8 | `node work/harnesses/defs-check.mjs` | **63/63** 通过 |
| 9 | `cd plugin && node build.mjs && node --check client.js` | 通过（322.2 KB / 16 parts） |
| 10 | `node work/work-def-parity.mjs --json` / `--json-file <p>` | stdout 为**纯 JSON**（stderr 仅诊断）；`--json-file` 由 Node 直接写 UTF-8，规避 PowerShell `>` 的 UTF-16/BOM（详见 §9） |

## 4. oracle 对齐（work-def-parity.mjs）

样本覆盖（≥40 Java + 12 web，全部是真实文件真实行）：

- **用户报的场景**：`gits/.../UserCookieServiceImpl.java` 的局部变量 `cookiePO`（L26/L27）、`queryWrapper`（L22/L23）、`dict`（L39）、`dto`（L40/L42）全部与 oracle 一致。
- variable / constant / type / method / 跨文件 / 继承（`BasePO` 字段经 Lombok）/ Lombok getter+setter / 链式 `BrandEnum.X.getContent()` / 枚举常量（`BrandEnum`、`ConstantUser`、`EmployeeUrlEnum`）。
- 负样本 7 个（外部框架类型/方法、泛型链 `List.get(0).getId()`、缺失的 Vue 组件标签），oracle 也失败，插件同步失败（不虚构跳转）。
- web 样本：`gits/ckdocs/demo/pvh-ops-prototype/assets/app.js`（函数/const 声明与调用）+ `gits/employee/employee-detail.vue`（`methods.init/getDetail/getMobile` 的声明与 `this.xxx()` 调用），10 个 oracle 成功样本全部一致。

**样本数量说明**：工具当前样本表共 **53 个**（Java 41 + web 12），全部有效（文件+行+token 实时校验）；oracle 成功 46 个，另 7 个为「oracle 也失败」的负样本（外部框架类型/方法、泛型链、缺失 Vue 组件标签）。

**Host 现状**：v2 契约已收敛为干净响应 `{ok:true,file,line,kind,defName,impl}`（过渡期 `candidates` 字段已去掉；错误为 `400 {ok:false,error}`）。本轮曾在旧 `:8799` 进程上复现过 `Cannot access 'candidateAbs' before initialization`（2 个 type+impl 样本），**重启 host-test 后消除**——这是进程陈旧而非代码回归。工具判定逻辑已按「响应含 `file`+数字 `line` 即 v2 成功」实现，不再依赖 `candidates` 兼容分支。
- 线上 DSH `57377/markdown-reader/api/def` 仍是**安装时 v1 Host**：`400 {"ok":false,"error":"无效的符号名"}`。需要在插件管理器里 bundle 禁用→启用（或重启 DSH）后，才能在实际界面里验证 Ctrl+点击。

**工具输出说明**：`--json` 只输出纯 JSON 到 stdout（失败时退出码 2，JSON 仍在 stdout）；`--json-file <路径>` 由 Node 直接落 UTF-8 文件，避免 Windows PowerShell `>` 重定向写 UTF-16/BOM 导致 `JSON.parse` 读到前缀乱码。`pluginContractState()` 已按 v2 契约判定：**响应含 `file`+数字 `line` 即视为 v2 成功**（`candidates` 仅作过渡字段忽略）；只有「无 file/line + 旧 v1 形状（`symbol`+`candidates`）」才判 v1；「HTTP 200 但既无目标也无 error」单独记为 `bad-shape`。

## 5. 两个用户场景（验收标准 2）

1. **codereview 文档 §三 表格前两行 `.java` 文件名渲染成代码链接**
   - Host 侧已验证（最新 8799）：`GET /api/exists?path=<文件名>&from=<文档>` → 文档 §三表格 4 个文件名（`UserCookieMapper.java`、`UserCookieServiceImpl.java`、`UserCookieMapper.xml`、`SyncEzrMapper.xml`）**4/4 解析成功**，且都落在 `20260917-微服务/gits/...` 正确路径（`from` 参数生效，优先当前文档所在项目）。
   - 客户端把 `code` 元素转链接的行为：`plugin/src-client/10-markdown.js` 的 linkify 分支；**是否在页面上显示为可点击链接需用户视觉确认**（无浏览器控制，未做渲染断言）。
2. **代码弹窗里 Ctrl+点击局部变量直接定位声明行**
   - Host 侧已验证（最新 8799 `/api/def` v2）：`cookiePO→UserCookieServiceImpl.java:26`、`queryWrapper→:22`、`dict→:39`、`dto→:40`，全部命中声明行。
   - 客户端链路已验证（defs-check 63/63）：hljs class → kind、caret 取词、1-based col（去掉 2 字符 gutter）、单次 v2 请求、同文件/跨文件导航回调、失败 toast；**弹窗内实际点击效果需用户视觉确认**。

## 6. 本轮回归风险清单（逐条结论）

| # | 风险点 | 结论 | 证据 |
|---|--------|------|------|
| 1 | **JS/TS/Vue 跳转** | **无回归** | parity web 10/10 一致（`.js` 5 + `.vue` 5）；defs-check 断言 `canJumpInFile`、web hljs 类映射、无 span 时 caret → `variable`；负样本（缺失组件标签）双方一致失败。注：`20260917-微服务` 下无真实 `.ts` 源文件（vendor/bower 除外），故 web 样本为 `.js`+`.vue`，`.ts/.tsx` 走同一 `canJumpInFile`/`defKindFromClass` 分支，属样本覆盖缺口而非代码缺口 |
| 2 | **删除行不可跳** | **无回归** | `22-defs.js:178` 删除行守卫；code-check `deleted row is not highlighted`/`ctrl+click skips deleted diff rows`；defs-check `deleted diff row -> null`、Ctrl+点击删除行 **0 次** `/api/def`；`15-git.js:425` 删除行 hover 禁用 |
| 3 | **diff 视图跳转后不丢标记** | **无回归** | code-check 新增 `diff add/del markers kept after jump`；tab 视图 `viewKey`（`20-code.js:910`）含 diff/base + branch/commit；`22-defs.js:219-235` 请求带当前渲染 `text/branch/commit`；`24-modal.js:168-214` `navigateInPlace` 携带 `nextView` 且返回栈快照含 view |
| 4 | **非 git 文件不显示 git bar** | **无回归** | code-check `non-git file keeps git bar hidden`（`/api/git/meta` 返回 `not git` 时 `view.git === false`，不抛错）；同样断言存在于 fake `/api/git/*` 全链路测试 |
| 5 | **代码弹窗返回栈** | **无回归（视觉待确认）** | `24-modal.js:44-47/73/178-214`：快照记录 `scrollTop` 与 git view，`goBack()` 弹栈并用 `setRestoreScroll` 恢复；code-check `[5]` 断言 `← 返回` 按钮仅在 `navFrom/onBack` 时出现且回调生效；defs-check 断言弹窗走同一 `setupDefinitionClick` |
| 6 | **panels-check 3 条 sync 断言** | **断言过时，非产品回归** | 见 §6.1 |

### 6.1 panels-check 3 条失败判定与修法

- 失败项：`real panel reason rendered`、`real panel how-to rendered`、`real check keeps not-configured state`。
- 判定：**断言写死了「未配置远程 + 干净工作区」**（旧断言假定插件仓库无 origin）。当前真实仓库已配置 SSH origin（`git@github.com:TechieBreeze/MarkdownReader.git`）且有未提交改动，`/api/sync/status` 返回 `configured:true, fetched:false, behind:0, dirty:true`；组件实际渲染「仓库/当前分支/同步分支/远程/本地改动」正确 → **产品行为正确，断言过时**。
- 修法（`work/harnesses/panels-check.mjs`）：先实时 `GET /api/sync/status` 读真实状态，再断言组件是否镜像该状态：`configured` 字段形状/仓库名/分支是否渲染；`configured=false` 才断 `未配置`/`syncRepo` how-to；`configured=true` 断「不出现未配置文案」；检查更新后断「configured 状态保持 + 面板仍可用」；拉取按钮断 `disabled===true`（未 fetch 到更新时）。对「未配置 / 有更新 / 脏树拒绝」三种状态另有 fake `/api/sync/*` 用例不变，仍全绿（100/100）。

## 7. 未通过项 / 已知限制

1. **常驻 host-test 进程会滞后于 Host 源码**：Host 改动后必须重启（本轮旧 8799 进程曾报 `candidateAbs`；重启后 46/46）。已验证最新 8799 全绿。
2. **线上 DSH 仍是旧 Host**（`/api/def` 返回 `无效的符号名`）：ui 内 Ctrl+点击/链接识别在 bundle 重载前无法验证；需 lead 在插件管理器禁用→启用 bundle 或重启 DSH。
3. **无浏览器控制**：所有客户端结论来自 fake-DOM/fake-React harness，**不覆盖真实渲染/视觉**（见 §8）。
4. **web 无 `.ts` 样本**：`20260917-微服务` 内非 vendor 的 `.ts` 源文件为 0；已按真实可得文件用 `.js/.vue` 覆盖同一代码路径。
5. **样本与仓库状态绑定**：parity 样本按「文件+行+token」实时校验，文件被改动会报 `INVALID` 并退出码 1（本轮 53/53 有效）。

## 8. 待用户视觉确认项

- codereview 文档 §三表格的 `.java` 文件名是否显示为可点击代码链接（点击是否打开代码弹窗）。
- 代码弹窗内 Ctrl+点击 `cookiePO` / `queryWrapper` / `dict` / `dto` 是否直接定位到声明行（而不是候选列表）。
- 高亮颜色：枚举常量、方法签名参数类型、泛型/`List<X>`/import 类名是否呈现「类型色」（与原版 VSCode Dark+ 观感）。
- 右键 `.mdr-code-path` / `.mdr-tr` / `.mdr-tab` 弹出「复制路径 / 复制文件名」菜单、点击后 toast 与剪贴板内容。
- 弹窗「← 返回」行为与 diff 视图跳转后的标记/高亮观感。

## 9. 复现 / 给 lead 的落地建议

```bash
# 1) Host 源码改动后重启常驻 host-test（本轮最新 8799 已验证）
node work/host-test.mjs "C:/Users/1/Desktop/work/code" "C:/Users/1/Desktop/work/tasks/20260917-微服务"

# 2) 插件 bundle 重载（让 57377 用上新 Host）后，再在页面里验证 UI
# 3) 重新构建 client.js（本轮已构建，最终以 lead 构建为准）
cd plugin && node build.mjs && node --check client.js

# 4) 验证
node work/work-def-parity.mjs
node work/harnesses/{load,boot,code,html,panels,copy-menu,defs}-check.mjs
```

**注意**：PowerShell 里不要用 `node ... --json > out.json`（UTF-16/BOM 会让 `JSON.parse` 报错），用 `--json-file out.json` 或 `| Out-File -Encoding utf8`。

## 10. Lead 收尾补充（覆盖 §1/§4 里「线上 57377 仍是旧 Host」的 caveat）

verifier 交报告后，lead 做了收尾，线上状态已变化，以此节为准：

1. **线上 Host 已热重载**：`plugin_manager set_bundle` 把 `@local/markdown-reader` 禁用→启用（`application: applied`），
   `http://127.0.0.1:57377/markdown-reader/api/def` 现在是 v2 ——
   `{"path":…UserCookieServiceImpl.java,"line":32,"col":20,"name":"cookiePO","kind":"variable"}` → `200 {ok:true,file:…:26}`；
   `/api/exists?from=<codereview 文档>` 对 `UserCookieMapper.java` / `UserCookieServiceImpl.java` 均返回正确 `20260917-微服务/gits/...` 路径。
2. **线上验收脚本**：新增 `work/live-acceptance.mjs`，直接打线上 Host（不是 host-test），结果 **PASS**：
   - 该 codereview 文档里所有可解析的裸反引号路径 **9/9** 命中（`ck_test2.0` 是分支名、不是文件，按预期不解析）；
   - `UserCookieServiceImpl.java` 上 13 个点击（`token`/`queryWrapper`/`cookiePO`/`dict`/`dto` 的声明与使用、
     类型 `UserCookieServiceImpl`/`UserCookiePO`/`UserCookieMapper`/`UserCookieService`）与原版 oracle
     **12/12 成功目标 file+line 完全一致**，另 1 个（`baseMapper.renewExpirationTime`）原版同样报 `未找到定义`。
3. **最终构建由 lead 完成**：`node build.mjs` → `client.js` 322.2 KB / 16 parts，`node --check` 通过；
   7 个 harness 复跑全绿（load 8/8、boot、code 177/177、html 159/159、panels 100/100、copy-menu 66/66、defs 63/63），
   `node work/work-def-parity.mjs` 仍为 PASS（46/46）。
4. **仓库清理**：`work/tmp-defs/`、`work/tmp-lead*` 已删；有价值的一次性脚本移入 `work/`
   （`defs-oracle-sweep.mjs`、`defs-feature-checks.mjs`）；`work/oracle/` 改为 `node work/oracle-setup.mjs`
   从 `input/reference` 重建并加入 `.gitignore`（仓库里不再带第二份 vendor_py）。
5. **仍需用户目测**的部分不变（见 §8）：页面渲染结果、真实鼠标/悬停/滚动行为 agent 侧无法断言。

