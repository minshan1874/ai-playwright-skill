# 更新日志

本文件记录所有值得注意的改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.8.0] - 2026-09-23

这一版来自一次真实执行中暴露的问题：Excel 解析崩在库内部、多步骤登录写不出来、
重跑时旧 trace 污染新结果、`--grep` 把执行范围说成覆盖缺口。

### 新增

- **多步骤登录支持**。此前生成器只会「账号、密码同时填写后提交」，遇到
  「账号 → 继续 → 密码 → 登录」这类两步表单直接失败，而报错只说不认识某个选择器。

  现在：`auth.continueSelector` 表达中间那一次点击，`auth.steps` 是完全自定义的
  步骤列表（与探索步骤文件同一套动作与定位方式），并且：

  - 每一步都渲染成 `setup.step()`，登录卡在哪一步在 HTML 报告里直接可见；
  - 密码框迟迟不出现时，报错会提示「如果是两步流程，请配置 `auth.continueSelector`」——
    这正是把两步表单当单页表单配的典型症状；
  - 登录成功的判据推荐用**页面元素**（`auth.successSelector`：账户菜单、模型配置、
    Upgrade 按钮），而不是会经过多次跳转的 URL。

- **只复用登录态不再需要登录配置**。`{"auth": {"enabled": false, "storageState":
  "auth/site.json"}}` 现在是完整合法的配置：不需要 `loginUrl`，不需要用户名密码占位符。
  `auth.storageState` 的相对路径按**配置文件所在目录**解析，而不是当前工作目录。
  另外新增 `auth.forceLogin`，用于忽略已有登录态强制重新登录。

- **执行批次隔离**：每次执行写入独立的 `<runDir>/attempts/attempt-<时间戳>/`，
  自带 `test-results/`、`results.json`、`playwright-report/` 与 `attempt.json`。
  `results-summary.json` 与 `report.md` 只反映最近一次执行，历史批次按
  `attempts.keep`（默认 10）保留。

- **异步任务的双超时**：`asyncTasks.submitTimeout`（默认 30s）约束提交动作，
  `asyncTasks.completionTimeout`（默认 180s）约束排队与生成。配套的
  `waitForAsyncTask()` 会把状态变化（`Queued → 生成中 → 已完成`）记进**步骤时间线**，
  失败报告里因此能区分「提交失败」和「生成较慢」。它只给当前用例放宽超时，
  不用为了异步任务把全局 `timeout` 调大。

- **`.xlsx` 的内置备用读取器**（零依赖）：自己解析 ZIP 中央目录 + 命名空间无关的
  XML 扫描，支持前缀命名空间、Strict OOXML、稀疏单元格、内联字符串、公式结果、
  合并单元格与 Zip64。

- **定位器的动态文本处理**：`outline.md` 标出「⚠️ 动态文本 / ✅ 稳定文本」，
  并为动态文案给出 `getByRole('button', { name: /积分\s+\d+/ })` 这类正则候选
  （排在字面量定位器之前），以及「备选定位器」列与「登录成功信号候选」一节。

### 修复

- **`Cannot read properties of undefined (reading 'sheets')`**。这是 exceljs 内部
  读取 `xl/workbook.xml` 时的崩溃：它假定元素结构固定，遇到不认识的命名空间
  （第三方导出工具、Strict OOXML）就拿到 `undefined` 再取 `.sheets`。

  现在 `.xlsx` 按 exceljs → 内置读取器 → 按内容识别（HTML 表格 / 分隔符文本）依次尝试，
  并在 `warnings` 里说明实际用了哪一种。全部失败时报的是**「用例文件格式兼容问题」**，
  附带每种方式各自的失败原因和修复办法（另存为 .csv / 标准 .xlsx / 贴成 Markdown 表格），
  不再笼统地说「请修正用例文件」。内置读取器成功时会另存一份 `*.recovered.csv` 供核对。

- **`browserContext.close ENOENT`**：同目录反复重跑时，上一次残留的 trace 与截图
  会让 Playwright 的目录清理崩溃。批次隔离从根上消除这一类问题。

