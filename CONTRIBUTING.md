# 贡献指南

感谢愿意花时间改进这个项目。下面是你需要知道的全部内容。

---

## 快速开始

```bash
git clone https://github.com/minshan1874/ai-playwright-skill.git
cd ai-playwright-skill

npm test        # 200+ 个单元测试，零依赖，秒级完成
npm run demo    # 离线全链路演示（会下载 Chromium，约 150 MB）
```

`npm test` 不需要装任何依赖 —— 测试用的是 Node 内置的 `node:test`。
`npm run demo` 会自己安装 Playwright 环境。

---

## 项目结构

```
skill/                    ← 会被整体安装到 ~/.dsh/skills/playwright-e2e/
├── SKILL.md              ← AI 读的主流程，含三条铁律
├── references/           ← 按需加载的详细文档
├── scripts/              ← CLI 入口，每个都是一个独立可执行脚本
│   └── lib/              ← 纯函数模块，单元测试的主要目标
└── assets/               ← 用例模板、spec 骨架、离线演示站

tests/                    ← 单元测试 + skill 清单校验
```

**关键分层**：`scripts/*.mjs` 负责参数解析、I/O 和错误呈现；
`scripts/lib/*.mjs` 负责纯逻辑。**新逻辑尽量写进 `lib/`** —— 那里才测得动。

---

## 不可违反的设计约束

改动如果触碰这几条，PR 会被要求说明理由。它们不是风格偏好，是这个工具可信度的基础。

### 1. 计划门禁必须是机械的

`run.mjs` 在执行前读取 `plan.md` 的状态行，不是「已确认」就拒绝执行。
**不要**把它改成「默认放行」或「加个 flag 跳过」——
光靠指令约束 AI 是不够的，这是唯一能保证用户先看到计划的地方。

### 2. 绝不伪造结果

- 未自动化的用例不计入通过率，单独列在报告第四节
- 失败的用例就是失败，不能通过放宽断言「修」成绿色
- 基础设施错误（浏览器没装、编译失败）与测试失败必须区分

### 3. 不污染被测项目

所有产物写在运行目录（默认 `~/.dsh/playwright-e2e/runs/<项目>-<时间戳>/`）。
任何往被测项目目录写文件的行为都是 bug。

### 4. 凭据不入盘

账号密码只通过环境变量传递。检查你的改动：
- 生成的文件里不能出现明文密码
- 报告里不能出现明文密码
- 截图文件名里不能出现明文密码

`run.mjs` 写配置快照时会主动脱敏，新增字段时别忘了同样处理。

### 5. 报告渲染是纯函数

`renderReport()` 接受数据、返回字符串，不读文件、不写文件、不打印。
这样报告格式才能被单元测试覆盖，而不需要跑浏览器。

---

## 加一个脚本

1. 在 `skill/scripts/` 下建 `your-script.mjs`
2. 用 `parseArgs` + `createReporter` 统一 CLI 契约：

```js
import { createReporter, parseArgs } from './lib/log.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'your-script' });

async function main() {
  if (typeof flags.required === 'undefined') {
    process.exit(reporter.finish({
      ok: false,
      error: '缺少 --required 参数',
      hint: '用法：node your-script.mjs --required <值>',
    }));
  }
  // ...
  process.exit(reporter.finish({ ok: true, /* 结构化结果 */ }));
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
```

**契约要求**（`tests/skill.test.mjs` 会检查）：

- 支持 `--json`，输出一行以 `###PLAYWRIGHT_E2E_JSON###` 开头的 JSON
- 失败时以退出码 1 结束，且 `ok: false`
- 必须提供 `error`（出了什么事）和 `hint`（怎么修）两个字段

把纯逻辑放进 `scripts/lib/`，然后为它写测试。

---

## 测试

```bash
npm test                              # 全部
node --test tests/cases.test.mjs      # 单个文件
node --test --watch tests/            # 开发时监听
```

写测试时注意：

- 用 `node:test` + `node:assert/strict`，**不要引入测试框架依赖**
- 需要临时目录时用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))`，
  并在 `after()` 里删掉 —— **测试不能往仓库里写文件**
- 涉及时间的逻辑要接受注入的 `Date`，不要直接读 `Date.now()`
- 涉及路径的逻辑要接受注入的 `env`，不要直接读 `process.env`

`tests/skill.test.mjs` 会自动校验：

- `SKILL.md` 的 frontmatter 合法（name 是 kebab-case、description 在 500 字符内）
- SKILL.md 里引用的每个 `references/*.md` 和 `scripts/*.mjs` 都真实存在
- 每个模块都能通过 `node --check`
- 每个脚本在缺少必需参数时都返回结构化的失败

**改了 SKILL.md 的引用或新增脚本后，这个测试会立刻告诉你有没有漏。**

---

## 改了用例模板

`skill/assets/case-template.csv` 是唯一事实来源，`.xlsx` 由它生成：

```bash
npm run template    # 重新生成 skill/assets/case-template.xlsx
```

**不要手工编辑 `.xlsx`** —— 下次生成会被覆盖。两个文件都要提交。

---

## 提交规范

提交信息用祈使句，说明**为什么**而不只是做了什么：

```
好：修复 HTML 报告落到运行目录之外的问题

    Playwright 的 HTML reporter 选项是 outputFolder，不是 outputDir。
    写错时被静默忽略，报告会落到默认位置，agent 永远找不到。

坏：fix bug
```

一个 PR 做一件事。重构和功能改动分开提交。

---

## 提交前自查

```bash
npm test
git status              # 确认没有 runs/、node_modules/、report.md 之类的东西
git diff --cached       # 确认没有真实凭据、内网地址、本地绝对路径
```

`.gitignore` 已经覆盖了运行产物和凭据，但**请自己再看一眼** ——
自动化规则挡不住你把密码写进一个正常命名的源文件里。

---

## 报告问题

用 [issue 模板](https://github.com/minshan1874/ai-playwright-skill/issues/new/choose)。
请附上 `bootstrap.mjs --check --json` 的输出和出错阶段的完整 JSON —— 这两项最有用。

**提交前务必脱敏**：删掉账号、密码、Cookie、token、内网域名和真实业务数据。

---

## 许可证

贡献的代码按 [MIT](LICENSE) 许可发布。
