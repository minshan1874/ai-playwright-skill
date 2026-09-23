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
| `uncheck` | 取消勾选 | `locator` |
| `hover` | 悬停（展开菜单） | `locator` |
| `waitFor` | 等待元素状态 | `locator`, `state`（默认 `visible`） |
| `waitForLoadState` | 等待加载状态 | `state`（默认 `networkidle`） |
| `waitForTimeout` | 固定等待，**探索阶段才允许** | `ms` |
| `screenshot` | 截图到 `explore/screenshots/` | `name`（默认 `step-<序号>`）、`fullPage`（默认 true） |

任意步骤都可加 `"screenshot": true` 来额外截图 —— 这是 `screenshot` 动作之外的第二种写法，
两种都支持。动作名写错时，报错会列出全部受支持的动作。

```json
[
  { "action": "goto", "url": "/login" },
  { "action": "fill", "locator": { "by": "css", "value": "#account" }, "value": "${E2E_USERNAME}" },
  { "action": "click", "locator": { "by": "role", "role": "button", "name": "继续" } },
  { "action": "waitFor", "locator": { "by": "css", "value": "#password" } },
  { "action": "fill", "locator": { "by": "css", "value": "#password" }, "value": "${E2E_PASSWORD}" },
  { "action": "click", "locator": { "by": "role", "role": "button", "name": "登录" } },
  { "action": "screenshot", "name": "after-login" },
  { "action": "waitFor", "locator": { "by": "text", "value": "欢迎回来" } }
]
```

步骤文件里的 `value` 可以直接写 `${E2E_USERNAME}` / `${E2E_PASSWORD}`：
探索时从环境变量取值，写进用例时会被换成环境变量引用，**不会把密码落到文件里**。

**步骤失败即停止**：后续步骤的结果会失真，所以 `explore.mjs` 在第一个失败处停下，
并把失败信息放进返回值的 `steps` 数组。看到失败就调整步骤，不要忽略。

---

## 2. 登录

三个阶段都能用登录态：`explore.mjs` 用 `--storage-state`（或配置里的 `auth.storageState`），
`run.mjs` 用配置里的 `auth`。**先选方式，再动手**：

| 方式 | 配置 | 适用 |
| --- | --- | --- |
| ① 复用已有登录态 | `{"auth": {"enabled": false, "storageState": "auth/site.json"}}` | 能手工登录一次；Google/SSO/扫码/短信/验证码登录 |
| ② 自动登录（单页） | `enabled: true` + `loginUrl` + `username`/`password` | 账号密码同页，无验证码 |
| ③ 自动登录（多步骤） | 在 ② 上加 `continueSelector` 或 `steps` | 「账号 → 继续 → 密码 → 登录」 |

`auth.storageState` 的相对路径按**配置文件所在目录**解析，不是当前工作目录。
方式 ① **不需要** `loginUrl`、`username`、`password`：只复用登录态时不要求登录配置。

### 方式一：复用已有登录态（推荐，尤其是第三方登录）

**Google / 第三方 OAuth 不要尝试自动输入账号密码。** Google 会拦截自动化浏览器
（「此浏览器或应用可能不安全」），账号还可能触发 2FA 或设备确认。正确做法是让用户
手工登录一次，把登录态导出来复用：

```bash
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js codegen \
  --save-storage="$HOME/.dsh/playwright-e2e/auth/site.json" "<被测网址>"
```

`codegen` 会打开一个窗口让你手工操作（含扫码、短信、2FA），结束后把 `storageState`
写到指定路径。然后配置：

```json
{ "auth": { "enabled": false, "storageState": "/Users/you/.dsh/playwright-e2e/auth/site.json" } }
```

### 方式二：自动登录（单页表单）

```json
{
  "baseURL": "https://your-app.example.com",
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "username": "${E2E_USERNAME}",
    "password": "${E2E_PASSWORD}",
    "successSelector": "[data-testid=\"account-menu\"]",
    "saveAfterLogin": true
  }
}
```

执行时注入凭据：

```bash
E2E_USERNAME=admin E2E_PASSWORD='***' node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --json
```

