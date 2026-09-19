#!/usr/bin/env node
/**
 * Reporting phase: merge the confirmed plan, the case list, and the normalized
 * results into `report.md`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createReporter, parseArgs } from './lib/log.mjs';
import { runPaths } from './lib/paths.mjs';
import { readPlanStatus } from './lib/plan.mjs';
import { renderReport } from './lib/report.mjs';
import { verdictFor } from './lib/results.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'report' });

/**
 * Read and parse a JSON file, returning a fallback when absent or invalid.
 * @param {string} file
 * @param {any} fallback
 * @returns {any}
 */
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const runDir = typeof flags['run-dir'] === 'string' ? path.resolve(flags['run-dir']) : null;
  if (runDir === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --run-dir 参数',
        hint: '用法：node report.mjs --run-dir <运行目录> [--out <report.md>]',
      }),
    );
  }

  const paths = runPaths(runDir);
  const out = typeof flags.out === 'string' ? path.resolve(flags.out) : paths.report;

  const summary = readJson(paths.summary, null);
  if (summary === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `找不到归一化结果：${paths.summary}`,
        hint: '请先运行 run.mjs 执行测试。',
      }),
    );
  }

  const cases = readJson(paths.cases, { cases: [] }).cases ?? [];
  const config = readJson(paths.config, {});
  const planStatus = readPlanStatus(paths.plan);
  const plan = planStatus.exists ? { raw: planStatus.raw } : null;

  const baseURL = summary.baseURL ?? config.baseURL ?? '';

  // Recompute the verdict when cases.json was produced after the run, so newly
  // added "not automated" rows are reflected.
  const verdict = cases.length > 0 ? verdictFor(summary, { cases }) : (summary.verdict ?? verdictFor(summary));

  const generatedAt = new Date().toISOString();
  const markdown = renderReport({
    plan,
    cases,
    summary: { ...summary, verdict, browsers: summary.browsers ?? config.browsers ?? [] },
    config,
    runDir,
    baseURL,
    generatedAt,
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, markdown);

  reporter.note(`✅ 测试报告已生成：${out}`);
  reporter.note(`   ${verdict.label}`);
  for (const reason of verdict.reasons) reporter.note(`   · ${reason}`);
  if (summary.artifacts?.htmlReport) reporter.note(`   HTML 报告：${path.join(summary.artifacts.htmlReport, 'index.html')}`);

  process.exit(
    reporter.finish({
      ok: true,
      report: out,
      runDir,
      baseURL,
      verdict,
      counts: summary.counts,
      passRate: summary.passRate,
      notAutomated: (summary.notAutomated ?? []).length,
      artifacts: summary.artifacts ?? {},
      generatedAt,
    }),
  );
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
