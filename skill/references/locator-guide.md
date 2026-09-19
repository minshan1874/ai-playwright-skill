# 定位器与用例编写规范

写 `.spec.ts` 之前读这一篇。目标是让用例在页面改版后仍然能跑，而不是「今天能过」。

---

## 1. 定位器优先级

从高到低。除非有理由，永远用能用的最高优先级。

| 优先级 | 定位器 | 什么时候用 |
| --- | --- | --- |
| 1 | `getByTestId('submit')` | 页面有 `data-testid`。最稳，不随文案和结构变 |
| 2 | `getByRole('button', { name: '登录' })` | 默认选择。角色 + 可访问名就是用户看到的东西 |
| 3 | `getByLabel('用户名')` | 表单字段。`label` 关联是标准做法 |
| 4 | `getByPlaceholder('请输入手机号')` | 没有 label 的表单字段 |
| 5 | `getByText('订单已提交')` | 验证文案、点击链接/按钮 |
| 6 | `getByTitle(...)` / `getByAltText(...)` | 图标按钮、图片 |
| 7 | `locator('.btn-primary')` | **最后手段**。样式类名会变 |
| 8 | `locator('div > div:nth-child(3) > span')` | **不要用**。结构一变就废 |

`explore.mjs` 生成的 `outline.md` 已经按这个顺序给出推荐定位器，直接用。

### 常见角色对照

| 元素 | 角色 |
| --- | --- |
| `<button>`、`<input type="submit">` | `button` |
| `<a href>` | `link` |
| `<input type="text">` | `textbox` |
| `<input type="checkbox">` | `checkbox` |
| `<select>` | `combobox` |
| `<textarea>` | `textbox` |
| `<h1>`–`<h6>` | `heading`（`level` 可指定） |
| `<table>` | `table` |

### 名字匹配

名字默认是**不区分大小写、忽略首尾空格的全串匹配**。部分匹配要显式用正则：

```ts
await page.getByRole('button', { name: '登录' }).click();        // 精确
await page.getByRole('button', { name: /登录|登陆/ }).click();    // 正则
```

同一文案有多个元素时，先想办法用更精确的名字，而不是无脑加 `.first()`：

```ts
// 差：页面有两个「删除」，可能点到错的
await page.getByRole('button', { name: '删除' }).first().click();

// 好：限定在对应行内
const row = page.getByRole('row', { name: /订单 2024001/ });
await row.getByRole('button', { name: '删除' }).click();
```

---

## 2. 等待：不要用 waitForTimeout

Playwright 的定位器自带自动等待 —— 元素出现、可见、可交互、稳定后才会操作。
断言也是自动重试的。**加固定等待只会让测试变慢且照样不稳。**

```ts
// 禁止
await page.waitForTimeout(3000);
await page.getByRole('button', { name: '提交' }).click();

// 正确：定位器自己会等
await page.getByRole('button', { name: '提交' }).click();
```

需要等某个状态时，等那个状态本身：

```ts
// 等接口回来导致的列表刷新
await expect(page.getByRole('row')).toHaveCount(10);

// 等跳转
await expect(page).toHaveURL(/\/dashboard/);

// 等元素消失（loading 遮罩）
await expect(page.getByTestId('loading')).toBeHidden();

// 等网络静默（只在确实没有可观测 UI 状态时用）
await page.waitForLoadState('networkidle');
```

`explore.mjs` 的步骤文件里允许 `waitForTimeout`（探索是一次性的），
但**固化到 `.spec.ts` 时必须换成状态等待**。

---

## 3. 用例骨架

```ts
import { test, expect, step } from './_fixtures';

test(
  '[TC-001] 正确账号密码登录成功',
  {
    annotation: [
      { type: 'caseId', description: 'TC-001' },
      { type: 'priority', description: 'P0' },
      { type: 'module', description: '登录' },
    ],
    tag: ['@P0', '@smoke'],
  },
  async ({ page }) => {
    await step(page, '打开登录页', async () => {
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    });

    await step(page, '输入账号密码并提交', async () => {
      await page.getByLabel('用户名').fill('admin');
      await page.getByLabel('密码').fill('123456');
      await page.getByRole('button', { name: '登录' }).click();
    });

    await step(page, '验证跳转到首页并显示昵称', async () => {
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByText('管理员')).toBeVisible();
    });
  },
);
```

