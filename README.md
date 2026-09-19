# playwright-e2e

[![CI](https://github.com/minshan1874/ai-playwright-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/minshan1874/ai-playwright-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/playwright-1.63.0-2EAD33.svg)](https://playwright.dev)

> 一个 DSH Skill：把「被测网址 + 功能测试用例」变成「测试计划 → 你确认 → 自动执行 → 测试报告」。

给 AI 一个网址和一份 Excel/CSV 用例表，它会先出一份测试计划给你过目，
你确认后才真正开始跑，最后交付一份可追溯的测试报告。

**任何人都能直接用** —— 环境（Playwright + 浏览器）由 skill 自己装，不需要你敲命令。

---

## 30 秒上手

```bash
# 1. 克隆并安装到 DSH（全局，任何项目都能用）
git clone https://github.com/minshan1874/ai-playwright-skill.git
cd ai-playwright-skill
./install.sh

# 2. 新开一个 DSH 会话，然后直接说：
#    「用 playwright-e2e 测一下 https://your-app.com，用例文件是 ~/Desktop/用例.xlsx」
```

或者用斜杠命令显式调用：

```
/playwright-e2e
```

没有用例表也能用 —— 直接把功能点用文字说清楚即可，AI 会帮你结构化。

不想动真实系统，先跑内置演示看效果：

```bash
npm run demo
```

---

## 它是怎么工作的

```
阶段 0  环境自检       自动检查 Node / Playwright / 浏览器，缺什么装什么
   ↓
阶段 1  解析用例       读取 Excel/CSV/Markdown，生成结构化用例 + 测试计划
   ↓
阶段 2  ⏸ 等你确认     ★ 硬门禁：没你点头，绝不执行
   ↓
阶段 3  探索页面       真实打开浏览器，抓截图、语义树、可用定位器
   ↓
阶段 4  固化用例       把测试计划写成可复现的 Playwright 用例
   ↓
阶段 5  执行测试       跑起来，实时输出进度
   ↓
阶段 6  输出报告       Markdown 报告 + Playwright HTML 报告 + JSON 结果
```

### 关于那个「硬门禁」

这是整个流程最重要的设计：**计划没被确认，测试就不会执行。**

- AI 产出计划后必须停下来把计划给你看；
- 你说「确认」后，AI 才能打开执行闸门；
- 执行脚本自己也会校验计划文件的状态行 —— 绕过对话也绕不过脚本。

所以你不会遇到「AI 自作主张跑了一堆测试然后给你一个你看不懂的报告」。

---

## 安装

### 全局安装（推荐）

```bash
./install.sh
```

装到 `~/.dsh/skills/playwright-e2e/`，之后**任何项目、任何会话**都能用。

### 只给当前项目装

```bash
./install.sh --project
```

装到 `./.dsh/skills/playwright-e2e/`。

### 其它选项

| 命令 | 作用 |
| --- | --- |
| `./install.sh --link` | 软链接到本仓库，改代码立即生效（开发用） |
| `./install.sh --force` | 覆盖已存在的安装 |
| `./install.sh --target <目录>` | 装到指定目录 |
| `./uninstall.sh` | 移除 skill（保留运行数据） |
| `./uninstall.sh --purge` | 连同依赖、历史记录、登录态一起删除 |

安装后**新开一个 DSH 会话**即可（skill 目录会被自动扫描，不需要重启服务）。

---

## 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | Playwright 1.63 的硬性要求 |
| npm | 任意近期版本 | 用于安装 Playwright 依赖 |
| 操作系统 | macOS / Linux / Windows | 自动适配浏览器缓存路径 |
| 磁盘 | 约 400 MB | 依赖约 250 MB + Chromium 约 150 MB |

**第一次使用时会自动安装**，无需手工操作。默认只装 Chromium；
需要 Firefox / WebKit 时 AI 会先告诉你下载体积再征求同意。

---

## 用例表格式

支持 `.xlsx`、`.csv` 和 Markdown 表格。标准列：

| 用例ID | 模块 | 用例标题 | 优先级 | 前置条件 | 操作步骤 | 预期结果 | 测试数据 | 标签 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-001 | 登录 | 正确账号密码登录成功 | P0 | | 打开登录页\|输入账号密码\|点击登录 | 登录成功并跳转到工作台 | 用户名=admin; 密码=123456 | smoke |

只有 **用例标题** 和 **操作步骤** 是必需的。

- 多值用**单元格内换行**，或用 `|` 分隔，或写 `1. 2. 3.`
- 预期结果写 1 条 = 整条用例的总体预期；写多条 = 与步骤一一对应
- 列名容错：`测试步骤`/`steps`/`操作过程` 都识别为「操作步骤」

模板文件：

- `skill/assets/case-template.xlsx` —— 带列说明的 Excel 模板
- `skill/assets/case-template.csv` —— CSV 版本

完整规则见 [`skill/references/case-format.md`](skill/references/case-format.md)。

---

## 配置

需要登录、多浏览器、自定义超时时，给 AI 一个 `e2e.config.json`：

```json
{
  "baseURL": "https://your-app.example.com",
  "browsers": ["chromium"],
  "headless": true,
  "timeout": 30000,
  "retries": 1,
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "username": "${E2E_USERNAME}",
    "password": "${E2E_PASSWORD}",
    "successUrl": "/dashboard"
  }
}
```

样例见 `skill/assets/e2e.config.example.json`。

**凭据安全**：密码写成 `${E2E_USERNAME}` / `${E2E_PASSWORD}` 占位符，
通过环境变量注入。skill 不会把密码写进任何生成的文件、报告或截图名。

登录一次后会保存 `storageState` 供后续所有用例复用，不必每条用例重新登录。

---

## 产物放在哪

**不会碰你的项目。** 所有东西都在独立运行目录里：

```
~/.dsh/playwright-e2e/                 # 可用 PLAYWRIGHT_E2E_HOME 改位置
├── node_modules/                      # Playwright 依赖（装一次）
├── auth/<项目>.json                   # 复用的登录态
└── runs/<项目>-<时间戳>/
    ├── plan.md                        # 你确认过的测试计划
    ├── cases.json                     # 解析后的用例
    ├── explore/                       # 截图、语义树、定位器候选
    ├── specs/*.spec.ts                # 固化后的用例
    ├── test-results/                  # 结果 JSON + 失败截图 + trace
    ├── playwright-report/index.html   # Playwright 原生 HTML 报告
    ├── results-summary.json           # 归一化结果，可接 CI
    └── report.md                      # 最终测试报告
```

### 报告包含什么

- 结论（通过 / 未通过 / 部分覆盖）与通过率
- 按模块分组的用例明细
- 失败详情：错误信息、截图、trace 路径
- **未自动化用例清单及原因** —— 覆盖缺口会单独列出，不会被通过率掩盖

> 通过率的分母是**实际执行的用例数**。未自动化的用例不计入通过率，
> 而是单独列出，避免「跑了 3 条全过」被读成「18 条全过」。

---

## 离线验证

不想动真实系统？跑内置演示：

```bash
node skill/scripts/demo.mjs
```

它会在本地起一个演示站，完整走一遍 解析 → 计划 → 确认 → 探索 → 执行 → 报告，
结果里**故意包含 1 条失败和 1 条未自动化**，用来演示报告如何呈现这两种情况。

---

## 常见问题

**Q：会不会改我的项目文件？**
不会。测试代码、依赖、截图、报告全在 `~/.dsh/playwright-e2e/` 下。

**Q：AI 会不会自己就开始跑测试？**
不会。计划必须先经你确认，执行脚本也会机械校验计划状态。

**Q：需要我提前装 Playwright 吗？**
不需要。第一次使用时 skill 会自己装。你机器上已有的浏览器缓存会被复用，不会重复下载。

**Q：公司网络需要代理怎么办？**
设置 `npm_config_proxy` / `npm_config_https_proxy` / `HTTPS_PROXY` 后让 AI 重试即可。
见 [`skill/references/troubleshooting.md`](skill/references/troubleshooting.md)。

**Q：报错说无法写入 `~/.dsh/...`？**
那是 agent 沙箱限制，不是磁盘权限问题。两个办法：批准提权，或指定可写目录：

```bash
export PLAYWRIGHT_E2E_HOME="$PWD/.playwright-e2e"
```

**Q：验证码 / 短信登录能测吗？**
不能自动化的用例会被如实标为「未自动化」，在报告里单独列出并说明原因 ——
不会伪造一个「通过」。

**Q：支持多浏览器吗？**
支持。默认 Chromium，配 `"browsers": ["chromium", "firefox", "webkit"]` 即可。
Firefox/WebKit 需要额外下载，AI 会先征求你同意。

**Q：能接 CI 吗？**
`results-summary.json` 是稳定的机器可读格式，可以直接用。但本 skill 不做 CI 平台对接。

---

## 开发

```bash
npm test          # 200+ 个单元测试（node:test，零依赖，秒级完成）
npm run demo      # 离线全链路演示（会下载 Chromium）
npm run template  # 由 CSV 重新生成 Excel 模板
npm run bootstrap # 环境自检与安装
```

### 仓库结构

```
skill/                    ← 会被整体安装到 ~/.dsh/skills/playwright-e2e/
├── SKILL.md              # AI 读的主流程（含三条铁律）
├── references/           # 工作流、用例格式、定位器规范、计划/报告模板、排查手册
├── scripts/              # CLI 入口：bootstrap / new-run / parse-cases / make-plan
│                         # confirm-plan / explore / run / report / make-template / demo
│   └── lib/              # 纯函数模块（单元测试的主要目标）
│                         # paths / config / cases / csv / spreadsheet / locators
│                         # results / report / plan / toolchain / deps / playwright-config
└── assets/               # 用例模板、spec 骨架、配置样例、离线演示站

tests/                    # 单元测试 + skill 清单校验
.github/                  # CI、issue 模板、PR 模板
```

**分层约定**：`scripts/*.mjs` 负责参数解析、I/O 和错误呈现；
`scripts/lib/*.mjs` 负责纯逻辑。新逻辑尽量写进 `lib/` —— 那里才测得动。
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 设计上的几个关键决定

- **计划门禁是机械的**：`plan.md` 的状态行由 `confirm-plan.mjs` 写入，
  `run.mjs` 执行前校验。光靠指令约束 AI 是不够的。
- **依赖装在独立 home**：脚本从 `<home>/node_modules` 显式解析依赖
  （见 `lib/deps.mjs`），所以 skill 目录可以随时重装而不影响已装好的环境。
- **钉死 Playwright 1.63.0**：与常见浏览器缓存版本对齐，避免首次使用就下载几百 MB。
  可用 `PLAYWRIGHT_VERSION` 覆盖。
- **npm 缓存重定向**到 `<home>/.npm-cache`：绕开宿主机 `~/.npm` 的权限与沙箱问题。
- **报告渲染是纯函数**：`renderReport(plan, cases, results, config)`，
  所以报告格式有单元测试覆盖，不需要跑浏览器。
- **拒绝接管他人目录**：运行目录里已有非本 skill 的 `package.json` 时，
  `bootstrap.mjs` 会拒绝安装而不是覆盖它。

更多细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 安全

这个工具会驱动真实浏览器，并需要处理登录凭据。要点：

- 账号密码**只通过环境变量传递**，不写入任何生成的文件
- `auth/<项目>.json`（Playwright 的 `storageState`）**含真实会话 Cookie**，
  默认在 `~/.dsh/playwright-e2e/auth/`，`.gitignore` 已忽略
- 对生产环境跑测试前，请确认用例不会产生真实副作用

完整说明见 [SECURITY.md](SECURITY.md)。

---

## 不做什么

单元测试、接口/API 测试、性能压测、视觉回归、CI 平台对接、测试管理平台同步。

需要这些时请用专门的工具 —— 用 E2E 去凑只会得到又慢又脆的测试。

---

## 参与贡献

欢迎提 issue 和 PR。开始之前请读 [CONTRIBUTING.md](CONTRIBUTING.md) ——
里面有五条不可违反的设计约束，以及加脚本、写测试的约定。

```bash
npm test    # 200+ 个单元测试，零依赖，秒级完成
```

发现安全问题时请走[私密报告渠道](SECURITY.md#报告安全漏洞)，不要开公开 issue。

---

## 许可

[MIT](LICENSE) © 2026 minshan1874
