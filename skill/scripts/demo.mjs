#!/usr/bin/env node
/**
 * Offline end-to-end demo.
 *
 * Runs the complete pipeline against the bundled demo page: environment check,
 * case parsing, plan, confirmation, exploration, execution, and reporting. No
 * network access is required, and the run is expected to contain one deliberate
 * failure plus one not-automated case, so every report outcome is exercised.
 *
 *   node scripts/demo.mjs [--keep-open] [--json]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReporter, parseArgs } from './lib/log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);
const DEMO_DIR = path.join(SKILL_DIR, 'assets', 'demo');

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'demo' });

/**
 * Whether this process is running on a CI runner.
 *
 * `CI` is set by GitHub Actions, GitLab, CircleCI and most others. Those runners
 * have no display, so a headed browser cannot start there.
 * @returns {boolean}
 */
function isCI() {
  return process.env.CI === 'true' || process.env.CI === '1';
}

/**
 * Browser-visibility flags forwarded to the explore and run phases.
 *
 * The demo follows the skill's own default so that what a new user sees first
 * matches what a real run does: headed on a normal machine, headless on CI.
 * `--headed` / `--headless` / `--slow-mo` override that.
 */
const modeFlags = [];
if (flags.headless === true || (flags.headed !== true && isCI())) modeFlags.push('--headless');
else modeFlags.push('--headed');
if (typeof flags['slow-mo'] === 'string') modeFlags.push('--slow-mo', flags['slow-mo']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Start a static file server for the demo page on an ephemeral port.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function startServer() {
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const target = path.join(DEMO_DIR, relative);

    // Refuse to serve anything outside the demo directory.
    if (!target.startsWith(DEMO_DIR)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Run one skill script and parse its JSON payload.
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<{code: number, payload: any, stdout: string, stderr: string}>}
 */
function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args, '--json'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: 127, payload: null, stdout, stderr: `${error.message}\n${stderr}` }));
    child.on('close', (code) => {
      const marker = '###PLAYWRIGHT_E2E_JSON###';
      const index = stdout.indexOf(marker);
      let payload = null;
      if (index !== -1) {
        const line = stdout.slice(index + marker.length).split('\n').find((entry) => entry.trim() !== '');
        try {
          payload = JSON.parse(line);
        } catch {
          payload = null;
        }
      }
      resolve({ code: code ?? 1, payload, stdout, stderr });
    });
  });
}

/**
 * Replace the plan skeleton's placeholders with demo analysis.
 * @param {string} file
 */
function fillPlan(file) {
  // Mark TC-005 honestly: the plan and the report must agree about coverage.
  const feasibility = (row) =>
    row.includes('TC-005') ? '无法自动化：需要真实短信通道' : '可自动化';

  const replacements = [
    [
      '<!-- 请在此补充：本次测试要验证的业务目标、明确不测的范围 -->',
      [
        '本次验证演示站的登录与商品搜索主链路，确认账号校验、错误提示与搜索过滤行为正确。',
        '',
        '**不包含**：真实下单与支付、后台管理、移动端适配、性能与并发。',
      ].join('\n'),
    ],
    [
      '<!-- 请在此说明：登录方式、测试数据准备、执行顺序、需要人工介入的环节 -->',
      [
        '- **登录**：演示站为纯前端校验，账号 `admin` / `123456` 写死在用例里，不涉及真实凭据。',
        '- **测试数据**：商品列表由页面内置，无需外部准备。',
        '- **执行顺序**：各用例相互独立，串行执行。',
        '- **人工介入**：无。',
      ].join('\n'),
    ],
    [
      '<!-- 请在此列出：验证码、短信、第三方依赖、动态数据、环境不稳定等 -->',
      [
        '- TC-005（短信验证码登录）无法自动化：需要真实短信通道，已列为未自动化。',
        '- TC-004（购物车数量）在演示站上预期会失败：这是**故意保留的真实缺陷**，用于演示失败报告。',
        '- 演示站通过本地 HTTP 服务提供，端口随机，不依赖外网。',
      ].join('\n'),
    ],
    [
      '<!-- 请在此列出必须由用户回答才能继续的问题；没有则写「无」 -->',
      '无。演示站为内置页面，无需额外确认。',
    ],
  ];

  let content = fs.readFileSync(file, 'utf8');
  for (const [from, to] of replacements) content = content.replaceAll(from, to);

  // The feasibility placeholder appears once per case row, so resolve it per line.
  content = content
    .split('\n')
    .map((line) => (line.includes('<!-- 可自动化 / 需登录 / 需人工 -->')
      ? line.replace('<!-- 可自动化 / 需登录 / 需人工 -->', feasibility(line))
      : line))
    .join('\n');

  fs.writeFileSync(file, content);
}

