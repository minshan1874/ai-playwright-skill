/**
 * Generation of `_auth.setup.ts` — the Playwright setup project that logs in once
 * and persists `storageState` for the browser projects.
 *
 * Login forms come in two shapes and both must work:
 *
 *   1. single page   — account and password side by side
 *   2. multi-step    — account -> Continue -> password -> submit
 *
 * The second shape is what makes a hard-coded "fill both fields" script fail, so
 * the flow is expressed as an explicit step list. `auth.continueSelector` is the
 * shorthand for the common case; `auth.steps` is the full escape hatch, and both
 * compile down to the same generated code.
 *
 * Credentials are referenced through the `USERNAME`/`PASSWORD` constants, which
 * read from the environment. A value that happens to equal a configured credential
 * is replaced by the constant rather than emitted literally, so no generated file
 * ever contains a secret.
 */

import { locatorToCode, validateStep } from './steps.mjs';

/** Render a JS string literal safely. */
const lit = (value) => JSON.stringify(String(value ?? ''));

/** Locator used when the account field has no explicit selector. */
export const DEFAULT_USERNAME_LOCATOR = `page
    .getByLabel(/用户名|账号|帐号|邮箱|手机号|username|email|account/i)
    .or(page.locator('input[type="text"], input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i]'))
    .first()`;

/** Locator used when the password field has no explicit selector. */
export const DEFAULT_PASSWORD_LOCATOR = `page.locator('input[type="password"]').first()`;

/** Locator used when the submit button has no explicit selector. */
export const DEFAULT_SUBMIT_LOCATOR = `page
    .getByRole('button', { name: /登录|登陆|登入|立即登录|sign in|log in|submit/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'))
    .first()`;

/** Placeholders that mean "inject the configured credential". */
const USERNAME_PLACEHOLDERS = new Set(['${E2E_USERNAME}', '$E2E_USERNAME', '{{username}}', '{{USERNAME}}', '<username>']);
const PASSWORD_PLACEHOLDERS = new Set(['${E2E_PASSWORD}', '$E2E_PASSWORD', '{{password}}', '{{PASSWORD}}', '<password>']);

/**
 * Wrap a configured CSS selector as a locator spec, falling back to a heuristic
 * expression when nothing was configured.
 * @param {unknown} selector
 * @param {string} fallback raw `page.`-relative expression
 * @returns {string|{by: string, value: string}}
 */
function selectorOr(selector, fallback) {
  const value = String(selector ?? '').trim();
  return value === '' ? fallback : { by: 'css', value };
}

/** Give a step a readable title for reports. */
function defaultName(step, index) {
  const names = {
    goto: '打开页面',
    click: '点击',
    fill: '填写',
    press: '按键',
    selectOption: '选择',
    check: '勾选',
    uncheck: '取消勾选',
    hover: '悬停',
    waitFor: '等待元素',
    waitForLoadState: '等待加载',
    waitForTimeout: '固定等待',
    screenshot: '截图',
  };
  return `${names[step.action] ?? step.action} ${index + 1}`;
}

/**
 * Build the ordered login steps for a run.
 *
 * @param {Record<string, any>} config
 * @returns {object[]}
 */
