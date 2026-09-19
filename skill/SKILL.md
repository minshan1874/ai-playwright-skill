---
name: playwright-e2e
description: 把被测网址和功能测试用例（Excel/CSV/Markdown）变成可执行的端到端自动化测试。自动准备 Playwright 环境、解析用例、输出测试计划并等待用户确认，确认后探索真实页面、固化为 Playwright 用例、执行测试，最终产出 Markdown 测试报告、Playwright HTML 报告与 JSON 结果。适用于功能验证、回归测试和上线前检查。
whenToUse: 当用户提供被测网址和功能测试用例（或要求「帮我测一下这个网站/这个功能」），需要生成测试计划、自动执行端到端测试并输出测试报告时使用。
metadata:
  version: 1.2.0
  requires:
    node: ">=20"
---

# Playwright 端到端自动化测试

把「网址 + 功能测试用例」变成「测试计划 → 用户确认 → 自动执行 → 测试报告」。

本 skill 的所有脚本都在 `scripts/` 下（相对于本 skill 的基础目录）。下面命令里的
`$SKILL` 指该基础目录，例如 `~/.dsh/skills/playwright-e2e`。

---

## 铁律

这三条不可协商，违反任何一条都会让整个流程失去意义。

1. **计划必须先经用户确认。** 产出 `plan.md` 后**停下来**，把计划内容展示给用户，
   等待用户明确表示同意（例如「确认」「可以」「开始执行」）。**不得自行进入执行阶段。**
   用户提出修改就更新计划，然后**再次等待确认**。
2. **绝不伪造结果。** 没跑过的用例就是「未自动化」，跑失败的用例就是「失败」。
   不得为了让报告好看而跳过、注释掉或放宽断言。无法自动化的用例要在计划里说明、在报告里列出。
3. **不污染被测项目。** 测试代码、依赖、截图、报告全部写在独立运行目录里
   （默认 `~/.dsh/playwright-e2e/runs/<项目>-<时间戳>/`）。不要往被测项目里写任何文件。

---

## 工作流程

### 阶段 0 — 环境准备

先做只读自检，再按需安装：

```bash
node "$SKILL/scripts/bootstrap.mjs" --check --json
```

看返回的 `ready` 字段：

- `ready: true` → 直接进入阶段 1。
- `ready: false` 且 `needsBrowserInstall` 非空 → **先告诉用户要下载哪些浏览器、大约多大**
  （`downloadEstimate`），征得同意后再执行：
  ```bash
  node "$SKILL/scripts/bootstrap.mjs" --install-browsers --json
  ```
- `ready: false` 且 `blocked` 非空 → 这是沙箱或权限问题。把 `hint` 原文转达给用户，
  请用户批准提权，或让用户指定一个可写目录：
  `PLAYWRIGHT_E2E_HOME=<可写目录> node "$SKILL/scripts/bootstrap.mjs"`。

默认只装 Chromium。用户要求多浏览器时用 `--browsers chromium,firefox,webkit`。
更细的排查见 `references/troubleshooting.md`。

**关于权限**：运行目录默认在 `~/.dsh/playwright-e2e/`，位于被测项目之外。
如果当前会话的文件沙箱只允许写工作区，第一次写运行目录会被拒绝。
这不是磁盘权限问题 —— 出现时**一次性申请更宽的文件权限**（批准后整个流程都能用），
或让用户指定可写目录：

```bash
PLAYWRIGHT_E2E_HOME="<可写目录>" node "$SKILL/scripts/bootstrap.mjs"
```

一旦用了 `PLAYWRIGHT_E2E_HOME`，后续每个脚本都必须带上同一个环境变量。

### 浏览器可见性

**默认是有头模式** —— `explore.mjs` 和 `run.mjs` 都会真的弹出浏览器窗口，
用户能看着它操作。这对「让用户信任测试结果」很重要，尤其是第一次测一个新站点时。

| 参数 | 作用 | 什么时候用 |
| --- | --- | --- |
| （默认） | 弹出窗口，用户可见 | 正常情况 |
| `--slow-mo 500` | 每个操作放慢 500ms，肉眼跟得上 | 用户说「太快了看不清」 |
| `--headless` | 不弹窗口 | 无显示环境：CI、服务器、远程机器 |

