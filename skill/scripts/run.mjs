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

import { buildConfig, effectiveBaseURL, redactConfig, resolveAuth } from './lib/config.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import { buildLoginSteps, renderAuthSetup } from './lib/login-script.mjs';
import { PLAN_STATUS, readPlanStatus } from './lib/plan.mjs';
import {
  attemptPaths,
  nextAttemptId,
  pruneAttempts,
  resolveHome,
  runPaths,
} from './lib/paths.mjs';
import { diagnoseLaunchFailure, relevantExcerpt } from './lib/browser-errors.mjs';
import { renderPlaywrightConfig } from './lib/playwright-config.mjs';
import { normalizeResults, verdictFor } from './lib/results.mjs';
import { collectAutomatedCaseIds, listSpecFiles } from './lib/spec-index.mjs';
import { resolvePlaywrightCli, runCommand } from './lib/toolchain.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'run' });

/** Render a JS string literal safely. */
const lit = (value) => JSON.stringify(String(value ?? ''));

/**
 * Generate `specs/_fixtures.ts` with the helpers specs are expected to use.
 *
 * @param {ReturnType<typeof runPaths>} paths
 * @param {Record<string, any>} config
 * @returns {string}
 */
function writeFixtures(paths, config) {
  const asyncTasks = config.asyncTasks ?? {};
  const content = `// 由 playwright-e2e skill 自动生成，请勿手工修改。
import fs from 'node:fs/promises';

import { test, expect, type Page, type TestInfo } from '@playwright/test';

export { test, expect };

/** 异步任务预算，来自 e2e.config.json 的 asyncTasks。 */
export const ASYNC_SUBMIT_TIMEOUT = ${Number(asyncTasks.submitTimeout ?? 30000)};
export const ASYNC_COMPLETION_TIMEOUT = ${Number(asyncTasks.completionTimeout ?? 180000)};
export const ASYNC_POLL_INTERVAL = ${Number(asyncTasks.pollInterval ?? 2000)};

/** Turn a step title into a safe file name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'step';
}

type Observation = { at: number; state: string };
type TimelineEntry = {
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
  observations?: Observation[];
};

const timelines = new WeakMap<TestInfo, TimelineEntry[]>();

/** Per-test step log, attached to the report when the test ends. */
function timelineFor(info: TestInfo): TimelineEntry[] {
  let entries = timelines.get(info);
  if (entries === undefined) {
    entries = [];
    timelines.set(info, entries);
  }
  return entries;
}

/** 失败时截图，并返回错误信息。截图本身失败绝不能掩盖真正的失败原因。 */
async function captureFailure(page: Page, title: string, error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    if (typeof page?.screenshot === 'function') {
      await page.screenshot({ path: test.info().outputPath(\`failure-\${slugify(title)}.png\`), fullPage: true });
    }
  } catch {
    // 截图失败（页面已崩溃、context 已关闭）时保留原始错误。
  }
  return message;
}

/**
 * Run one documented step. Logs progress and captures a screenshot on failure so
 * the report can point at the exact step that broke.
 */
export async function step(page: Page, title: string, body: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  const entries = timelineFor(test.info());
  try {
    await body();
    entries.push({ title, status: 'passed', durationMs: Date.now() - started });
    console.log(\`  ✓ \${title} (\${Date.now() - started}ms)\`);
  } catch (error) {
    const message = await captureFailure(page, title, error);
    entries.push({ title, status: 'failed', durationMs: Date.now() - started, error: message });
    console.log(\`  ✗ \${title} (\${Date.now() - started}ms)\`);
    throw error;
  }
}

/**
 * 等待一个异步任务完成（文生图、导出、批处理等）。
 *
 * \`check\` 的返回值决定语义：
 *   - \`false\`      还没完成，继续轮询
 *   - \`string\`     还没完成，字符串是当前状态（如 "Queued"），会记进时间线
 *   - \`true\`       已完成
 *
 * 这样「提交失败」和「生成较慢」在报告里是两件不同的事：前者停在提交步骤，
 * 后者会留下 Queued -> 生成中 -> 成功 的状态变化记录。
 *
 * 用 \`ASYNC_SUBMIT_TIMEOUT\` 约束提交动作本身，用本函数的 \`timeout\`
 * （默认 \`ASYNC_COMPLETION_TIMEOUT\`）约束生成耗时。
 */
export async function waitForAsyncTask(
  page: Page,
  title: string,
  check: () => Promise<boolean | string>,
  options: { timeout?: number; interval?: number; hint?: string } = {},
): Promise<number> {
  const timeout = options.timeout ?? ASYNC_COMPLETION_TIMEOUT;
  const interval = options.interval ?? ASYNC_POLL_INTERVAL;
  const started = Date.now();
  const observations: Observation[] = [];
  let last = '';
  let failure: string | undefined;

  // Only this test gets a longer budget. Raising the global timeout instead would
  // make every genuine hang wait for the slowest possible async task.
  const info = test.info();
  const needed = Date.now() - info.startTime + timeout + ASYNC_SUBMIT_TIMEOUT;
  if (needed > info.timeout) test.setTimeout(needed);

  try {
    for (;;) {
      const result = await check();
      const state = typeof result === 'string' ? result : result === true ? '已完成' : '';
      if (state !== '' && state !== last) {
        observations.push({ at: Date.now() - started, state });
        last = state;
        console.log(\`    · \${state}（\${Math.round((Date.now() - started) / 1000)}s）\`);
      }
      if (result === true) return Date.now() - started;
      if (Date.now() - started > timeout) {
        throw new Error(
          \`等待「\${title}」超时（\${Math.round(timeout / 1000)}s）。\` +
            \`最后观察到的状态：\${last === '' ? '未知' : last}。\` +
            (options.hint ?? '') +
            ' 若任务仍在排队，请调大 e2e.config.json 中 asyncTasks.completionTimeout；' +
            '若状态始终没有推进，则更像是提交或产品问题。',
        );
      }
      await page.waitForTimeout(interval);
    }
  } catch (error) {
    failure = await captureFailure(page, title, error);
    throw error;
  } finally {
    timelineFor(test.info()).push({
      title,
      status: failure === undefined ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      ...(failure === undefined ? {} : { error: failure }),
      ...(observations.length > 0 ? { observations } : {}),
    });
  }
}

/** Assert a visible text is present, with a message that names the expectation. */
export async function expectVisibleText(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}

// 步骤时间线随用例一起上报，报告里能看到「卡在哪一步」。
// 必须写成文件再按 path 挂载：Playwright 的 JSON 报告只记录有磁盘路径的附件，
// 纯 body 附件在 results.json 里没有 path，报告阶段就读不到。
test.afterEach(async ({}, testInfo) => {
  const entries = timelines.get(testInfo);
  if (entries === undefined || entries.length === 0) return;
  const file = testInfo.outputPath('timeline.json');
  try {
    await fs.writeFile(file, JSON.stringify({ steps: entries }, null, 2));
    await testInfo.attach('timeline', { path: file, contentType: 'application/json' });
  } catch {
    // 时间线只是诊断增强，不能因为它写不出来就让用例失败。
  }
});
`;
  fs.mkdirSync(paths.specs, { recursive: true });
  fs.writeFileSync(paths.fixtures, content);
  return paths.fixtures;
}

