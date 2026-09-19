/**
 * Path resolution for the playwright-e2e skill.
 *
 * Everything the skill writes lives under a single home directory, so the
 * target project is never touched. The home is relocatable through
 * PLAYWRIGHT_E2E_HOME, which is also the escape hatch when the agent sandbox
 * denies writes outside the session workspace.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directory name used under the DSH home by default. */
export const HOME_DIR_NAME = 'playwright-e2e';

/** Pinned Playwright version: matches the browser revisions we probe for. */
export const DEFAULT_PLAYWRIGHT_VERSION = '1.63.0';

/** Pinned exceljs range used for Excel/CSV parsing. */
export const DEFAULT_EXCELJS_RANGE = '^4.4.0';

/**
 * Resolve the skill's home directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveHome(env = process.env) {
  const override = env.PLAYWRIGHT_E2E_HOME;
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(expandTilde(override.trim(), env));
  }
  const dshHome = env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    return path.join(path.resolve(expandTilde(dshHome.trim(), env)), HOME_DIR_NAME);
  }
  return path.join(userHome(env), '.dsh', HOME_DIR_NAME);
}

/**
 * Resolve the user's home directory, preferring the supplied environment over
 * the process's own so callers (and tests) can control it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function userHome(env = process.env) {
  const fromEnv = env.HOME || env.USERPROFILE;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return os.homedir();
}

/** @returns {string} directory holding node_modules + package.json */
export function toolchainDir(home) {
  return home;
}

/** @returns {string} directory holding one subdirectory per run */
export function runsDir(home) {
  return path.join(home, 'runs');
}

/** @returns {string} directory holding reusable storageState files */
export function authDir(home) {
  return path.join(home, 'auth');
}

/** @returns {string} npm cache kept inside the home to dodge host cache permissions */
export function npmCacheDir(home) {
  return path.join(home, '.npm-cache');
}

/**
 * Resolve the browser download cache shared by Playwright.
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function browserCacheDir(platform = process.platform, env = process.env) {
  if (typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' && env.PLAYWRIGHT_BROWSERS_PATH.trim() !== '') {
    return path.resolve(expandTilde(env.PLAYWRIGHT_BROWSERS_PATH.trim(), env));
  }
  if (platform === 'darwin') return path.join(userHome(env), 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(userHome(env), 'AppData', 'Local');
    return path.join(localAppData, 'ms-playwright');
  }
  const xdg = env.XDG_CACHE_HOME || path.join(userHome(env), '.cache');
  return path.join(xdg, 'ms-playwright');
}

/** Matches a string that carries an explicit scheme, e.g. `https://x`. */
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Matches a bare hostname such as `example.com` or `10.0.0.1:8080/path`. */
const HOST_LIKE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:[/?#].*)?$/i;

/**
 * Decide whether to interpret a string as a URL.
 *
 * The check is deliberately conservative: `new URL('http://订单系统')` succeeds
 * and yields a punycode host, which would turn a Chinese project name into
 * gibberish. Only clearly URL-shaped ASCII input is parsed.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeUrl(value) {
  return SCHEME_LIKE.test(value) || HOST_LIKE.test(value);
}

/**
 * Turn a URL, project directory, or free-form name into a stable directory slug.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return 'project';

  let source = raw;
  if (looksLikeUrl(raw)) {
    try {
      const url = new URL(SCHEME_LIKE.test(raw) ? raw : `http://${raw}`);
      if (url.hostname) source = url.hostname;
    } catch {
      // Not actually parseable: fall through and slugify the raw string.
    }
  }

  const slug = source
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (slug === '') return 'project';
  return slug.slice(0, 60).replace(/-+$/g, '') || 'project';
}

/**
 * Format a timestamp the way run directories use it.
 * @param {Date} [date]
 * @returns {string} `YYYYMMDD-HHmmss`
 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Compose a run directory path.
 * @param {string} home
 * @param {string} slug
 * @param {Date} [date]
 * @returns {string}
 */
export function runDirPath(home, slug, date = new Date()) {
  return path.join(runsDir(home), `${slugify(slug)}-${timestamp(date)}`);
}

/** Paths inside one run directory. */
export function runPaths(runDir) {
  return {
    dir: runDir,
    plan: path.join(runDir, 'plan.md'),
    cases: path.join(runDir, 'cases.json'),
    config: path.join(runDir, 'e2e.config.json'),
    explore: path.join(runDir, 'explore'),
    specs: path.join(runDir, 'specs'),
    fixtures: path.join(runDir, 'specs', '_fixtures.ts'),
    playwrightConfig: path.join(runDir, 'playwright.config.ts'),
    testResults: path.join(runDir, 'test-results'),
    jsonResults: path.join(runDir, 'test-results', 'results.json'),
    summary: path.join(runDir, 'results-summary.json'),
    htmlReport: path.join(runDir, 'playwright-report'),
    report: path.join(runDir, 'report.md'),
  };
}

/** Path of the reusable storageState file for a project slug. */
export function storageStatePath(home, slug) {
  return path.join(authDir(home), `${slugify(slug)}.json`);
}

/**
 * Expand a leading `~` against the given environment.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function expandTilde(value, env = process.env) {
  if (value === '~') return userHome(env);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(userHome(env), value.slice(2));
  }
  return value;
}

/**
 * Create every directory the skill needs.
 * @param {string} home
 * @returns {{home: string, toolchain: string, runs: string, auth: string, npmCache: string}}
 */
export function ensureHomeLayout(home) {
  const layout = {
    home,
    toolchain: toolchainDir(home),
    runs: runsDir(home),
    auth: authDir(home),
    npmCache: npmCacheDir(home),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  return layout;
}

/**
 * Probe whether a directory can actually be written to.
 *
 * The agent sandbox reports denials as ordinary errno values, so this returns a
 * structured result instead of throwing: callers turn it into actionable advice.
 *
 * @param {string} dir
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function probeWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (error) {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Best effort: the probe file may not exist.
    }
    return {
      ok: false,
      code: error?.code ?? 'UNKNOWN',
      message: error?.message ?? String(error),
    };
  }
}

/**
 * Explain a denied write and how to recover.
 * @param {string} dir
 * @param {{code: string, message: string}} failure
 * @returns {string}
 */
export function describeWriteDenial(dir, failure) {
  return [
    `无法写入 ${dir}（${failure.code}）。`,
    '这通常是 agent 沙箱只允许写入会话工作区导致的，而不是磁盘权限问题。两种修复方式：',
    '  1) 允许本次命令以更宽的文件权限运行（在 DSH 会话中批准提权）；',
    `  2) 把运行目录放到可写位置：export PLAYWRIGHT_E2E_HOME="<可写目录>" 后重试。`,
  ].join('\n');
}