- **自动登录写下的登录态从未被用例加载**。生成配置时，只要存在 setup 工程，
  `storageState` 就不写进 `use` —— 于是首次运行「登录成功但用例仍在登录页」，
  第二次运行才正常。现在 `storageState` 挂在浏览器工程上，setup 工程自己不加载它
  （避免用过期的登录态被重定向走）。

- **`--grep` 之后的报告把执行范围说成覆盖缺口**。现在区分两个口径：
  `未自动化`（从未写过代码）与 `本次未执行`（有代码，被筛选排除）。
  报告分两节列出，结论显示 `⚠️ 筛选执行（未跑全量）`，判定依据是静态扫描
  `specs/` 里的 `caseId` 注解与 `[用例ID]` 标题。

- **文档承诺了 `{"action": "screenshot"}`，脚本却不认**。现在 `screenshot` 是
  正式动作（`hover`、`uncheck` 一并补上），动作名写错时报错会列出全部受支持的动作。

- **截图失败会掩盖真正的失败原因**。截图本身抛错时，原始错误被替换成了一个
  无关的 TypeError；现在截图失败只记录，原始错误始终保留。

- **`/` 未转义会生成无法编译的正则定位器**。形如 `3/10` 的文案生成的
  `name: /\d+/\d+/` 会提前终止正则字面量；现在正则定界符一并转义。

### 文档

- SKILL.md 新增「登录：先确认用哪一种方式」（三种方式的选型表 + **Google/OAuth
  不要自动登录**，改用 `codegen` 导出登录态 + 登录态过期的症状），
  以及异步任务等待、批次隔离、`--grep` 口径的说明。
- `references/workflow.md` 重写登录一节（三种方式、多步骤示例、`auth.steps`、
  成功判据），新增「重跑与执行批次」与异步任务写法。
- `references/troubleshooting.md` 新增：Excel 格式兼容问题、批次残留 ENOENT、
  步骤时间线缺失、异步任务停在 `Queued` 的分流表。
- `references/locator-guide.md` 新增「动态文本」与「备选定位器」两节。
- `references/report-template.md` 更新章节表、结论判定规则与「不要把本次未执行
  说成覆盖缺口」的汇报要求。

### 文档（1.7.0 之后的既有改动）

- **补齐正面定位，不再让「不做什么」单独出现**。原文只有一节排除项
  （单元测试、接口测试、性能压测……），读者看完只记得「它不做什么」。
  新增「它解决什么问题」（用表格列出它替你省掉哪六道工序）与
  「和让 AI 直接写 Playwright 脚本有什么不同」（计划门禁、覆盖率口径、
  环境故障与产品缺陷的区分）。
  「不做什么」保留，但改写为「刻意划的边界」并说明理由。

### 文档

- **README 第 1 步简化为「直接让 AI 装」**。原来要求用户自己开终端敲
  `git clone` + `./install.sh`，对不习惯终端的测试工程师是个门槛；
  而他们本来就在和 AI 对话。

  现在第 1 步的主体是一段**可以直接发给 AI 的话**：让它克隆到
  `~/ai-playwright-skill`、执行 `./install.sh --all`、回报路径与版本。
  安装 skill 本身不需要 skill 已安装 —— 那只是一个普通的命令行任务。

  终端方式保留为备选（AI 没有网络权限或用户想自己控制安装位置时用）。

### 修复

- **CHANGELOG 的历史版本链接全部 404**。链接写的是 `compare/v1.6.0...v1.7.0`
  这类形式，但本仓库只给当前版本打了 tag（`v1.7.0`），历史 tag 并不存在 ——
  点进去就是 404，而且只有在读者点击时才暴露。

  改为：`v1.7.0` 指向 Release 页，`1.0.0`–`1.6.0` 指向对应提交区间。
  并加测试校验：从 CHANGELOG 里抽出所有 `compare/vX...vY` 与 `releases/tag/vX`
  引用，断言每个 tag 都真实存在（tag 与提交都在本地，不需要联网）。

### 文档

