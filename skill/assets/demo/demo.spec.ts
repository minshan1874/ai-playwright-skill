/**
 * 演示用例：针对 assets/demo/index.html。
 *
 * 这是「固化阶段」的产物示例。TC-004 会**故意失败** —— 演示站里
 * 「加入购物车」的实现有个真实缺陷：数量被重置为 1 而不是累加。
 * TC-005 没有对应的自动化用例，用来演示「未自动化」如何在报告中呈现。
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
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    });

    await step(page, '输入正确的用户名和密码', async () => {
      await page.getByLabel('用户名').fill('admin');
      await page.getByLabel('密码').fill('123456');
    });

    await step(page, '点击登录按钮', async () => {
      await page.getByTestId('submit-login').click();
    });

    await step(page, '验证跳转到工作台并显示当前用户', async () => {
      await expect(page).toHaveURL(/#\/dashboard/);
      await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
      await expect(page.getByTestId('current-user')).toHaveText('admin');
    });
  },
);

test(
  '[TC-002] 密码错误时给出明确提示',
  {
    annotation: [
      { type: 'caseId', description: 'TC-002' },
      { type: 'priority', description: 'P1' },
      { type: 'module', description: '登录' },
    ],
    tag: ['@P1', '@regression'],
  },
  async ({ page }) => {
    await step(page, '打开登录页并输入错误密码', async () => {
      await page.goto('/');
      await page.getByLabel('用户名').fill('admin');
      await page.getByLabel('密码').fill('wrong-password');
      await page.getByTestId('submit-login').click();
    });

    await step(page, '验证停留在登录页并显示错误提示', async () => {
      await expect(page).toHaveURL(/#\/login/);
      await expect(page.getByTestId('login-error')).toHaveText('用户名或密码错误');
    });
  },
);

test(
  '[TC-003] 按关键字搜索返回匹配商品',
  {
    annotation: [
      { type: 'caseId', description: 'TC-003' },
      { type: 'priority', description: 'P0' },
      { type: 'module', description: '商品搜索' },
    ],
    tag: ['@P0', '@smoke'],
  },
  async ({ page }) => {
    await step(page, '进入商品搜索页并搜索关键字「耳机」', async () => {
      await page.goto('/#/search');
      await page.getByLabel('关键字').fill('耳机');
      await page.getByTestId('submit-search').click();
    });

    await step(page, '验证结果列表不为空', async () => {
      const rows = page.getByTestId('product-row');
      await expect(rows).not.toHaveCount(0);
    });

    await step(page, '验证每一项商品名都包含关键字', async () => {
      const names = await page.getByTestId('product-name').allInnerTexts();
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toContain('耳机');
    });
  },
);

test(
  '[TC-004] 连续加入两件商品数量正确',
  {
    annotation: [
      { type: 'caseId', description: 'TC-004' },
      { type: 'priority', description: 'P0' },
      { type: 'module', description: '购物车' },
    ],
    tag: ['@P0', '@smoke'],
  },
  async ({ page }) => {
    await step(page, '搜索出商品', async () => {
      await page.goto('/#/search');
      await page.getByLabel('关键字').fill('耳机');
      await page.getByTestId('submit-search').click();
      await expect(page.getByTestId('product-row').first()).toBeVisible();
    });

    await step(page, '对同一商品连续点击两次「加入购物车」', async () => {
      const addButton = page.getByTestId('product-row').first().getByTestId('add-to-cart');
      await addButton.click();
      await addButton.click();
    });

    await step(page, '验证购物车数量为 2', async () => {
      // 演示站的真实缺陷：数量被重置为 1，这条断言会失败。
      await expect(page.getByTestId('cart-count')).toHaveText('2');
    });
  },
);
