# 更新日志

本文件记录所有值得注意的改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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

[未发布]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/minshan1874/ai-playwright-skill/releases/tag/v1.0.0
