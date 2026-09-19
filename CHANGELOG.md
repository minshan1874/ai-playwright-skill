# 更新日志

本文件记录所有值得注意的改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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

[未发布]: https://github.com/minshan1874/ai-playwright-skill/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/minshan1874/ai-playwright-skill/releases/tag/v1.0.0