- **README 重写为面向软件测试工程师的傻瓜式指南**（393 行 → 296 行）。
  目标读者是不会写代码、不熟悉终端的测试人员，因此：

  - 开篇直接是「三步上手」：安装（复制粘贴两行）→ 把网址和用例丢给 AI →
    确认计划等报告。第 2 步给了**可以整段复制的提问模板**。
  - 明确写出**执行时会弹出浏览器窗口、能看到全过程**，以及那个「等你确认才继续」
    的暂停点是故意的 —— 这两件事决定了测试人员敢不敢用。
  - 「你要准备什么」只讲用例表怎么填，并直接给出模板下载链接。
  - 新增「我该怎么问 AI」：需要登录、没有用例表、只跑一部分三种常见场景的提问范例。
  - 常见问题改写为测试人员真正会问的（要不要自己装 Playwright、会不会改我的项目、
    验证码能不能测、失败的是产品缺陷还是用例写错）。
  - 开发者内容（仓库结构、设计约束、如何加脚本）不再占据 README，改为指向
    `CONTRIBUTING.md`。

## [1.7.0] - 2026-09-19

### 新增

- **阶段 0 强制探测浏览器能否真正启动**：`bootstrap.mjs --check --probe-launch`。
  沙箱放不放行浏览器只有真启动才知道，光看配置看不出来。探测会分别尝试有头与无头，
  返回 `launch.canShowWindow` 与 `launch.mustAskUser`。

  这样「弹不出窗口」在**计划阶段**就暴露，用户可以一次性把决定做完，
  而不是等到执行中途 agent 临时发挥。

- **「弹不出窗口时的固定流程」写进 SKILL.md**，按 `failureKind` 分流且无歧义：

  | 情况 | 必须做什么 |
  | --- | --- |
  | `sandbox-mach` | **不要改成 `--headless`**（有头无头共用 Mach IPC，改了一样失败）→ **申请提权** → 以**有头**重新探测 → 仍失败则**停下来让用户选**（自己到终端跑 / 接受无头） |
  | `no-display` | 无头确实可用，但**仍须先告知用户**再降级 |

  目标是让 agent **不需要额外说明就照做** —— 此前用户不得不每次叮嘱
  「申请更宽权限后重试有头，而不是改成无头」。

- **计划骨架新增必填的「浏览器可见性」项**，要求写明能否弹窗口、
  是否已提权重试、用户选择了哪种处理方式。

### 说明

`probeLaunch` 需要真实浏览器，无法单元测试；但「哪种失败允许换无头」这一判断
由 `browser-errors.mjs` 纯函数给出，测试会校验文档与分类器在这一点上不漂移。

## [1.6.0] - 2026-09-19

### 修复

- **浏览器启动失败的处置建议是错的，会导致白跑一轮**。原文档无差别地写
  「加 `--headless` 重试」。但在 macOS 沙箱里，Chromium 会因为
  `bootstrap_check_in ... Permission denied (1100)` 起不来 —— 而
  `MachPortRendezvousServer` 是**有头无头都要用**的多进程 IPC，
  **换成无头一样会失败**。

  真实后果：agent 先按默认有头启动 → 失败 → 按文档改无头 → 又失败 →
  最后申请提权才跑通，白跑一轮，还要向用户解释为什么没弹窗口。

  现在 `explore.mjs` / `run.mjs` 会区分两类失败，并在 JSON 里返回
  `failureKind` 与 `canRetryHeadless`：

  | `failureKind` | 原因 | `canRetryHeadless` |
  | --- | --- | --- |
  | `sandbox-mach` | 沙箱拦截 Mach 端口（有头无头都失败） | `false` |
  | `no-display` | 没有显示服务（无头可用） | `true` |
  | `missing-browser` | 浏览器没下载 | `false` |
  | `unknown` | 未识别 | `false` |

  文档同步改为按 `failureKind` 分流，并写明 `sandbox-mach` 应按「申请提权 / 到普通终端跑」
  处理，而**不是**换无头。

- **降级为无头必须事先告知用户**。有头是本 skill 的承诺（测试人员能看到执行过程），
  改成无头等于承诺落空。文档现在要求：先说明原因并征得同意，再降级，并在报告中注明。

- **报告不再只报一个布尔值**。`浏览器可见性` 一行直接写出后果：
  「有头 —— 执行时弹出浏览器窗口，过程可见」或
  「无头 —— 测试人员看不到执行过程，只能凭截图与 trace 回放」。

### 说明

本条来自一次真实使用反馈：agent 在 Codex 沙箱里跑，有头启动失败后按文档降级为无头，
并主动向用户解释了原因。它的处置是克制的，问题出在文档给的建议本身。