export function buildLoginSteps(config) {
  const auth = config.auth ?? {};

  // An explicit step list wins outright: it is the only form that can express
  // flows the shorthand does not cover (captcha prompts, SSO buttons, 2FA).
  if (Array.isArray(auth.steps) && auth.steps.length > 0) {
    return auth.steps.map((step, index) => ({ ...step, name: step.name ?? defaultName(step, index) }));
  }

  const steps = [];
  const loginUrl = String(auth.loginUrl ?? '').trim();
  if (loginUrl !== '') steps.push({ action: 'goto', url: loginUrl, name: '打开登录页' });

  const usernameLocator = selectorOr(auth.usernameSelector, DEFAULT_USERNAME_LOCATOR);
  steps.push({ action: 'waitFor', locator: usernameLocator, state: 'visible', name: '等待账号输入框' });
  steps.push({ action: 'fill', locator: usernameLocator, value: '${E2E_USERNAME}', name: '填写账号' });

  // The intermediate "Continue" click is what separates a two-step login from a
  // single-page one. Absent the selector, no such step is emitted.
  const continueSelector = String(auth.continueSelector ?? '').trim();
  if (continueSelector !== '') {
    steps.push({ action: 'click', locator: { by: 'css', value: continueSelector }, name: '点击继续' });
  }

  const passwordLocator = selectorOr(auth.passwordSelector, DEFAULT_PASSWORD_LOCATOR);
  steps.push({
    action: 'waitFor',
    locator: passwordLocator,
    state: 'visible',
    name: '等待密码输入框',
    // A password box that never shows up after the account step is the signature
    // of a multi-step form configured as if it were a single-page one.
    hint:
      continueSelector === ''
        ? '如果登录是「账号 -> 继续 -> 密码」两步流程，请配置 auth.continueSelector 指向「继续」按钮。'
        : '请检查 auth.continueSelector 是否真的推进到了密码步骤，或改用 auth.steps 自定义流程。',
  });
  steps.push({ action: 'fill', locator: passwordLocator, value: '${E2E_PASSWORD}', name: '填写密码' });

  steps.push({
    action: 'click',
    locator: selectorOr(auth.submitSelector, DEFAULT_SUBMIT_LOCATOR),
    name: '提交登录',
  });

  return steps;
}

/**
 * Render one step as TypeScript inside a `setup.step(...)` block.
 * @param {object} step
 * @param {{timeoutMs: number, timeoutName: string}} options
 * @returns {string}
 */
function renderStep(step, options) {
  const timeout = `{ timeout: ${options.timeoutName} }`;
  const locator = step.locator === undefined ? null : locatorToCode(step.locator);
  const value = step.value === undefined ? '' : String(step.value);

  switch (step.action) {
    case 'goto':
      return `await page.goto(${lit(step.url ?? '')}, { waitUntil: 'domcontentloaded', timeout: ${options.timeoutName} });`;
    case 'click':
      return `await ${locator}.click(${timeout});`;
    case 'fill':
      return `await ${locator}.fill(${step.valueExpr ?? lit(value)}, ${timeout});`;
    case 'press':
      return `await ${locator}.press(${lit(step.key ?? 'Enter')}, ${timeout});`;
    case 'selectOption':
      return `await ${locator}.selectOption(${step.valueExpr ?? lit(value)}, ${timeout});`;
    case 'check':
      return `await ${locator}.check(${timeout});`;
    case 'uncheck':
      return `await ${locator}.uncheck(${timeout});`;
    case 'hover':
      return `await ${locator}.hover(${timeout});`;
    case 'waitFor':
      return `await ${locator}.waitFor({ state: ${lit(step.state ?? 'visible')}, timeout: ${options.timeoutName} });`;
    case 'waitForLoadState':
      return `await page.waitForLoadState(${lit(step.state ?? 'networkidle')});`;
    case 'waitForTimeout':
      return `await page.waitForTimeout(${Number(step.ms ?? 500)});`;
    case 'screenshot':
      return `await page.screenshot({ path: testInfo.outputPath(${lit(`login-${step.name ?? 'step'}.png`)}), fullPage: true });`;
    default:
      return `// 未支持的动作：${step.action}`;
  }
}

/**
 * Render `_auth.setup.ts`.
 *
 * @param {{
 *   config: Record<string, any>,
 *   steps: object[],
 *   storageStatePath: string,
 *   loginUrl?: string,
 * }} input
 * @returns {string}
 */