/**
 * Generate `specs/_auth.setup.ts`, the Playwright setup project that logs in once
 * and persists `storageState` for every browser project.
 *
 * @param {ReturnType<typeof runPaths>} paths
 * @param {Record<string, any>} config
 * @param {string} authStatePath
 * @returns {string}
 */
function writeAuthSetup(paths, config, authStatePath) {
  const steps = buildLoginSteps(config);
  const content = renderAuthSetup({ config, steps, storageStatePath: authStatePath });
  fs.mkdirSync(paths.specs, { recursive: true });
  const file = path.join(paths.specs, '_auth.setup.ts');
  fs.writeFileSync(file, content);
  return file;
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
  const { config, warnings, problems, configDir } = buildConfig({ flags: configFlags });
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
  fs.writeFileSync(paths.config, `${JSON.stringify(redactConfig(config), null, 2)}\n`);

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

  // --- Auth -----------------------------------------------------------------
  const auth = resolveAuth(config, { runDir, home, configDir });
  if (auth.problems.length > 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `登录配置有问题：${auth.problems.join(' ')}`,
        hint:
          '三种可用方式：① 只复用已有登录态 {"auth": {"enabled": false, "storageState": "auth/site.json"}}；' +
          '② 自动登录 {"auth": {"enabled": true, "loginUrl": "/login", "username": "${E2E_USERNAME}", "password": "${E2E_PASSWORD}"}}；' +
          '③ 多步骤登录再加 auth.continueSelector 或 auth.steps。详见 references/workflow.md。',
      }),
    );
  }
  for (const note of auth.notes) reporter.note(`ℹ️  ${note}`);

  const authEnabled = auth.mode !== 'none';
  const authStatePath = auth.storageStatePath;
  const hasAuthSetup = auth.needsLoginSetup;
  if (authEnabled && authStatePath !== null) fs.mkdirSync(path.dirname(authStatePath), { recursive: true });

  // --- Attempt isolation ----------------------------------------------------
  // Every execution gets its own directory: stale traces and screenshots from an
  // earlier run must never be cleaned up, or reported, as part of this one.
  const attemptId = nextAttemptId(runDir);
  const attempt = attemptPaths(runDir, attemptId);
  fs.rmSync(attempt.dir, { recursive: true, force: true });
  fs.mkdirSync(attempt.testResults, { recursive: true });

  const attemptPathsForConfig = {
    ...paths,
    testResults: attempt.testResults,
    jsonResults: attempt.jsonResults,
    htmlReport: attempt.htmlReport,
  };

  // --- Generated scaffolding ------------------------------------------------
  writeFixtures(paths, config);
  if (hasAuthSetup && authStatePath !== null) writeAuthSetup(paths, config, authStatePath);
  fs.writeFileSync(
    paths.playwrightConfig,
    renderPlaywrightConfig({ paths: attemptPathsForConfig, config, authStatePath, hasAuthSetup }),
  );

  const specs = listSpecFiles(paths.specs);
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

  const testTimeout = Number(config.timeout);
  reporter.note(
    `ℹ️  异步任务预算：提交 ${config.asyncTasks.submitTimeout}ms / 完成 ${config.asyncTasks.completionTimeout}ms；` +
      '用到 waitForAsyncTask 的用例会自动放宽自身超时。',
  );

  // --- Execute --------------------------------------------------------------
  const extraArgs = [`--config=${paths.playwrightConfig}`];
  if (typeof flags.grep === 'string') extraArgs.push('--grep', flags.grep);
  if (typeof flags.project === 'string') extraArgs.push('--project', flags.project);

  const childEnv = { ...process.env };
  // Keep terminal color codes out of the JSON reporter's error strings.
  childEnv.NO_COLOR = '1';
  childEnv.FORCE_COLOR = '0';
  if (config.auth?.username) childEnv.E2E_USERNAME = String(config.auth.username);
  if (config.auth?.password) childEnv.E2E_PASSWORD = String(config.auth.password);

  reporter.note(`执行 ${specs.length} 个用例文件，浏览器：${config.browsers.join(', ')} …`);
  reporter.note('');

  const execution = await runCommand(process.execPath, [cli, 'test', ...extraArgs], {
    cwd: runDir,
    env: childEnv,
    onLine: (line) => reporter.note(line),
  });

  // --- Normalize ------------------------------------------------------------
  if (!fs.existsSync(attempt.jsonResults)) {
    // Classify the failure: "the browser could not start" and "the tests failed"
    // are different problems, and "switch to --headless" only helps one of them.
    const combined = `${execution.stderr}\n${execution.stdout}`;
    const diagnosis = diagnoseLaunchFailure(combined);
    const unknown = diagnosis.kind === 'unknown';

    process.exit(
      reporter.finish({
        ok: false,
        error: unknown
          ? '测试未产生 JSON 结果文件，说明执行在用例开始前就失败了。'
          : `测试未能开始执行：${diagnosis.cause}`,
        hint: unknown
          ? '常见原因：配置文件错误、TypeScript 编译失败、用例文件有语法错误。'
          : diagnosis.action,
        failureKind: diagnosis.kind,
        canRetryHeadless: diagnosis.canRetryHeadless,
        launchMode: config.headless ? 'headless' : 'headed',
        attempt: { id: attempt.id, dir: attempt.dir },
        excerpt: relevantExcerpt(combined),
      }),
    );
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(attempt.jsonResults, 'utf8'));
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

  // Which cases have automation code at all — the difference between a coverage
  // gap and a case that this run's --grep simply did not select.
  const automatedCaseIds = collectAutomatedCaseIds(paths.specs);

  const summary = normalizeResults(report, {
    cases,
    automatedCaseIds,
    filter: {
      grep: typeof flags.grep === 'string' ? flags.grep : '',
      project: typeof flags.project === 'string' ? flags.project : '',
    },
  });
  const verdict = verdictFor(summary, { cases });

  // A silently mis-placed HTML report is easy to miss, so verify it explicitly.
  const htmlIndex = path.join(attempt.htmlReport, 'index.html');
  const htmlReportWritten = fs.existsSync(htmlIndex);
  if (!htmlReportWritten) {
    reporter.note(`⚠️  未在预期位置找到 HTML 报告：${htmlIndex}`);
  }

  const attemptMeta = {
    id: attempt.id,
    dir: attempt.dir,
    startedAt: summary.startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: execution.code,
    filter: summary.filter,
    auth: { mode: auth.mode, label: auth.label },
    counts: summary.counts,
    notAutomated: summary.notAutomated.length,
    notExecuted: summary.notExecuted.length,
    specs: specs.map((file) => path.basename(file)),
  };
  fs.writeFileSync(attempt.meta, `${JSON.stringify(attemptMeta, null, 2)}\n`);
  const pruned = pruneAttempts(runDir, config.attempts?.keep ?? 10);
  if (pruned.length > 0) reporter.note(`ℹ️  已清理 ${pruned.length} 个历史执行批次：${pruned.join(', ')}`);

  const payload = {
    ...summary,
    verdict,
    runDir,
    attempt: { id: attempt.id, dir: attempt.dir, meta: attempt.meta },
    authLabel: auth.label,
    authMode: auth.mode,
    effectiveTimeout: testTimeout,
    baseURL: effectiveBaseURL(config),
    browsers: config.browsers,
    specs,
    exitCode: execution.code,
    artifacts: {
      htmlReport: attempt.htmlReport,
      htmlReportIndex: htmlReportWritten ? htmlIndex : null,
      jsonResults: attempt.jsonResults,
      testResults: attempt.testResults,
      summary: paths.summary,
      attemptMeta: attempt.meta,
    },
  };
  fs.writeFileSync(paths.summary, `${JSON.stringify(payload, null, 2)}\n`);

  reporter.note('');
  reporter.note(
    `${verdict.label}  通过 ${summary.counts.passed} / 失败 ${summary.counts.failed} / 跳过 ${summary.counts.skipped} / ` +
      `本次未执行 ${summary.notExecuted.length} / 未自动化 ${summary.notAutomated.length}`,
  );
  for (const reason of verdict.reasons) reporter.note(`  · ${reason}`);
  if (summary.counts.failed > 0) {
    reporter.note('');
    reporter.note('失败用例：');
    for (const test of summary.tests.filter((t) => t.status === 'failed').slice(0, 10)) {
      reporter.note(`  ❌ ${test.caseId ?? '?'} ${test.title}`);
    }
  }
  reporter.note('');
  reporter.note(`执行批次：${attempt.dir}`);
  reporter.note(`HTML 报告：${attempt.htmlReport}`);

  // A test failure is a valid, reportable outcome — not a script failure. Only
  // infrastructure problems make this script itself fail.
  process.exit(
    reporter.finish({
      ok: summary.infrastructureErrors.length === 0 && summary.counts.total > 0,
      runDir,
      attempt: { id: attempt.id, dir: attempt.dir },
      baseURL: effectiveBaseURL(config),
      browsers: config.browsers,
      counts: summary.counts,
      passRate: summary.passRate,
      verdict,
      filter: summary.filter,
      auth: { mode: auth.mode, label: auth.label },
      effectiveTimeout: testTimeout,
      notAutomated: summary.notAutomated,
      notExecuted: summary.notExecuted,
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