## [1.5.0] - 2026-09-19

### 修复

- **把「默认有头」写得更明确，防止被淡化**。上一版的措辞是「默认是有头模式」，
  仍然可以被读成「取决于配置」。现在明确写成「**开箱即用就是有头模式 —— 会弹出浏览器
  窗口，测试人员能看到用例逐步执行的全过程**，不需要任何配置」，并加测试锁定该表述。

  起因：有 agent 在真实使用中把这段改写成了「默认由配置决定」，还从参数表里拿掉了
  `--headless`（但下文又写着「加 `--headless` 重试」，自相矛盾）。这会直接架空
  「让测试人员看到执行过程」这个产品承诺。

- **`$SKILL` 不再硬编码 DSH 路径**。文档里写死 `SKILL=~/.dsh/skills/playwright-e2e`，
  在 Codex 或项目级安装下是错的。改为占位符并说明实际路径以运行时给出的基础目录为准。

- **`install.sh --status` 改为比对整棵树的内容哈希**，而不是只比对 `config.mjs`。
  此前若有人只改了 `SKILL.md`（脚本不变），它会报 ✅ —— 正是「看起来是新版、
  实际行为不同」的那种漂移。现在任何内容差异都会被发现。

### 新增

- **铁律增加第 4 条：不要直接修改安装副本里的文件**。安装目录是发布产物，
  在 `~/.dsh/skills/` 或 `~/.codex/skills/` 里改 `SKILL.md` 会让副本与源码分叉、
  版本号失真，下次 `--update` 还会把改动全部覆盖。要改就改仓库源码。

- **`--skip-plan-check` 明确限定为维护者专用**，普通测试流程不得使用 ——
  它绕过的是整个流程唯一的用户确认点。

- **只有网址、没有结构化用例时**，必须先问用户是否允许根据探索结果生成临时用例；
  不得把临时探索包装成「已覆盖的正式用例」，正式覆盖率只能以 `cases.json` 为准。

- **重跑必须复用同一个已确认的 `plan.md`**，不得借重跑绕过确认门禁。

- **依赖安装失败 / 浏览器下载失败 / 权限拒绝属于环境问题**，不得写成测试失败。

### 说明

以上新增条目来自一个 agent 真实使用本 skill 时对 `SKILL.md` 的改动 ——
其中「路径不应硬编码」「`--skip-plan-check` 应受限」等确实指出了原文的不足，予以采纳；
但它对「默认有头」的改写是退步，已按原意收紧并加测试固化。

## [1.4.0] - 2026-09-19

### 新增

- **`install.sh --update`**：就地覆盖更新**所有已发现的副本**，不需要知道它们在哪，
  也不用先手动删。按 `SKILL.md` 的 `name` 扫描 DSH / Codex / 项目级三处技能根目录，
  因此**装错目录名的副本**（如 `~/.codex/skills/skill/`）也能一并刷新。
  替换用「暂存目录 + 交换」，中途失败自动回滚，不会留下半拷贝状态。

  动机：Codex 自带的 skill 安装器遇到已存在的目标目录会直接报错退出
  （`Destination already exists`），所以「更新」只能靠「先删再装」——
  而它的默认命名取自路径 basename，正是 `skills/skill/` 这种错名的来源。

### 修复

- **`install.sh` / `uninstall.sh` 中变量后紧跟非 ASCII 字符时未加花括号**。
  例如 `echo "$dir（中文）"` 会让 bash 把多字节字符的首字节算进变量名，
  在 `set -u` 下直接以 `unbound variable` 中断脚本 —— 而且只在走到那一行时才触发。
  共 6 处，其中 `uninstall.sh --purge` 相关 4 处此前从未被执行过，属于潜伏缺陷。
  已全部改为 `${VAR}` 形式，并加测试锁定这个模式。

## [1.3.0] - 2026-09-19

### 修复

