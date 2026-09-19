/**
 * 用例骨架模板。
 *
 * 复制到 <runDir>/specs/<模块>.spec.ts 后按用例表填写。
 * 编写规范见 references/locator-guide.md。
 */

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

    await step(page, '验证跳转并显示用户信息', async () => {
      await expect(page).toHaveURL(/dashboard/);
      await expect(page.getByText('欢迎回来')).toBeVisible();
    });
  },
);

// 同模块的后续用例继续往下写。
// 注意：每个 test() 必须能独立运行，不要依赖前一个用例留下的状态。
