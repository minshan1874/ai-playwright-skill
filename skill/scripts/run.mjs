#!/usr/bin/env node
/**
 * Execution phase: generate the Playwright config + fixtures, run the suite, and
 * normalize the JSON reporter output.
 *
 * Refuses to run unless `plan.md` carries `状态: 已确认`, which is the mechanical
 * half of the "wait for the user" gate.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildConfig, effectiveBaseURL } from './lib/config.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import { PLAN_STATUS, readPlanStatus } from './lib/plan.mjs';
import { runPaths, resolveHome } from './lib/paths.mjs';
import { renderPlaywrightConfig } from './lib/playwright-config.mjs';
import { normalizeResults, verdictFor } from './lib/results.mjs';
import { resolvePlaywrightCli, runCommand } from './lib/toolchain.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'run' });

/** Render a JS string literal safely. */
const lit = (value) => JSON.stringify(String(value ?? ''));

/**
 * Generate `specs/_fixtures.ts` with the helpers specs are expected to use.
 * @param {ReturnType<typeof runPaths>} paths
 * @returns {string}
 */
function writeFixtures(paths) {
  const content = `// 由 playwright-e2e skill 自动生成，请勿手工修改。
import { test, expect, type Page } from '@playwright/test';

export { test, expect };

/** Turn a step title into a safe file name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'step';
}

/**
 * Run one documented step. Logs progress and captures a screenshot on failure so
 * the report can point at the exact step that broke.
 */
export async function step(page: Page, title: string, body: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    await body();
    console.log(\`  ✓ \${title} (\${Date.now() - started}ms)\`);
  } catch (error) {
    console.log(\`  ✗ \${title} (\${Date.now() - started}ms)\`);
    await page
      .screenshot({ path: test.info().outputPath(\`failure-\${slugify(title)}.png\`), fullPage: true })
      .catch(() => {});
    throw error;
  }
}

/** Assert a visible text is present, with a message that names the expectation. */
export async function expectVisibleText(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}
`;
  fs.mkdirSync(paths.specs, { recursive: true });
  fs.writeFileSync(paths.fixtures, content);
  return paths.fixtures;
}

/**
 * Generate `specs/_auth.setup.ts`, a Playwright setup project that logs in once
 * and persists `storageState` for every other project.
 *
 * Credentials are read from the environment, never written into this file.
 *
 * @param {ReturnType<typeof runPaths>} paths
 * @param {object} config
 * @param {string} authStatePath
 * @returns {string}
 */
function writeAuthSetup(paths, config, authStatePath) {
  const loginUrl = String(config.auth.loginUrl ?? '');
  const usernameSelector = String(config.auth.usernameSelector ?? '').trim();
  const passwordSelector = String(config.auth.passwordSelector ?? '').trim();
  const submitSelector = String(config.auth.submitSelector ?? '').trim();
  const successUrl = String(config.auth.successUrl ?? '').trim();

  const usernameLocator = usernameSelector
    ? `page.locator(${lit(usernameSelector)}).first()`
    : `page
    .getByLabel(/用户名|账号|帐号|邮箱|手机号|username|email|account/i)
    .or(page.locator('input[type="text"], input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i]'))
    .first()`;

  const passwordLocator = passwordSelector
    ? `page.locator(${lit(passwordSelector)}).first()`
    : `page.locator('input[type="password"]').first()`;

  const submitLocator = submitSelector
    ? `page.locator(${lit(submitSelector)}).first()`
    : `page
    .getByRole('button', { name: /登录|登陆|登入|立即登录|sign in|log in|submit/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'))
    .first()`;

  const waitForSuccess = successUrl
    ? `await page.waitForURL(new RegExp(${lit(successUrl)}), { timeout: 15000 });`
    : `await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});`;

  const content = `// 由 playwright-e2e skill 自动生成，请勿手工修改。
// 账号密码从环境变量读取，不会写入磁盘。
import { test as setup } from '@playwright/test';

const USERNAME = process.env.E2E_USERNAME ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const STORAGE_STATE = ${lit(authStatePath)};

setup('登录并保存登录态', async ({ page }) => {
  if (USERNAME === '' || PASSWORD === '') {
    throw new Error('缺少登录凭据：请设置环境变量 E2E_USERNAME 与 E2E_PASSWORD。');
  }

  await page.goto(${lit(loginUrl)}, { waitUntil: 'domcontentloaded' });

  const usernameField = ${usernameLocator};
  await usernameField.waitFor({ state: 'visible', timeout: 15000 });
  await usernameField.fill(USERNAME);

  const passwordField = ${passwordLocator};
  await passwordField.waitFor({ state: 'visible', timeout: 15000 });
  await passwordField.fill(PASSWORD);

  await ${submitLocator}.click();
  ${waitForSuccess}

  await page.context().storageState({ path: STORAGE_STATE });
  console.log(\`登录态已保存到 \${STORAGE_STATE}\`);
});
`;

  fs.mkdirSync(paths.specs, { recursive: true });
  const file = path.join(paths.specs, '_auth.setup.ts');
  fs.writeFileSync(file, content);
  return file;
}

