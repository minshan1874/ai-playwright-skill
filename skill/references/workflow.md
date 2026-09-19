# 详细操作手册

SKILL.md 给出主干流程；这里给出每一步的具体做法、参数和边界情况。

---

## 1. 步骤文件（探索登录后的页面）

`explore.mjs --steps <文件>` 接受一个 JSON 数组。每个元素是一个动作。

```json
[
  { "action": "goto", "url": "/login" },
  { "action": "fill", "locator": { "by": "label", "value": "用户名" }, "value": "admin" },
  { "action": "fill", "locator": { "by": "css", "value": "input[type=password]" }, "value": "admin123" },
  { "action": "click", "locator": { "by": "role", "role": "button", "name": "登录" } },
  { "action": "waitFor", "locator": { "by": "text", "value": "欢迎回来" } },
  { "action": "screenshot", "name": "after-login" }
]
```

### 支持的定位方式

`locator` 可以是一个对象（推荐），也可以是一个 JS 表达式字符串。

| `by` | 生成的定位器 | 必需字段 |
| --- | --- | --- |
| `testId` | `page.getByTestId(v)` | `value` |
| `role` | `page.getByRole(role, { name })` | `role`，`name` 可选 |
| `label` | `page.getByLabel(v)` | `value` |
| `placeholder` | `page.getByPlaceholder(v)` | `value` |
| `text` | `page.getByText(v)` | `value` |
| `title` | `page.getByTitle(v)` | `value` |
| `alt` | `page.getByAltText(v)` | `value` |
| `css` | `page.locator(v)` | `value` |

字符串形式直接接在 `page.` 后面，例如 `"getByRole('button', { name: '登录' })"`。
**只对自己编写的步骤文件使用字符串形式**；不要执行来源不明的步骤文件。

### 支持的动作

| `action` | 说明 | 其他字段 |
| --- | --- | --- |
| `goto` | 导航；相对路径基于当前地址解析 | `url` |
| `click` | 点击 | `locator` |
| `fill` | 填写 | `locator`, `value` |
| `press` | 按键 | `locator`, `key`（默认 `Enter`） |
| `selectOption` | 下拉选择 | `locator`, `value` |
| `check` | 勾选 | `locator` |
| `waitFor` | 等待元素状态 | `locator`, `state`（默认 `visible`） |
| `waitForLoadState` | 等待加载状态 | `state`（默认 `networkidle`） |
| `waitForTimeout` | 固定等待，**探索阶段才允许** | `ms` |
| `screenshot` | 截图到 `explore/screenshots/` | `name` |

任意步骤都可加 `"screenshot": true` 来额外截图。

**步骤失败即停止**：后续步骤的结果会失真，所以 `explore.mjs` 在第一个失败处停下，
并把失败信息放进返回值的 `steps` 数组。看到失败就调整步骤，不要忽略。

---

## 2. 登录态复用

三个阶段都能用登录态：`explore.mjs` 用 `--storage-state`，`run.mjs` 用配置里的 `auth`。

### 方式一：让 skill 自动登录（推荐）

在 `e2e.config.json` 里启用：

```json
{
  "baseURL": "https://your-app.example.com",
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "username": "${E2E_USERNAME}",
    "password": "${E2E_PASSWORD}",
    "successUrl": "/dashboard",
    "saveAfterLogin": true
  }
}
```

执行时注入凭据：

```bash
E2E_USERNAME=admin E2E_PASSWORD='***' node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --json
```

`run.mjs` 会生成一个 Playwright setup 工程先登录一次，把 `storageState` 存到
`~/.dsh/playwright-e2e/auth/<项目>.json`，后续所有用例复用。凭据通过环境变量传递，
**不会写进任何生成的文件**。

如果登录表单没有标准的 label / role，用显式选择器覆盖：

```json
{
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "usernameSelector": "#account",
    "passwordSelector": "#password",
    "submitSelector": ".login-btn",
    "successUrl": "/dashboard"
  }
}
```

### 方式二：手工登录一次

先用有头模式打开浏览器手工登录，再导出状态：

