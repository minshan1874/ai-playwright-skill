#!/usr/bin/env node
/**
 * Flip a plan to `已确认`.
 *
 * Only run this after the user has explicitly approved the plan in conversation.
 * `run.mjs` refuses to execute until this has happened, so this script is the
 * single, auditable point where the gate opens.
 */

import path from 'node:path';

import { createReporter, parseArgs } from './lib/log.mjs';
import { PLAN_STATUS, readPlanStatus, setPlanStatus } from './lib/plan.mjs';
import { runPaths } from './lib/paths.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'confirm-plan' });

async function main() {
  const planFile =
    typeof flags.plan === 'string'
      ? path.resolve(flags.plan)
      : typeof flags['run-dir'] === 'string'
        ? runPaths(path.resolve(flags['run-dir'])).plan
        : null;

  if (planFile === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --plan 或 --run-dir 参数',
        hint: '用法：node confirm-plan.mjs --plan <plan.md> [--note "用户原话"]',
      }),
    );
  }

  const before = readPlanStatus(planFile);
  if (!before.exists) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `找不到测试计划：${planFile}`,
        hint: '请先运行 make-plan.mjs 生成计划。',
      }),
    );
  }

  setPlanStatus(planFile, PLAN_STATUS.confirmed, {
    note: typeof flags.note === 'string' ? flags.note : undefined,
    confirmedBy: typeof flags.by === 'string' ? flags.by : undefined,
  });

  reporter.note(`✅ 测试计划已标记为「已确认」：${planFile}`);
  reporter.note('   现在可以运行 run.mjs 执行测试。');

  process.exit(
    reporter.finish({
      ok: true,
      plan: planFile,
      previousStatus: before.status,
      status: PLAN_STATUS.confirmed,
      nextStep: 'node run.mjs --run-dir <运行目录>',
    }),
  );
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