- **演示的浏览器可见性与真实运行不一致**。`demo.mjs` 之前无条件无头，而真实运行
  默认有头。新用户按 README 最先跑的就是 `npm run demo`，结果**首次体验恰好看不到
  窗口**，和之后真实使用时看到的行为对不上。现在演示遵循同一默认：普通机器弹窗口，
  检测到 `CI` 环境变量（GitHub Actions、GitLab、CircleCI 等都会设置）则无头。
  `--headed` / `--headless` 仍可显式覆盖。

  发现方式：从 GitHub 全新克隆、在隔离环境里模拟新用户安装并运行，
  对比两次运行的 `headless` 取值时暴露。

## [1.2.0] - 2026-09-19

### 新增

- **`install.sh --codex`**：安装到 `~/.codex/skills/playwright-e2e/`。此前脚本只认
  DSH 路径，在 Codex 里用的人只能手工拷贝 —— 而这正是「版本混杂」的根源。
  `--all` 可同时装到 DSH 和 Codex。
- **`install.sh --status`**：检查所有技能根目录下本 skill 的副本版本，
  并标出脚本与源码不一致的副本。它按 SKILL.md frontmatter 的 `name` 扫描，
  因此**装错目录名**（如 `skills/skill/`）的副本也能被找出来。
  同一根目录下存在多个副本时会告警 —— 那种情况下加载哪一份是不确定的。

### 修复

- **`SKILL.md` 的 `metadata.version` 没有跟着 `package.json` 一起升**。
  1.1.0 的代码配着 1.0.0 的版本号，让「这个副本是新是旧」无法从版本号判断。
  已加测试锁定两者一致。
- **手工拷贝会得到「看起来是新的、实际是旧的」副本**：只改了 `SKILL.md`
  的版本号却留着旧脚本。现在 `--status` 会同时比对脚本内容与版本号并明确告警。

### 说明

如果你曾手工把 skill 拷进 Codex，请用 `./install.sh --force --codex` 重装，
并删掉旧的错误副本 —— 用 `./install.sh --status` 可以列出所有副本位置。

## [1.1.0] - 2026-09-19

### ⚠️ 行为变更

- **浏览器改为默认有头（弹出窗口）**。以前默认无头，跑测试时什么都看不见；
  现在 `explore.mjs` 和 `run.mjs` 会真的弹出浏览器窗口，用户能看到全过程。
  理由是这个工具面向非技术用户，「看得见」是信任的基础。
- **在 CI、服务器、SSH 远程等无显示环境上，必须加 `--headless`**，否则浏览器
  启动会失败（`cannot open display`）。这是本次唯一可能弄坏既有用法的改动。
  内置演示已自行处理，不受影响。

### 新增

- `--headless` 参数：强制无头。优先级高于 `--headed` 和配置文件，
  便于 CI 与无显示环境稳定覆盖。
- `--slow-mo <毫秒>` 参数：放慢每个操作，方便肉眼跟随。以前只能改配置文件。
- `SKILL.md` 新增「浏览器可见性」一节，并要求 AI 在计划阶段主动告知用户
  会弹窗口、可以放慢、无显示环境要用 `--headless`。
  此前 `--headed` 在主流程文档里完全没有出现，AI 无从主动告知。

### 修复

- 示例配置 `assets/e2e.config.example.json` 改为由 `exampleConfigText()`
  生成，并加测试锁定两者一致，避免文档与实际默认值漂移。

## [1.0.1] - 2026-09-19

### 修复

- **`demo.mjs` 在干净机器上必然失败**：它以不带 `--install-browsers` 的方式调用
  `bootstrap.mjs`，而 bootstrap 按设计会先征求同意再下载浏览器，于是演示直接以
  「环境未就绪」退出。本地开发时 Chromium 已缓存所以看不出来，任何全新环境
  （包括干净 CI runner）都会中招。演示由人工显式触发，这个动作本身就是同意，
  现在会主动安装缺失的浏览器。
- **CI 浏览器缓存路径不确定**：改用 `PLAYWRIGHT_BROWSERS_PATH` 固定到工作区内，
  避免平台默认路径不一致，并在 `actions/cache` 之前先创建目录
  （该 action 在路径不存在时会报错）。

### 新增

- 回归测试：`demo.mjs` 必须以 `--install-browsers` 调用 bootstrap；
  CI 必须固定浏览器缓存路径。

> 1.0.0 对首次使用 Playwright 的环境不可用，请使用 1.0.1 或更高版本。

## [1.0.0] - 2026-09-19

首个可用版本。

### 新增