async function main() {
  const started = Date.now();
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, ...(detail ? { detail } : {}) });
    reporter.note(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // --- 0. Environment -------------------------------------------------------
  // `--install-browsers` is passed deliberately: the demo is invoked explicitly
  // by a human, which *is* the consent bootstrap otherwise waits for. Without it
  // the demo could never run on a machine that has not used Playwright before —
  // including every fresh CI runner.
  const bootstrap = await runScript('bootstrap.mjs', ['--install-browsers']);
  if (!bootstrap.payload?.ready) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '环境未就绪，无法运行演示。',
        hint: bootstrap.payload?.nextStep ?? bootstrap.payload?.hint ?? '请先运行 bootstrap.mjs。',
        bootstrap: bootstrap.payload,
      }),
    );
  }
  record('环境自检', true, `运行目录 ${bootstrap.payload.home}`);

  const server = await startServer();
  reporter.note(`演示站已启动：${server.url}`);

  try {
    // --- 1. Run directory ---------------------------------------------------
    const newRun = await runScript('new-run.mjs', ['--url', server.url, '--name', 'playwright-e2e-demo']);
    if (!newRun.payload?.ok) {
      throw new Error(`创建运行目录失败：${newRun.payload?.error ?? newRun.stderr}`);
    }
    const runDir = newRun.payload.runDir;
    record('创建运行目录', true, runDir);

    // --- 2. Parse cases -----------------------------------------------------
    const parse = await runScript('parse-cases.mjs', [
      '--input', path.join(DEMO_DIR, 'demo-cases.csv'),
      '--out', path.join(runDir, 'cases.json'),
    ]);
    if (!parse.payload?.ok) throw new Error(`解析用例失败：${parse.payload?.error ?? parse.stderr}`);
    record('解析用例', true, `${parse.payload.total} 条，警告 ${parse.payload.warnings.length} 条`);

    // --- 3. Plan + confirmation --------------------------------------------
    const makePlan = await runScript('make-plan.mjs', ['--run-dir', runDir]);
    if (!makePlan.payload?.ok) throw new Error(`生成计划失败：${makePlan.payload?.error ?? makePlan.stderr}`);
    fillPlan(path.join(runDir, 'plan.md'));
    record('生成测试计划', true, '状态：待确认');

    // The demo simulates the user approving the plan. In a real run this only
    // happens after the user explicitly confirms in conversation.
    const confirm = await runScript('confirm-plan.mjs', [
      '--plan', path.join(runDir, 'plan.md'),
      '--note', '演示模式：模拟用户确认',
    ]);
    if (!confirm.payload?.ok) throw new Error(`确认计划失败：${confirm.payload?.error ?? confirm.stderr}`);
    record('用户确认计划', true, '状态：已确认');

    // --- 4. Explore ---------------------------------------------------------
    // `--headless` is forced because the default is now headed (so a human can
    // watch), and CI runners have no display. Pass `--headed` yourself to watch
    // the demo: node scripts/demo.mjs --headed
    const explore = await runScript('explore.mjs', [
      '--url', server.url,
      '--out', path.join(runDir, 'explore'),
      '--config', path.join(runDir, 'e2e.config.json'),
      ...modeFlags,
    ]);
    if (!explore.payload?.ok) throw new Error(`探索失败：${explore.payload?.error ?? explore.stderr}`);
    record('探索页面', true, `${explore.payload.counts.total} 个可交互元素`);

    // --- 5. Fixate specs ----------------------------------------------------
    const specsDir = path.join(runDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.copyFileSync(path.join(DEMO_DIR, 'demo.spec.ts'), path.join(specsDir, 'demo.spec.ts'));
    record('固化用例', true, 'demo.spec.ts（4 条自动化 + 1 条未自动化）');

    // --- 6. Execute ---------------------------------------------------------
    const run = await runScript('run.mjs', ['--run-dir', runDir, ...modeFlags]);
    if (!run.payload?.ok) {
      throw new Error(
        `执行失败：${run.payload?.error ?? run.stderr}\n${run.payload?.hint ?? ''}`,
      );
    }
    record(
      '执行测试',
      true,
      `通过 ${run.payload.counts.passed} / 失败 ${run.payload.counts.failed} / 未自动化 ${run.payload.notAutomated.length}`,
    );

    // --- 7. Report ----------------------------------------------------------
    const report = await runScript('report.mjs', ['--run-dir', runDir]);
    if (!report.payload?.ok) throw new Error(`生成报告失败：${report.payload?.error ?? report.stderr}`);
    record('生成报告', true, report.payload.report);

    // --- Verdict ------------------------------------------------------------
    const failed = run.payload.counts.failed;
    const notAutomated = run.payload.notAutomated.length;
    const demoBehavesAsDesigned = failed === 1 && notAutomated === 1 && run.payload.counts.passed === 3;

    const result = {
      ok: demoBehavesAsDesigned,
      runDir,
      demoURL: server.url,
      elapsedMs: Date.now() - started,
      steps,
      counts: run.payload.counts,
      passRate: run.payload.passRate,
      verdict: run.payload.verdict,
      failedCases: run.payload.failures.map((failure) => failure.caseId),
      notAutomatedCases: run.payload.notAutomated.map((entry) => entry.id),
      artifacts: {
        plan: path.join(runDir, 'plan.md'),
        cases: path.join(runDir, 'cases.json'),
        explore: path.join(runDir, 'explore', 'outline.md'),
        specs: path.join(runDir, 'specs'),
        report: report.payload.report,
        // Artifacts live in the execution attempt directory, so read the path the
        // run actually reported instead of assuming the run root.
        htmlReport: run.payload.artifacts?.htmlReportIndex ?? path.join(runDir, 'playwright-report', 'index.html'),
        attemptDir: run.payload.attempt?.dir ?? '',
        summary: path.join(runDir, 'results-summary.json'),
      },
      expected: { passed: 3, failed: 1, notAutomated: 1 },
      ...(demoBehavesAsDesigned
        ? {}
        : {
            error:
              '演示结果与预期不符：应恰好 3 条通过、1 条失败、1 条未自动化。',
            hint: '请检查上面的步骤输出，或查看运行目录里的 report.md。',
          }),
    };

    reporter.note('');
    reporter.note('演示完成。产物：');
    for (const [name, file] of Object.entries(result.artifacts)) reporter.note(`  ${name}: ${file}`);

    if (flags['keep-open'] === true) {
      reporter.always(`演示站仍在运行：${server.url}（按 Ctrl+C 结束）`);
      return;
    }

    await server.close();
    process.exit(reporter.finish(result));
  } catch (error) {
    await server.close();
    process.exit(
      reporter.finish({
        ok: false,
        error: error?.message ?? String(error),
        steps,
        hint: '演示中断。请检查上面的步骤输出定位问题。',
      }),
    );
  }
}

main().catch(async (error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