export function renderAuthSetup({ config, steps, storageStatePath }) {
  const auth = config.auth ?? {};
  const submitTimeout = Number(config.asyncTasks?.submitTimeout ?? 30000);
  const successUrl = String(auth.successUrl ?? '').trim();
  const successSelector = String(auth.successSelector ?? '').trim();

  const problems = [];
  steps.forEach((step, index) => {
    const problem = validateStep(step, index);
    if (problem !== null) problems.push(problem);
  });
  if (problems.length > 0) {
    throw new Error(`登录步骤配置有误：${problems.join(' ')}`);
  }

  // Any step that injects a credential makes the environment variables required.
  let needsCredentials = false;
  const prepared = steps.map((step) => {
    if (typeof step.value !== 'string') return step;
    const value = step.value;
    const isUsername =
      USERNAME_PLACEHOLDERS.has(value) || (config.auth?.username !== undefined && value !== '' && value === config.auth.username);
    const isPassword =
      PASSWORD_PLACEHOLDERS.has(value) || (config.auth?.password !== undefined && value !== '' && value === config.auth.password);
    if (isUsername) needsCredentials = true;
    if (isPassword) needsCredentials = true;
    return { ...step, valueExpr: isUsername ? 'USERNAME' : isPassword ? 'PASSWORD' : undefined };
  });

  // Budget the whole setup from the per-step timeout, plus room for the success
  // check, so a slow login fails with a useful message instead of Playwright's
  // generic "Test timeout of 30000ms exceeded".
  const successTimeout = Math.max(submitTimeout, 15000);
  const loginTimeout = submitTimeout * prepared.length + successTimeout + 10000;

  const stepBlocks = prepared
    .map((step, index) => {
      const title = `${index + 1}/${prepared.length} ${step.name ?? defaultName(step, index)}`;
      const body = renderStep(step, { timeoutMs: submitTimeout, timeoutName: 'SUBMIT_TIMEOUT' });
      const hint = typeof step.hint === 'string' && step.hint !== '' ? `\n    // 提示：${step.hint}` : '';
      return `  await setup.step(${lit(title)}, async () => {${hint}\n    ${body}\n  });`;
    })
    .join('\n\n');

  const successChecks = [];
  if (successUrl !== '') {
    successChecks.push(`  await page.waitForURL(new RegExp(${lit(successUrl)}), { timeout: SUCCESS_TIMEOUT });`);
  }
  if (successSelector !== '') {
    successChecks.push(
      `  await expect(page.locator(${lit(successSelector)}).first()).toBeVisible({ timeout: SUCCESS_TIMEOUT });`,
    );
  }
  if (successChecks.length === 0) {
    // No configured signal: wait for quiet, but never fail the login over it.
    successChecks.push(`  await page.waitForLoadState('networkidle', { timeout: SUCCESS_TIMEOUT }).catch(() => {});`);
  }

  const guard = needsCredentials
    ? `  if (USERNAME === '' || PASSWORD === '') {
    throw new Error('缺少登录凭据：请设置环境变量 E2E_USERNAME 与 E2E_PASSWORD（或在 e2e.config.json 的 auth 中直接填写）。');
  }

`
    : '';

  const successHint = [
    successUrl === '' ? '' : `auth.successUrl=${successUrl}`,
    successSelector === '' ? '' : `auth.successSelector=${successSelector}`,
  ]
    .filter(Boolean)
    .join(' 与 ');

  return `// 由 playwright-e2e skill 自动生成，请勿手工修改（每次执行都会覆盖）。
// 账号密码从环境变量读取，不会写入磁盘。
import { test as setup, expect } from '@playwright/test';

const USERNAME = process.env.E2E_USERNAME ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const STORAGE_STATE = ${lit(storageStatePath)};
const SUBMIT_TIMEOUT = ${submitTimeout};
const SUCCESS_TIMEOUT = ${successTimeout};

setup('登录并保存登录态', async ({ page }, testInfo) => {
  setup.setTimeout(${loginTimeout});

${guard}${stepBlocks}

  try {
${successChecks.map((line) => `  ${line}`).join('\n')}
  } catch (error) {
    throw new Error(
      '登录似乎没有成功：${successHint === '' ? '等待页面稳定' : `等待 ${successHint}`}超时。' +
        '请检查 auth 配置与登录步骤，或先手工登录导出 storageState（见 references/workflow.md）。' +
        \`\\n原始错误：\${error instanceof Error ? error.message : String(error)}\`,
    );
  }

  await page.context().storageState({ path: STORAGE_STATE });
  console.log(\`登录态已保存到 \${STORAGE_STATE}\`);
});
`;
}