/**
 * List generated spec files.
 * @param {string} specsDir
 * @returns {string[]}
 */
function listSpecs(specsDir) {
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir)
    .filter((name) => /\.(spec|test)\.(ts|js|mts|mjs|cts|cjs)$/.test(name))
    .sort();
}

async function main() {
  const runDir = typeof flags['run-dir'] === 'string' ? path.resolve(flags['run-dir']) : null;
  if (runDir === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --run-dir 参数',
        hint: '用法：node run.mjs --run-dir <运行目录> [--config e2e.config.json] [--grep <模式>]',
      }),
    );
  }

  const paths = runPaths(runDir);
  const skipPlanCheck = flags['skip-plan-check'] === true;

  // --- The confirmation gate ------------------------------------------------
  if (!skipPlanCheck) {
    const plan = readPlanStatus(paths.plan);
    if (!plan.exists) {
      process.exit(
        reporter.finish({
          ok: false,
          error: `找不到测试计划：${paths.plan}`,
          hint: '请先生成测试计划并让用户确认，再执行测试。',
        }),
      );
    }
    if (plan.status !== PLAN_STATUS.confirmed) {
      process.exit(
        reporter.finish({
          ok: false,
          error: '测试计划尚未确认，拒绝执行。',
          hint:
            `当前状态：${plan.status ?? '未标注'}。请把计划展示给用户，等待用户明确确认后，` +
            `运行 node confirm-plan.mjs --plan "${paths.plan}" 再执行。`,
        }),
      );
    }
  }

  // --- Config ---------------------------------------------------------------
  const configFlags = { ...flags };
  if (configFlags.config === undefined && fs.existsSync(paths.config)) {
    configFlags.config = paths.config;
  }
  const { config, warnings, problems } = buildConfig({ flags: configFlags });
  if (problems.length > 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `配置有问题：${problems.join(' ')}`,
        hint: '请修正配置文件后重试。',
      }),
    );
  }
  for (const warning of warnings) reporter.note(`⚠️  ${warning}`);

  // Snapshot the effective config next to the run, minus credentials.
  const snapshot = JSON.parse(JSON.stringify(config));
  if (snapshot.auth) {
    snapshot.auth.username = snapshot.auth.username ? '<已提供>' : '';
    snapshot.auth.password = snapshot.auth.password ? '<已提供>' : '';
  }
  fs.writeFileSync(paths.config, `${JSON.stringify(snapshot, null, 2)}\n`);

  const home = resolveHome(process.env);

  // --- Toolchain ------------------------------------------------------------
  const cli = resolvePlaywrightCli(home);
  if (cli === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `未找到 Playwright，运行目录 ${home} 尚未安装依赖。`,
        hint: '请先运行：node scripts/bootstrap.mjs',
      }),
    );
  }

  // --- Generated scaffolding ------------------------------------------------
  const authEnabled = Boolean(config.auth?.enabled);
  const authStatePath = authEnabled
    ? config.auth.storageState
      ? path.resolve(config.auth.storageState)
      : path.join(home, 'auth', `${path.basename(runDir).replace(/-\d{8}-\d{6}$/, '')}.json`)
    : null;

  const needsAuthSetup =
    authEnabled && (config.auth.saveAfterLogin !== false) &&
    (authStatePath === null || !fs.existsSync(authStatePath));

  if (authEnabled && authStatePath !== null) fs.mkdirSync(path.dirname(authStatePath), { recursive: true });

  writeFixtures(paths);
  const hasAuthSetup = authEnabled && needsAuthSetup;
  if (hasAuthSetup) writeAuthSetup(paths, config, authStatePath);
  fs.writeFileSync(
    paths.playwrightConfig,
    renderPlaywrightConfig({ paths, config, authStatePath, hasAuthSetup }),
  );

  const specs = listSpecs(paths.specs);
  if (specs.length === 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `没有找到任何用例文件：${paths.specs}`,
        hint:
          '请先根据测试计划与探索结果生成 .spec.ts 用例文件，' +
          '可参考 skill 的 assets/spec.template.ts 与 references/locator-guide.md。',
      }),
    );
  }

  // --- Execute --------------------------------------------------------------
  const extraArgs = [`--config=${paths.playwrightConfig}`];
  if (typeof flags.grep === 'string') extraArgs.push('--grep', flags.grep);
  if (typeof flags.project === 'string') extraArgs.push('--project', flags.project);

  const childEnv = { ...process.env };
  // Keep terminal color codes out of the JSON reporter's error strings.
  childEnv.NO_COLOR = '1';
  childEnv.FORCE_COLOR = '0';
  if (authEnabled) {
    // Pass credentials through the environment so they never touch disk.
    if (config.auth.username) childEnv.E2E_USERNAME = String(config.auth.username);
    if (config.auth.password) childEnv.E2E_PASSWORD = String(config.auth.password);
  }

  reporter.note(`执行 ${specs.length} 个用例文件，浏览器：${config.browsers.join(', ')} …`);
  reporter.note('');

  const execution = await runCommand(process.execPath, [cli, 'test', ...extraArgs], {
    cwd: runDir,
    env: childEnv,
    onLine: (line) => reporter.note(line),
  });

  // --- Normalize ------------------------------------------------------------
  if (!fs.existsSync(paths.jsonResults)) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '测试未产生 JSON 结果文件，说明执行在用例开始前就失败了。',
        hint:
          '常见原因：浏览器未安装、配置文件错误、TypeScript 编译失败。' +
          `原始输出末尾：\n${(execution.stderr || execution.stdout).split('\n').slice(-15).join('\n')}`,
      }),
    );
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(paths.jsonResults, 'utf8'));
  } catch (error) {
    process.exit(
      reporter.finish({ ok: false, error: `结果文件不是合法 JSON：${error.message}`, hint: '请把此问题反馈给 skill 维护者。' }),
    );
  }

  let cases = [];
  if (fs.existsSync(paths.cases)) {
    try {
      cases = JSON.parse(fs.readFileSync(paths.cases, 'utf8')).cases ?? [];
    } catch {
      reporter.note('⚠️  cases.json 无法解析，覆盖率统计将不可用。');
    }
  }

  const summary = normalizeResults(report, { cases });
  const verdict = verdictFor(summary, { cases });

  // A silently mis-placed HTML report is easy to miss, so verify it explicitly.
  const htmlIndex = path.join(paths.htmlReport, 'index.html');
  const htmlReportWritten = fs.existsSync(htmlIndex);
  if (!htmlReportWritten) {
    reporter.note(`⚠️  未在预期位置找到 HTML 报告：${htmlIndex}`);
  }

  const payload = {
    ...summary,
    verdict,
    runDir,
    baseURL: effectiveBaseURL(config),
    browsers: config.browsers,
    specs: specs.map((name) => path.join(paths.specs, name)),
    exitCode: execution.code,
    artifacts: {
      htmlReport: paths.htmlReport,
      htmlReportIndex: htmlReportWritten ? htmlIndex : null,
      jsonResults: paths.jsonResults,
      testResults: paths.testResults,
      summary: paths.summary,
    },
  };
  fs.writeFileSync(paths.summary, `${JSON.stringify(payload, null, 2)}\n`);

  reporter.note('');
  reporter.note(`${verdict.label}  通过 ${summary.counts.passed} / 失败 ${summary.counts.failed} / 跳过 ${summary.counts.skipped} / 未自动化 ${summary.notAutomated.length}`);
  for (const reason of verdict.reasons) reporter.note(`  · ${reason}`);
  if (summary.counts.failed > 0) {
    reporter.note('');
    reporter.note('失败用例：');
    for (const test of summary.tests.filter((t) => t.status === 'failed').slice(0, 10)) {
      reporter.note(`  ❌ ${test.caseId ?? '?'} ${test.title}`);
    }
  }
  reporter.note('');
  reporter.note(`HTML 报告：${paths.htmlReport}`);

  // A test failure is a valid, reportable outcome — not a script failure. Only
  // infrastructure problems make this script itself fail.
  process.exit(
    reporter.finish({
      ok: summary.infrastructureErrors.length === 0 && summary.counts.total > 0,
      runDir,
      baseURL: effectiveBaseURL(config),
      browsers: config.browsers,
      counts: summary.counts,
      passRate: summary.passRate,
      verdict,
      notAutomated: summary.notAutomated,
      unmatchedTests: summary.unmatchedTests,
      infrastructureErrors: summary.infrastructureErrors,
      failures: summary.tests
        .filter((test) => test.status === 'failed')
        .map((test) => ({ caseId: test.caseId, title: test.title, error: test.error.split('\n').slice(0, 3).join('\n') })),
      artifacts: payload.artifacts,
      summary: paths.summary,
    }),
  );
}

main().catch((error) => {
  process.exit(
    reporter.finish({
      ok: false,
      error: error?.message ?? String(error),
      hint: '执行阶段发生未预期错误，请检查运行目录与配置。',
    }),
  );
});