**你必须主动告诉用户这件事**，并在计划阶段就说明：测试会打开浏览器窗口；
嫌快可以加 `--slow-mo`；不想弹窗就用 `--headless`，报告里的截图和 trace
仍然能逐步回放。

如果浏览器启动失败并提示 `cannot open display` 或类似错误，说明当前环境没有
显示服务 —— 加 `--headless` 重试，不要反复重跑。

### 阶段 1 — 解析用例并生成测试计划

```bash
node "$SKILL/scripts/new-run.mjs" --url "<被测网址>" --json
```

记下返回的 `runDir`。如果用户提供了配置文件，加 `--config <文件>`。

然后解析用例表（支持 `.xlsx` / `.csv` / `.md`）：

```bash
node "$SKILL/scripts/parse-cases.mjs" \
  --input "<用例文件>" --out "<runDir>/cases.json" --json
```

**必须检查返回的 `warnings`**：缺标题、缺步骤、ID 重复、列名未识别等都要在计划里向用户说明。
如果表头识别失败，把 `error` 里的期望列名告诉用户，请其修正表格或确认列名映射。
列结构定义见 `references/case-format.md`；用户没有模板时，把 `assets/case-template.xlsx`
（或 `assets/case-template.csv`）给他照着填。

生成计划骨架：

```bash
node "$SKILL/scripts/make-plan.mjs" --run-dir "<runDir>" --json
```

**然后补全 `<runDir>/plan.md`**。骨架里有 5 个必须写实的部分：

1. 测试目标与范围 —— 本次要验证什么，**明确不测什么**。
2. 用例清单 —— 逐条标注自动化可行性（可自动化 / 需登录 / 需人工 / 无法自动化）。
3. 执行策略 —— 登录方式、测试数据、执行顺序、需要人工介入的环节。
4. 风险与不确定项 —— 验证码、短信、第三方依赖、动态数据、环境不稳。
5. 需要用户确认的问题 —— 没有就写「无」。

写完后把计划**完整展示给用户**，然后**停止**，等待确认。此时不要调用 `explore.mjs`，
也不要写任何 `.spec.ts`。

### 阶段 2 — 用户确认

用户明确同意后：

```bash
node "$SKILL/scripts/confirm-plan.mjs" --plan "<runDir>/plan.md" --note "用户确认原话" --json
```

`run.mjs` 会机械校验 `plan.md` 的状态行，未确认会直接拒绝执行。这是有意的设计。

用户要改计划 → 改 `plan.md`（`make-plan.mjs --force` 可重新生成骨架）→ 回到展示与等待确认。

### 阶段 3 — 探索页面并固化用例

```bash
node "$SKILL/scripts/explore.mjs" \
  --url "<被测网址>" --out "<runDir>/explore" --config "<runDir>/e2e.config.json" --json
```

需要登录后才能看到的页面，写一个步骤文件（格式见 `references/workflow.md`）后用
`--steps <文件>`，或先跑一次登录并复用登录态。

产物在 `<runDir>/explore/`：

| 文件 | 用途 |
| --- | --- |
| `outline.md` | **优先读这个**：可操作元素 + 推荐定位器（已按稳定性排序），以及可断言的只读元素 |
| `aria.yml` | 语义树，写 `getByRole` 的依据 |
| `dom-outline.json` | 完整元素数据与全部候选定位器 |
| `page.png` | 全页截图，确认页面确实是预期的那一个 |
| `console.json` | 控制台错误，先判断是不是环境/数据问题 |
| `network.json` | 失败请求与 4xx/5xx |

**探索失败就回到阶段 1**：网址打不开、证书错、需要登录、页面白屏，都属于环境问题，
要和用户确认后调整计划，不要硬写用例。

然后按 `assets/spec.template.ts` 和 `references/locator-guide.md` 在
`<runDir>/specs/` 下编写 `.spec.ts`：

- 每个用例一个 `test()`，标题以 `[用例ID]` 开头，并写入 `caseId` / `priority` / `module`
  注解 —— 报告靠这个把结果关联回用例表。
- 步骤用 `_fixtures.ts` 里的 `step()` 包起来，失败时会自动截图并定位到具体步骤。
- 定位器优先用 `getByRole` / `getByLabel` / `getByTestId`，**禁止用 `waitForTimeout` 兜底**。
- 计划里标为「无法自动化」的用例，**不要**编造一个假用例，留空即可，报告会列为未自动化。