- **四阶段工作流**：环境自检 → 解析用例并生成测试计划 → **等待用户确认** → 探索页面并固化用例 → 执行 → 输出报告
- **计划门禁**：`plan.md` 的状态行由 `confirm-plan.mjs` 写入，`run.mjs` 执行前机械校验。
  未确认的计划会被直接拒绝执行 —— 不依赖 AI 自觉遵守指令
- **用例解析**：支持 `.xlsx`（含合并单元格、多工作表、标题横幅）、`.csv`（自动识别分隔符、
  RFC 4180 引号转义、UTF-8 BOM）和 Markdown 表格；列名容错（中英文别名、
  忽略大小写与全角标点）
- **页面探索**：全页截图、`ariaSnapshot` 语义树、可操作元素与断言目标的候选定位器
  （按稳定性排序）、控制台错误与失败请求
- **环境自动安装**：`bootstrap.mjs` 自检 Node 版本、安装 `@playwright/test` 与 `exceljs`、
  探测浏览器缓存；支持 `--check` 只读模式
- **测试报告**：Markdown 报告（结论 / 用例明细 / 失败详情 / 未自动化清单 / 附件索引）
  \+ Playwright HTML 报告 + 归一化 JSON 结果
- **登录态复用**：自动生成 Playwright setup 工程登录一次并保存 `storageState`，
  凭据通过环境变量注入，不落盘
- **多浏览器**：默认 Chromium，可配置 Firefox / WebKit；下载前会先告知体积
- **离线演示**：`demo.mjs` 用内置演示站跑通全链路，结果包含 1 条故意失败和
  1 条未自动化，用于验证报告的两种结果呈现
- **一键安装**：`install.sh` 支持全局 / 项目级 / 软链接三种安装方式，
  `uninstall.sh --purge` 可完整清理
- **219 个单元测试**，零依赖（`node:test`），含 skill 清单校验、仓库卫生检查与 CLI 契约测试

### 设计决策

- **依赖装在独立 home**：脚本用 `createRequire` 从运行目录显式解析依赖，
  因此 skill 目录可以随时重装而不影响已装好的环境
- **钉死 Playwright 1.63.0**：与常见浏览器缓存版本对齐，避免首次使用就下载数百 MB。
  可用 `PLAYWRIGHT_VERSION` 覆盖
- **npm 缓存重定向**到 `<home>/.npm-cache`，绕开宿主机 `~/.npm` 的权限与沙箱问题
- **报告渲染是纯函数**：`renderReport()` 无副作用，报告格式因此可被单元测试覆盖
- **拒绝接管他人目录**：`bootstrap.mjs` 在目标目录已有非本 skill 的 `package.json` 时
  拒绝安装，避免覆盖用户的工程清单

### 已知限制

- 不支持非 UTF-8 编码的 CSV（如 GBK），请另存为 CSV UTF-8
- 不支持图形验证码、短信/邮件验证码 —— 这类用例会如实标为「未自动化」
- 通过率的分母是实际执行的用例数，未自动化用例不计入，单独列出
- 不做单元测试、接口测试、性能压测、视觉回归、CI 平台对接

[1.8.0]: https://github.com/minshan1874/ai-playwright-skill/compare/375d256...HEAD
[1.7.0]: https://github.com/minshan1874/ai-playwright-skill/releases/tag/v1.7.0
[1.6.0]: https://github.com/minshan1874/ai-playwright-skill/compare/c0159f1...7a30c47
[1.5.0]: https://github.com/minshan1874/ai-playwright-skill/compare/ce232aa...c0159f1
[1.4.0]: https://github.com/minshan1874/ai-playwright-skill/compare/b21a810...ce232aa
[1.3.0]: https://github.com/minshan1874/ai-playwright-skill/compare/7cbfdd2...b21a810
[1.2.0]: https://github.com/minshan1874/ai-playwright-skill/compare/2d6d3b0...7cbfdd2
[1.1.0]: https://github.com/minshan1874/ai-playwright-skill/compare/52bd281...2d6d3b0
[1.0.1]: https://github.com/minshan1874/ai-playwright-skill/compare/5498b5b...52bd281
[1.0.0]: https://github.com/minshan1874/ai-playwright-skill/commit/5498b5b
