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
    projects.push(`    {
      name: 'setup',
      testMatch: /_auth\\.setup\\.ts/,
    },`);
  }
  for (const browser of config.browsers) {
    projects.push(`    {
      name: ${lit(browser)},
      use: { browserName: ${lit(browser)} },${hasAuthSetup ? `\n      dependencies: ['setup'],` : ''}
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
    ...(authStatePath !== null && !hasAuthSetup ? [`    storageState: ${lit(authStatePath)},`] : []),
  ];

  return `// 由 playwright-e2e skill 自动生成，请勿手工修改（每次执行都会覆盖）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: ${lit(paths.specs)},
  outputDir: ${lit(paths.testResults)},
  timeout: ${Number(config.timeout)},
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
