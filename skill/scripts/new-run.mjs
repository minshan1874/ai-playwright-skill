#!/usr/bin/env node
/**
 * Allocate a fresh run directory.
 *
 * The agent should not do timestamp arithmetic by hand; this script resolves the
 * skill home, creates `runs/<project>-<timestamp>/`, and returns the paths the
 * later phases need.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createReporter, parseArgs } from './lib/log.mjs';
import {
  describeWriteDenial,
  ensureHomeLayout,
  probeWritable,
  resolveHome,
  runDirPath,
  runPaths,
  slugify,
} from './lib/paths.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'new-run' });

async function main() {
  const url = typeof flags.url === 'string' ? flags.url : '';
  const name = typeof flags.name === 'string' && flags.name.trim() !== '' ? flags.name.trim() : url;

  if (name === '') {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --url 或 --name 参数',
        hint: '用法：node new-run.mjs --url <被测网址> [--name <项目名>]',
      }),
    );
  }

  const home = resolveHome(process.env);

  const probe = probeWritable(home);
  if (!probe.ok) {
    const hint = describeWriteDenial(home, probe);
    reporter.note(hint);
    process.exit(
      reporter.finish({
        ok: false,
        error: `无法写入运行目录 ${home}（${probe.code}）`,
        hint,
        home,
      }),
    );
  }

  ensureHomeLayout(home);

  const slug = slugify(name);
  let dir = runDirPath(home, slug);
  // Two runs inside the same second would collide; disambiguate instead of failing.
  let suffix = 1;
  while (fs.existsSync(dir)) {
    dir = `${runDirPath(home, slug)}-${suffix}`;
    suffix += 1;
  }
  fs.mkdirSync(dir, { recursive: true });

  const paths = runPaths(dir);
  const configFile = typeof flags.config === 'string' ? path.resolve(flags.config) : null;
  if (configFile !== null) {
    if (!fs.existsSync(configFile)) {
      process.exit(
        reporter.finish({ ok: false, error: `找不到配置文件：${configFile}`, hint: '请检查 --config 路径。' }),
      );
    }
    fs.copyFileSync(configFile, paths.config);
  } else if (url !== '') {
    fs.writeFileSync(paths.config, `${JSON.stringify({ baseURL: url }, null, 2)}\n`);
  }

  reporter.note(`✅ 已创建运行目录：${dir}`);

  process.exit(
    reporter.finish({
      ok: true,
      home,
      runDir: dir,
      slug,
      paths,
      config: fs.existsSync(paths.config) ? paths.config : null,
      nextStep: [
        `1) node scripts/parse-cases.mjs --input <用例文件> --out "${paths.cases}"`,
        `2) node scripts/make-plan.mjs --run-dir "${dir}"`,
        '3) 把 plan.md 展示给用户，等待明确确认',
        `4) node scripts/confirm-plan.mjs --plan "${paths.plan}"`,
        `5) node scripts/explore.mjs --url <网址> --out "${paths.explore}" --config "${paths.config}"`,
        `6) 在 ${paths.specs} 下编写 .spec.ts`,
        `7) node scripts/run.mjs --run-dir "${dir}"`,
        `8) node scripts/report.mjs --run-dir "${dir}"`,
      ],
    }),
  );
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