### 阶段 4 — 执行

```bash
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --json
```

`run.mjs` 会生成 `playwright.config.ts` 并执行 `<runDir>/specs/` 下的全部用例，
结果归一化到 `<runDir>/results-summary.json`。

- `ok: true` → 测试确实跑起来了，`counts` 里的失败数是真实测试结果，继续阶段 5。
- `ok: false` → 基础设施问题（浏览器没装、编译失败、没有用例文件）。看 `hint` 修复后重跑，
  **不要**把这类失败写进报告当成测试结论。

只想重跑部分用例时加 `--grep "<模式>"`。

### 阶段 5 — 输出报告

```bash
node "$SKILL/scripts/report.mjs" --run-dir "<runDir>" --json
```

产出 `<runDir>/report.md`，并在对话里给用户一份摘要：

- 结论（通过 / 未通过 / 部分覆盖）与通过率
- 失败用例清单与失败原因
- **未自动化用例清单及原因**（这是覆盖缺口，必须主动说，不能藏）
- 产物路径：`report.md`、`playwright-report/index.html`、`results-summary.json`

把 `report.md` 的内容作为最终答复的主体呈现给用户，不要只说「报告已生成」。

---

## 快速参考

### 完整命令序列

```bash
SKILL=~/.dsh/skills/playwright-e2e
node "$SKILL/scripts/bootstrap.mjs" --check --json
node "$SKILL/scripts/new-run.mjs" --url "<网址>" --json
node "$SKILL/scripts/parse-cases.mjs" --input "<用例>" --out "<runDir>/cases.json" --json
node "$SKILL/scripts/make-plan.mjs" --run-dir "<runDir>" --json
#   ← 补全 plan.md，展示给用户，等待确认
node "$SKILL/scripts/confirm-plan.mjs" --plan "<runDir>/plan.md" --json
node "$SKILL/scripts/explore.mjs" --url "<网址>" --out "<runDir>/explore" --config "<runDir>/e2e.config.json" --json
#   ← 在 <runDir>/specs/ 下编写 .spec.ts
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --json
node "$SKILL/scripts/report.mjs" --run-dir "<runDir>" --json
```

在 `explore.mjs` 和 `run.mjs` 上可叠加可见性参数：

```bash
# 放慢，让用户看得清（默认就有窗口，不用加 --headed）
... --slow-mo 500 --json
# 无显示环境（CI / 服务器 / 远程机器）
... --headless --json
```

所有脚本都支持 `--json`，会输出一行以 `###PLAYWRIGHT_E2E_JSON###` 开头的 JSON。
**始终用 `--json` 调用**，这样你能可靠地读到 `runDir`、`warnings`、`counts` 等字段。

### 用例表标准列

| 用例ID | 模块 | 用例标题 | 优先级 | 前置条件 | 操作步骤 | 预期结果 | 测试数据 | 标签 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

只有「用例标题」和「操作步骤」是必需的，其余可留空。多行内容在单元格内换行，
或用 `|` 分隔。完整规则见 `references/case-format.md`。

### 配置

`e2e.config.json` 控制 baseURL、浏览器、超时、重试、登录等。样例见
`assets/e2e.config.example.json`。凭据**必须**写成 `${E2E_USERNAME}` / `${E2E_PASSWORD}`
占位符并通过环境变量注入，**不要把密码写进配置文件、用例文件或报告**。

---

## 参考文件

| 文件 | 何时读 |
| --- | --- |
| `references/workflow.md` | 需要步骤文件格式、登录态复用、多浏览器等具体做法时 |
| `references/case-format.md` | 解析用例报错、列名不匹配、需要给用户模板时 |
| `references/locator-guide.md` | 写 `.spec.ts` 之前 |
| `references/plan-template.md` | 补全 `plan.md` 时 |
| `references/report-template.md` | 需要解释报告结构时 |
| `references/troubleshooting.md` | 任何脚本失败、环境异常、沙箱拒绝时 |

## 边界

本 skill **不做**：单元测试、接口/API 测试、性能压测、视觉回归、CI 平台对接、
测试管理平台同步。用户要求这些时明确说明不在范围内，不要勉强用 E2E 去凑。
