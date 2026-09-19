#!/usr/bin/env node
/**
 * Environment self-check and installer for the playwright-e2e skill.
 *
 * Responsibilities:
 *   - verify Node meets Playwright's floor
 *   - create the skill home and prove it is actually writable
 *   - install `@playwright/test` + `exceljs` once, with a home-local npm cache
 *   - report which browsers are already cached, so the agent can ask before a
 *     large download
 *   - with `--probe-launch`, actually start a browser to prove the environment
 *     allows it (a sandbox denial is invisible until the process starts)
 *
 * `--check` performs no writes at all and is safe to call while planning.
 */

import fs from 'node:fs';
import path from 'node:path';

import { probeBothModes } from './lib/launch-probe.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import {
  DEFAULT_PLAYWRIGHT_VERSION,
  browserCacheDir,
  describeWriteDenial,
  ensureHomeLayout,
  probeWritable,
  resolveHome,
} from './lib/paths.mjs';
import {
  assertSafeToolchainDir,
  describeDownloadSize,
  installedVersion,
  installBrowsers,
  installDependencies,
  probeBrowsers,
  writeToolchainManifest,
} from './lib/toolchain.mjs';

/** Playwright 1.63 requires Node 20 or newer. */
const MIN_NODE_MAJOR = 20;

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'bootstrap' });

const checkOnly = flags.check === true;
const installMissingBrowsers = flags['install-browsers'] === true;
const probeLaunchFlag = flags['probe-launch'] === true;
const playwrightVersion =
  typeof flags['playwright-version'] === 'string' ? flags['playwright-version'] : DEFAULT_PLAYWRIGHT_VERSION;

/**
 * Non-mutating writability guess used by `--check`.
 * @param {string} dir
 * @returns {'yes'|'no'|'unknown'}
 */
function guessWritable(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(current)) {
      try {
        fs.accessSync(current, fs.constants.W_OK);
        return 'yes';
      } catch {
        return 'no';
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return 'unknown';
    current = parent;
  }
}

/**
 * Parse the requested browser list.
 * @returns {string[]}
 */
function requestedBrowsers() {
  const raw = flags.browsers;
  if (typeof raw !== 'string' || raw.trim() === '') return ['chromium'];
  return raw.split(/[,，\s]+/).map((b) => b.trim()).filter(Boolean);
}