`run.mjs` 会生成一个 Playwright setup 工程先登录一次，把 `storageState` 存到
`~/.dsh/playwright-e2e/auth/<项目>.json`，同一次执行里的浏览器工程直接复用这份登录态。
凭据通过环境变量传递，**不会写进任何生成的文件**。

登录表单没有标准 label / role 时，用显式选择器覆盖：

```json
{
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "usernameSelector": "#account",
    "passwordSelector": "#password",
    "submitSelector": ".login-btn",
    "successSelector": "[data-testid=\"user-menu\"]"
  }
}
```

### 方式三：多步骤登录

两步表单（账号 → 继续 → 密码 → 登录）只需要多给一个 `continueSelector`：

```json
{
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "usernameSelector": "#account",
    "continueSelector": "#continue",
    "passwordSelector": "#password",
    "submitSelector": "#submit",
    "successUrl": "/dashboard"
  }
}
```

生成的步骤是：打开登录页 → 等待账号框 → 填账号 → **点继续** → 等待密码框 → 填密码 →
提交。每一步都会出现在 Playwright HTML 报告的 `setup` 工程里，登录卡在哪一步一目了然。

如果密码框始终不出现，报错会提示检查 `auth.continueSelector` —— 这正是
「把两步表单当成单页表单」的典型症状。

完全自定义的流程（SSO 按钮、验证码提示、2FA）用 `auth.steps`，
动作与定位方式和探索步骤文件完全一致：

```json
{
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "steps": [
      { "action": "click", "locator": { "by": "text", "value": "使用 Google 登录" } },
      { "action": "waitFor", "locator": { "by": "css", "value": "#password" } },
      { "action": "fill", "locator": { "by": "css", "value": "#password" }, "value": "${E2E_PASSWORD}" },
      { "action": "click", "locator": { "by": "role", "role": "button", "name": "下一步" } }
    ]
  }
}
```

### 登录成功的判据

**优先用页面元素，而不是 URL。** 登录后才会出现的账户菜单、模型配置、Upgrade 按钮、
余额/积分区域都比 URL 稳定 —— 重定向链、新手引导页、A/B 落地页都会让 URL 变来变去。

- `auth.successSelector`：登录成功后才可见的元素（推荐）
- `auth.successUrl`：URL 正则（二者可同时配置）
- 都不配：只等 `networkidle`，不判定成功（不推荐，登录失败会被误判为成功）

`explore.mjs` 的产物 `outline.md` 里有「登录成功信号候选」一节，直接抄里面的定位器。

### 其它登录相关配置

| 字段 | 作用 |
| --- | --- |
| `auth.saveAfterLogin` | 默认 `true`；设 `false` 则只登录不保存登录态 |
| `auth.forceLogin` | 默认 `false`；设 `true` 则忽略已有登录态强制重新登录 |

### 登录态过期的表现

所有用例同时因为「找不到某元素」而失败，且截图停在登录页 → 登录态失效。
重新登录（或重新导出）一次即可，**不要改用例**。

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

### 异步任务（文生图、导出、批处理）

`_fixtures.ts` 提供三个常量和一个等待函数，来自配置里的 `asyncTasks`：

```ts
import { step, waitForAsyncTask, ASYNC_SUBMIT_TIMEOUT, ASYNC_COMPLETION_TIMEOUT } from './_fixtures';

await step(page, '提交生成任务', async () => {
  await page.getByRole('button', { name: '生成' }).click({ timeout: ASYNC_SUBMIT_TIMEOUT });
});

const elapsed = await waitForAsyncTask(page, '等待生成完成', async () => {
  const status = (await page.getByTestId('task-status').textContent())?.trim() ?? '';
  if (status === '已完成') return true;   // 完成
  if (status === '失败') throw new Error('任务失败：生成服务返回失败');
  return status;                           // 未完成，返回当前状态
});
```

- `check` 返回 `false`/状态字符串 = 还没好，返回 `true` = 完成。
- 每次状态变化都会记进**步骤时间线**，失败时报告里能看到
  `Queued（0s） → 生成中（12s） → 已完成（48s）` 这样的过程。
