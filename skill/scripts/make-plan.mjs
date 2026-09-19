#!/usr/bin/env node
/**
 * Generate the test-plan skeleton from the parsed case list.
 *
 * The agent fills in the analysis sections and then shows the file to the user.
 * Creating the file (rather than letting the agent free-form it) keeps the plan
 * structure stable across runs and guarantees the status trailer exists.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildConfig, effectiveBaseURL } from './lib/config.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import { runPaths } from './lib/paths.mjs';
import { renderPlanSkeleton } from './lib/report.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'make-plan' });

async function main() {
  const runDir = typeof flags['run-dir'] === 'string' ? path.resolve(flags['run-dir']) : null;
  if (runDir === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --run-dir 参数',
        hint: '用法：node make-plan.mjs --run-dir <运行目录> --cases <cases.json> [--url <网址>] [--force]',
      }),
    );
  }

  const paths = runPaths(runDir);
  const casesFile = typeof flags.cases === 'string' ? path.resolve(flags.cases) : paths.cases;
  if (!fs.existsSync(casesFile)) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `找不到用例文件：${casesFile}`,
        hint: '请先运行 parse-cases.mjs 生成 cases.json。',
      }),
    );
  }

  if (fs.existsSync(paths.plan) && flags.force !== true) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `测试计划已存在：${paths.plan}`,
        hint: '如需重新生成，请加 --force（会覆盖已填写的内容）。',
      }),
    );
  }

  const parsed = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const cases = parsed.cases ?? [];
  if (cases.length === 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `${casesFile} 中没有任何用例`,
        hint: '请检查用例文件的表头与数据行。',
      }),
    );
  }

  const configFlags = { ...flags };
  if (configFlags.config === undefined && fs.existsSync(paths.config)) configFlags.config = paths.config;
  const { config, problems } = buildConfig({ flags: configFlags });
  if (problems.length > 0) {
    process.exit(
      reporter.finish({ ok: false, error: `配置有问题：${problems.join(' ')}`, hint: '请提供 --url 或配置文件。' }),
    );
  }

  fs.mkdirSync(runDir, { recursive: true });
  const markdown = renderPlanSkeleton({
    baseURL: effectiveBaseURL(config),
    cases,
    config,
    runDir,
  });
  fs.writeFileSync(paths.plan, markdown);

  reporter.note(`✅ 已生成测试计划骨架：${paths.plan}`);
  reporter.note(`   共 ${cases.length} 条用例，覆盖 ${parsed.byModule?.length ?? 0} 个模块。`);
  reporter.note('   请补全计划内容后展示给用户，等待用户明确确认。');

  process.exit(
    reporter.finish({
      ok: true,
      plan: paths.plan,
      runDir,
      total: cases.length,
      modules: parsed.byModule ?? [],
      status: '待确认',
      nextStep: '补全 plan.md 的分析段落，展示给用户，等待确认后再运行 confirm-plan.mjs。',
    }),
  );
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