```bash
node "$SKILL/scripts/explore.mjs" --url "<网址>" --out "<runDir>/explore" --headed --json
```

更直接的做法是写一个一次性脚本，或用 Playwright 的 `codegen`：

```bash
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js codegen --save-storage="$HOME/.dsh/playwright-e2e/auth/site.json" "<网址>"
```

然后把 `auth.storageState` 指到该文件，并设 `auth.enabled: false`：

```json
{ "auth": { "enabled": false, "storageState": "/Users/you/.dsh/playwright-e2e/auth/site.json" } }
```

### 登录态过期的表现

所有用例同时因为「找不到某元素」而失败，且截图停在登录页 → 登录态失效。
重新登录一次即可，不要改用例。

---

## 3. 多浏览器

默认只跑 Chromium。要跑多个：

```bash
node "$SKILL/scripts/bootstrap.mjs" --browsers chromium,firefox,webkit --install-browsers --json
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --browsers chromium,firefox --json
```

Firefox 和 WebKit 需要额外下载（各约 80–90 MB），**必须先告知用户并取得同意**。
下载会写入共享浏览器缓存目录（macOS 为 `~/Library/Caches/ms-playwright`），
在受限沙箱里可能被拒绝 —— 那种情况下请用户批准提权，或设置
`PLAYWRIGHT_BROWSERS_PATH` 到一个可写目录。

每个浏览器会生成一个 Playwright project，报告里通过 `project` 字段区分。

---

## 4. 编写用例文件

模板与规范见 `assets/spec.template.ts` 和 `references/locator-guide.md`。要点：

- 文件放在 `<runDir>/specs/`，命名 `*.spec.ts`。
- 标题必须以 `[用例ID]` 开头。
- 必须带 `caseId` / `priority` / `module` 注解。
- 用 `_fixtures.ts` 的 `step()` 包住每一步。
- 不要写 `waitForTimeout`；用自动等待的断言。
- 一个用例失败不应该影响其他用例 —— 不要用 `test.describe.serial` 串起独立用例。

---

## 5. 只跑部分用例

```bash
# 按用例ID
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --grep "TC-00[1-3]" --json

# 按标签
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --grep "@smoke" --json

# 按浏览器
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --project chromium --json
```

注意：`--grep` 之后，没跑到的用例在报告里会显示为「未自动化」。
如果这只是临时重跑，要在最终答复里说明，避免被误读成覆盖缺口。

---

## 6. 失败分类

执行结束后先分类，再决定怎么向用户汇报。

| 现象 | 分类 | 处理 |
| --- | --- | --- |
| `run.mjs` 返回 `ok: false` | 基础设施失败 | 按 `hint` 修复后重跑，**不写进报告** |
| `counts.failed > 0` | 真实测试失败 | 正常出报告，逐条分析 |
| `counts.skipped > 0` | 用例被跳过 | 查明原因（通常是 `test.skip` 条件），在报告里说明 |
| `counts.flaky > 0` | 不稳定用例 | 报告里标为不稳定，并提示需要治理 |
| `notAutomated` 非空 | 覆盖缺口 | 在报告和答复里**主动**说明原因 |

### 判断失败是产品缺陷还是用例问题

看到失败先问三个问题：

1. 截图里页面是什么状态？和预期差在哪？
2. `console.json` / trace 里有没有 JS 报错或接口 4xx/5xx？
3. 换个定位器或加一个显式等待后是否就通过了？

如果第 3 条成立，多半是用例写得不稳，应该修用例（改用语义定位器、等待真实状态），
而不是放宽断言。**不要把产品缺陷通过改断言「修」掉。**

---

## 7. 产物清单

一次完整运行后，`<runDir>/` 下会有：

```
plan.md                 已确认的测试计划
cases.json              解析后的用例
e2e.config.json         本次运行的配置快照（凭据已脱敏）
explore/                探索产物（截图、语义树、定位器候选）
specs/*.spec.ts         固化后的用例
playwright.config.ts    自动生成
test-results/           JSON 结果 + 失败截图 + trace
playwright-report/      HTML 报告（打开 index.html）
results-summary.json    归一化结果
report.md               最终测试报告
```