### 必须遵守的三条

1. **标题以 `[用例ID]` 开头。** 报告靠它把结果关联回用例表；annotation 缺失时这是唯一的兜底。
2. **带 `caseId` annotation。** 优先于标题解析。
3. **每一步用 `step()` 包起来。** 失败时会自动截图并打印是第几步挂的，
   报告里的失败定位会精确到步骤。

### 测试数据

用例表里的「测试数据」列解析在 `cases.json` 的 `data` 字段。需要在 spec 里读取时：

```ts
import cases from '../cases.json';

const testCase = cases.cases.find((item) => item.id === 'TC-001')!;
const username = testCase.data['用户名'] ?? 'admin';
```

也可以在 spec 里直接写死 —— 只有在数据需要和用例表保持同步时才读 `cases.json`。

---

## 4. 断言写什么

断言是测试的价值所在。**没有断言的用例等于没测。**

| 想验证 | 写法 |
| --- | --- |
| 元素可见 | `await expect(locator).toBeVisible()` |
| 元素不存在 | `await expect(locator).toHaveCount(0)` |
| 文本内容 | `await expect(locator).toHaveText('订单已提交')` |
| 包含文本 | `await expect(locator).toContainText('成功')` |
| 输入框的值 | `await expect(locator).toHaveValue('admin')` |
| 跳转 | `await expect(page).toHaveURL(/\/orders/)` |
| 页面标题 | `await expect(page).toHaveTitle(/订单/)` |
| 元素数量 | `await expect(page.getByRole('row')).toHaveCount(10)` |
| 元素可用 | `await expect(locator).toBeEnabled()` |

「预期结果」列里的每一条都要有对应断言。用例表写了 3 条预期、spec 只断言了 1 条，
等于漏测 —— 这是常见错误，写完对照检查一遍。

---

## 5. 独立性

每个 `test()` 必须能单独运行。

- 不要依赖前一个用例留下的状态。需要前置数据就在用例内创建，或用 API 准备。
- 不要用 `test.describe.serial` 把独立用例串起来 —— 一条失败会连累后面全部跳过。
- 用例之间共享的只有登录态（`storageState`），不共享业务数据。

---

## 6. 无法自动化的用例

以下情况**不要**编造假用例：

- 图形验证码、短信/邮件验证码
- 需要真实支付、真实外部系统回调
- 需要人工目视判断的视觉效果
- 需要等待长时间异步任务（超过合理超时）

处理方式：计划阶段标注，spec 里留空，报告会列为「未自动化」并说明原因。
如果只是**部分**可自动化（例如验证码用测试环境固定值绕过），就照常写，
并在计划里说明绕过方式。

真的需要显式跳过时，用注解说明原因，让它出现在报告里：

```ts
test.skip('[TC-010] 短信验证码登录', { annotation: [...] }, async () => {
  // 需要真实短信，无法自动化
});
```

---

## 7. 失败排查顺序

用例失败时按这个顺序看，别急着改断言：

1. **看截图**（`test-results/` 下，或 HTML 报告里）。页面到底是什么状态？
2. **看错误信息**。是「找不到元素」「元素不可见」「断言不匹配」还是「超时」？
3. **看 trace**。`npx playwright show-trace <文件>` 可以逐步回放，含 DOM 快照和网络。
4. **看 `console.json` / 页面报错**。有 JS 异常或接口 5xx，可能是产品缺陷。
5. **换个定位器试试**。如果语义定位器找不到，可能是页面缺可访问性标注 —— 这本身
   也是值得反馈的问题。

**判断标准**：如果是用例写得不稳（定位器太脆、等待方式不对），修用例；
如果是功能真的坏了，保留失败并在报告里如实呈现。**绝不通过放宽断言让失败变绿。**
