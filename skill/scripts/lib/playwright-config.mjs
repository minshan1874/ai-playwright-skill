/**
 * Generation of `playwright.config.ts`.
 *
 * Kept as a pure string function so the generated config — in particular the
 * reporter option names, which Playwright silently ignores when misspelled — is
 * covered by unit tests instead of only by running a browser.
 */

import { effectiveBaseURL } from './config.mjs';

/** Render a JS string literal safely. */
const lit = (value) => JSON.stringify(String(value ?? ''));

/**
 * Build the contents of `playwright.config.ts`.
 *
 * The per-test timeout is deliberately left at the configured value: an async
 * product task can take minutes, but inflating every test's budget would also
 * make every genuine hang take minutes to fail. `waitForAsyncTask` in the
 * generated fixtures extends the budget of the test that actually needs it.
 *
 * @param {{
 *   paths: {specs: string, testResults: string, jsonResults: string, htmlReport: string},
 *   config: Record<string, any>,
 *   authStatePath: string|null,
 *   hasAuthSetup: boolean,
 * }} input
 * @returns {string}
 */
export function renderPlaywrightConfig({ paths, config, authStatePath, hasAuthSetup }) {
  const projects = [];
  if (hasAuthSetup) {
    // The setup project must NOT start from the state it is about to write: a
    // stale (or half-expired) session would redirect away from the login form.
    projects.push(`    {
      name: 'setup',
      testMatch: /_auth\\.setup\\.ts/,
    },`);
  }
  for (const browser of config.browsers) {
    // storageState belongs to the browser projects. Setting it globally would
    // also apply it to the setup project; omitting it entirely (as an earlier
    // version did whenever a setup project existed) meant a freshly logged-in
    // session was saved and then never used.
    const use = [`browserName: ${lit(browser)}`];
    if (authStatePath !== null) use.push(`storageState: ${lit(authStatePath)}`);
    projects.push(`    {
      name: ${lit(browser)},
      use: { ${use.join(', ')} },${hasAuthSetup ? `\n      dependencies: ['setup'],` : ''}
    },`);
  }

  const use = [
    `    baseURL: ${lit(effectiveBaseURL(config))},`,
    `    headless: ${config.headless},`,
    `    viewport: { width: ${Number(config.viewport.width)}, height: ${Number(config.viewport.height)} },`,
    `    locale: ${lit(config.locale)},`,
    `    timezoneId: ${lit(config.timezoneId)},`,
    `    ignoreHTTPSErrors: ${config.ignoreHTTPSErrors},`,
    `    trace: ${lit(config.trace)},`,
    `    screenshot: ${lit(config.screenshot)},`,
    `    video: ${lit(config.video)},`,
    `    testIdAttribute: 'data-testid',`,
  ];

  const asyncNote =
    `  // 异步任务（文生图、导出等）用 _fixtures.ts 的 waitForAsyncTask 等待：\n` +
    `  // 它会为该用例单独放宽超时（提交 ${Number(config.asyncTasks?.submitTimeout ?? 0)}ms / ` +
    `完成 ${Number(config.asyncTasks?.completionTimeout ?? 0)}ms），\n` +
    `  // 因此这里的 timeout 不需要按最慢的异步任务设置。\n`;

  return `// 由 playwright-e2e skill 自动生成，请勿手工修改（每次执行都会覆盖）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: ${lit(paths.specs)},
  outputDir: ${lit(paths.testResults)},
${asyncNote}  timeout: ${Number(config.timeout)},
  expect: { timeout: ${Number(config.expectTimeout)} },
  fullyParallel: false,
  workers: ${Number(config.workers)},
  retries: ${Number(config.retries)},
  forbidOnly: false,
  reporter: [
    ['list'],
    ['json', { outputFile: ${lit(paths.jsonResults)} }],
    // The HTML reporter's option is \`outputFolder\`; \`outputDir\` is silently
    // ignored and the report then lands in an unexpected directory.
    ['html', { outputFolder: ${lit(paths.htmlReport)}, open: 'never' }],
  ],
  use: {
${use.join('\n')}
  },
  projects: [
${projects.join('\n')}
  ],
});
`;
}