- `waitForAsyncTask` 会**只给当前用例**放宽超时（`timeout + ASYNC_SUBMIT_TIMEOUT` 的余量），
  所以不必为了异步任务把全局 `timeout` 调大。
- 超时报错会区分两种情况：最后状态一直没推进 → 更像提交/产品问题；
  一直停在 `Queued` → 调大 `asyncTasks.completionTimeout`。

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

筛选执行时，没被选中的用例进入 **`notExecuted`（本次未执行）**，与
**`notAutomated`（未自动化，覆盖缺口）** 是两个不同的口径：

| 字段 | 含义 | 汇报口径 |
| --- | --- | --- |
| `notAutomated` | 从未写过自动化代码 | 覆盖缺口，必须主动说明 |
| `notExecuted` | 已有自动化代码，被本次筛选排除 | 执行范围，不是缺口 |

`verdict` 会给出 `⚠️ 筛选执行（未跑全量）`，报告里也有独立的
「本次未执行用例（筛选执行，非覆盖缺口）」一节。**不要**把筛选执行说成覆盖缺口，
也不要用它掩盖真正的缺口。

---

## 6. 重跑与执行批次

每次 `run.mjs` 都会新建一个批次目录，本次执行的**所有**附件只写在里面：

```
<runDir>/attempts/attempt-20250101-120000/
  attempt.json          本批次元信息（筛选条件、登录方式、计数）
  test-results/         results.json + 失败截图 + trace
  playwright-report/    HTML 报告
```

- `results-summary.json`、`report.md` 永远只反映**最近一次**执行，不会把上一次的
  截图、trace、JSON 混进来。历史上正是旧 trace 残留导致
  `browserContext.close ENOENT`，所以不要手动把旧附件拷回 `test-results/`。
- 历史批次保留最近 `attempts.keep` 个（默认 10），更早的自动清理。
- 需要复现某次失败时，直接打开那一批的 `attempt.json` 与 `playwright-report/`。

---

## 7. 失败分类

执行结束后先分类，再决定怎么向用户汇报。

| 现象 | 分类 | 处理 |
| --- | --- | --- |
| `run.mjs` 返回 `ok: false` | 基础设施失败 | 按 `hint` 修复后重跑，**不写进报告** |
| `counts.failed > 0` | 真实测试失败 | 正常出报告，逐条分析 |
| `counts.skipped > 0` | 用例被跳过 | 查明原因（通常是 `test.skip` 条件），在报告里说明 |
| `counts.flaky > 0` | 不稳定用例 | 报告里标为不稳定，并提示需要治理 |
| `notAutomated` 非空 | 覆盖缺口 | 在报告和答复里**主动**说明原因 |
| `notExecuted` 非空 | 本次未执行（筛选） | 说明是 `--grep`/`--project` 造成的执行范围，不是缺口 |
| 失败停在「等待…」步骤 | 异步任务未完成 | 看步骤时间线的状态变化；仍在 Queued 就调大 `asyncTasks.completionTimeout` |

### 判断失败是产品缺陷还是用例问题

看到失败先问三个问题：

1. 截图里页面是什么状态？和预期差在哪？
2. `console.json` / trace 里有没有 JS 报错或接口 4xx/5xx？
3. 换个定位器或加一个显式等待后是否就通过了？

如果第 3 条成立，多半是用例写得不稳，应该修用例（改用语义定位器、等待真实状态），
而不是放宽断言。**不要把产品缺陷通过改断言「修」掉。**

---

## 8. 产物清单

一次完整运行后，`<runDir>/` 下会有：

```
plan.md                 已确认的测试计划
cases.json              解析后的用例
e2e.config.json         本次运行的配置快照（凭据已脱敏）
explore/                探索产物（截图、语义树、定位器候选、登录成功信号）
specs/*.spec.ts         固化后的用例
playwright.config.ts    自动生成
attempts/               每次执行一个批次目录（附件只属于该批次）
  attempt-<时间戳>/
    attempt.json        批次元信息
    test-results/       JSON 结果 + 失败截图 + trace + 步骤时间线
    playwright-report/  HTML 报告（打开 index.html）
results-summary.json    最近一次执行的归一化结果
report.md               最终测试报告
```