async function main() {
  const home = resolveHome(process.env);
  const browsers = requestedBrowsers();

  // --- Node version ---------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR;
  if (!nodeOk) {
    reporter.note(`❌ Node ${process.versions.node} 版本过低，Playwright 需要 Node >= ${MIN_NODE_MAJOR}。`);
    process.exit(
      reporter.finish({
        ok: false,
        error: `Node ${process.versions.node} 低于要求的 v${MIN_NODE_MAJOR}`,
        hint: `请升级 Node 到 v${MIN_NODE_MAJOR} 或更高版本后重试。`,
      }),
    );
  }

  // --- Home directory ------------------------------------------------------
  let blocked = null;
  let writable = 'unknown';

  if (checkOnly) {
    writable = guessWritable(home);
    if (writable === 'no') {
      blocked = {
        reason: `目录 ${home} 不可写。`,
        hint: `export PLAYWRIGHT_E2E_HOME="<可写目录>" 后重试，或批准提权。`,
      };
    }
  } else {
    const probe = probeWritable(home);
    if (!probe.ok) {
      reporter.note(describeWriteDenial(home, probe));
      blocked = { reason: `无法写入 ${home}（${probe.code}）`, hint: describeWriteDenial(home, probe) };
    } else {
      writable = 'yes';
    }
  }

  if (blocked !== null) {
    process.exit(
      reporter.finish({
        ok: false,
        ready: false,
        home,
        blocked,
        error: blocked.reason,
        hint: blocked.hint,
      }),
    );
  }

  // --- Refuse to take over a directory that belongs to someone else --------
  // bootstrap writes its own package.json here, so pointing the home at a real
  // project would destroy that project's manifest.
  const ownership = assertSafeToolchainDir(home);
  if (!ownership.safe) {
    reporter.note(`❌ ${ownership.reason}`);
    process.exit(
      reporter.finish({
        ok: false,
        ready: false,
        home,
        error: ownership.reason,
        hint:
          '请把 PLAYWRIGHT_E2E_HOME 指向一个空的专用目录（例如 ~/.dsh/playwright-e2e），' +
          '不要指向已有项目。这样本 skill 才不会覆盖你的 package.json。',
      }),
    );
  }

  if (!checkOnly) ensureHomeLayout(home);

  // --- Dependencies --------------------------------------------------------
  const currentTestVersion = installedVersion(home, '@playwright/test');
  const currentExcelVersion = installedVersion(home, 'exceljs');
  const dependenciesReady = currentTestVersion !== null && currentExcelVersion !== null;
  let dependenciesInstalled = false;
  let installError = null;

  if (!dependenciesReady && !checkOnly) {
    reporter.note(`正在安装依赖（@playwright/test@${playwrightVersion}, exceljs）到 ${home} …`);
    writeToolchainManifest(home, { playwrightVersion });
    const result = await installDependencies({
      dir: home,
      onLine: (line) => reporter.note(`  npm: ${line}`),
    });
    if (!result.ok) {
      installError = result.stderr || `npm 退出码 ${result.code}`;
      reporter.note(`❌ 依赖安装失败：${installError}`);
    } else {
      dependenciesInstalled = true;
      reporter.note('✅ 依赖安装完成。');
    }
  }

  const testVersion = installedVersion(home, '@playwright/test');
  const excelVersion = installedVersion(home, 'exceljs');
  const depsOk = testVersion !== null && excelVersion !== null;

  if (installError !== null) {
    process.exit(
      reporter.finish({
        ok: false,
        ready: false,
        home,
        error: `依赖安装失败：${installError}`,
        hint:
          '常见原因：网络不可达、需要公司代理、或 npm 未安装。' +
          '可设置 npm_config_proxy / npm_config_https_proxy 后重试，详见 references/troubleshooting.md。',
      }),
    );
  }

  // --- Browsers ------------------------------------------------------------
  const cacheDir = browserCacheDir(process.platform, process.env);
  const probe = probeBrowsers({ dir: home, browsers, cacheDir, env: process.env });

  let browsersInstalled = false;
  let browserInstallError = null;

  if (probe.missing.length > 0 && installMissingBrowsers && !checkOnly) {
    reporter.note(`正在下载浏览器：${probe.missing.join(', ')} …`);
    const result = await installBrowsers({
      dir: home,
      browsers: probe.missing,
      onLine: (line) => reporter.note(`  playwright: ${line}`),
    });
    if (!result.ok) {
      browserInstallError = result.stderr || `playwright install 退出码 ${result.code}`;
      reporter.note(`❌ 浏览器下载失败：${browserInstallError}`);
    } else {
      browsersInstalled = true;
      reporter.note('✅ 浏览器下载完成。');
    }
  }

  const finalProbe = probeBrowsers({ dir: home, browsers, cacheDir, env: process.env });
  const ready = depsOk && finalProbe.missing.length === 0;

  if (!ready && finalProbe.missing.length > 0) {
    reporter.note(
      `⚠️  以下浏览器尚未下载：${finalProbe.missing.join(', ')}（${describeDownloadSize(finalProbe.missing)}）。`,
    );
    reporter.note('   请先征得用户同意，再以 --install-browsers 重新运行。');
  }
  if (finalProbe.stale.length > 0) {
    reporter.note(
      `⚠️  以下浏览器缓存版本与 Playwright ${playwrightVersion} 不匹配，建议重新下载：${finalProbe.stale.join(', ')}。`,
    );
  }
  if (finalProbe.unknown.length > 0) {
    reporter.note(
      `ℹ️  以下浏览器已有缓存，但依赖尚未安装，无法确认版本是否匹配：${finalProbe.unknown.join(', ')}。` +
        ' 安装依赖后重新自检即可确认。',
    );
  }

  // --- Optional launch probe ------------------------------------------------
  // Only a real launch reveals a sandbox that blocks the browser. Skipped by
  // default because it costs a few seconds and CI does not need it.
  let launch = null;
  if (probeLaunchFlag) {
    if (!depsOk) {
      launch = {
        skipped: true,
        reason: '依赖尚未安装，无法探测浏览器启动。',
      };
      reporter.note('ℹ️  依赖未就绪，跳过浏览器启动探测。');
    } else {
      reporter.note(`正在探测浏览器能否启动（${browsers[0] ?? 'chromium'}）…`);
      const probed = await probeBothModes({ home, browserName: browsers[0] ?? 'chromium' });
      launch = probed;
      reporter.note(probed.summary);
      if (probed.mustAskUser && probed.headed.action) {
        reporter.note(`   → ${probed.headed.action}`);
      }
    }
  }

  const result = {
    ok: browserInstallError === null,
    ready,
    mode: checkOnly ? 'check' : 'install',
    home,
    writable,
    node: { version: process.versions.node, ok: nodeOk, minimum: MIN_NODE_MAJOR },
    dependencies: {
      ready: depsOk,
      installed: dependenciesInstalled,
      playwrightVersion: testVersion,
      playwrightVersionPinned: playwrightVersion,
      exceljsVersion: excelVersion,
      manifest: path.join(home, 'package.json'),
    },
    browsers: {
      requested: browsers,
      available: finalProbe.available,
      missing: finalProbe.missing,
      stale: finalProbe.stale,
      unknown: finalProbe.unknown,
      details: finalProbe.details,
      cacheDir: finalProbe.cacheDir,
      installed: browsersInstalled,
      error: browserInstallError,
    },
    launch,
    needsBrowserInstall: finalProbe.missing,
    downloadEstimate: finalProbe.missing.length > 0 ? describeDownloadSize(finalProbe.missing) : null,
    nextStep: ready
      ? '环境就绪，可以开始解析用例并生成测试计划。'
      : checkOnly
        ? '请以不带 --check 的方式运行 bootstrap.mjs 完成安装。'
        : `请征得用户同意后，以 --install-browsers 重新运行以下载：${finalProbe.missing.join(', ')}。`,
  };

  process.exit(reporter.finish(result));
}

main().catch((error) => {
  process.exit(
    reporter.finish({
      ok: false,
      error: error?.message ?? String(error),
      hint: '这是未预期的错误，请把完整信息反馈给 skill 维护者。',
    }),
  );
});
