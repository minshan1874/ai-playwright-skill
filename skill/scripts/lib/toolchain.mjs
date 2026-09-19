/**
 * Toolchain management: install `@playwright/test` + `exceljs` once into the
 * skill home, and probe which browsers are already downloaded.
 *
 * Two constraints shape this module:
 *   1. The npm cache is redirected into the skill home, because the host cache
 *      (`~/.npm`) may be unwritable in a sandboxed session.
 *   2. The Playwright version is pinned so the browser revisions match whatever
 *      is already in the shared `ms-playwright` cache, avoiding a large download.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_EXCELJS_RANGE,
  DEFAULT_PLAYWRIGHT_VERSION,
  browserCacheDir,
  npmCacheDir,
} from './paths.mjs';

// Re-exported so callers only need to import from the toolchain module.
export { DEFAULT_EXCELJS_RANGE, DEFAULT_PLAYWRIGHT_VERSION };

/**
 * Run a command, streaming output to the reporter.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, onLine?: (line: string) => void}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const forward = (chunk, sink) => {
      const text = chunk.toString();
      sink(text);
      if (options.onLine) {
        for (const line of text.split('\n')) {
          const trimmed = line.trimEnd();
          if (trimmed !== '') options.onLine(trimmed);
        }
      }
    };

    child.stdout.on('data', (chunk) => forward(chunk, (t) => (stdout += t)));
    child.stderr.on('data', (chunk) => forward(chunk, (t) => (stderr += t)));
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve({ code: 127, stdout, stderr });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Read the version of a package installed under a node_modules tree.
 * @param {string} dir project root containing node_modules
 * @param {string} name package name
 * @returns {string|null}
 */
export function installedVersion(dir, name) {
  const manifest = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** `name` field of the manifest this skill owns. */
export const TOOLCHAIN_MANIFEST_NAME = 'playwright-e2e-toolchain';

/**
 * Check that the skill home does not already belong to someone else.
 *
 * `bootstrap.mjs` writes its own `package.json` into the home, so pointing
 * `PLAYWRIGHT_E2E_HOME` at a real project directory would clobber that project's
 * manifest. Refuse instead of destroying data.
 *
 * @param {string} dir
 * @returns {{safe: true} | {safe: false, reason: string, existingName: string|null}}
 */
export function assertSafeToolchainDir(dir) {
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) return { safe: true };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // An unparseable manifest is still someone else's file — do not touch it.
    return {
      safe: false,
      reason: `${manifestPath} 已存在但不是合法 JSON，无法确认它属于本 skill。`,
      existingName: null,
    };
  }

  if (parsed?.name === TOOLCHAIN_MANIFEST_NAME) return { safe: true };

  return {
    safe: false,
    reason:
      `${manifestPath} 已存在，且其 name 是 "${parsed?.name ?? '(未设置)'}" 而不是 ` +
      `"${TOOLCHAIN_MANIFEST_NAME}"。`,
    existingName: typeof parsed?.name === 'string' ? parsed.name : null,
  };
}

/**
 * Write the toolchain package.json that pins our dependencies.
 *
 * Callers must check {@link assertSafeToolchainDir} first: this overwrites.
 *
 * @param {string} dir
 * @param {{playwrightVersion?: string, exceljsRange?: string}} [options]
 */
export function writeToolchainManifest(dir, options = {}) {
  const manifest = {
    name: TOOLCHAIN_MANIFEST_NAME,
    private: true,
    version: '1.0.0',
    description: 'Isolated toolchain for the playwright-e2e skill. Do not edit by hand.',
    dependencies: {
      '@playwright/test': options.playwrightVersion ?? DEFAULT_PLAYWRIGHT_VERSION,
      exceljs: options.exceljsRange ?? DEFAULT_EXCELJS_RANGE,
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Install the toolchain dependencies.
 * @param {{dir: string, onLine?: (line: string) => void, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{ok: boolean, code: number, stderr: string, cache: string}>}
 */
export async function installDependencies({ dir, onLine, env = process.env }) {
  const cache = npmCacheDir(dir);
  fs.mkdirSync(cache, { recursive: true });

  const result = await runCommand(
    'npm',
    ['install', '--prefix', dir, '--cache', cache, '--no-audit', '--no-fund', '--loglevel=error'],
    {
      cwd: dir,
      onLine,
      env: { ...env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
    },
  );

  return { ok: result.code === 0, code: result.code, stderr: result.stderr.trim(), cache };
}

/**
 * Locate `browsers.json`, which declares the browser revisions this Playwright
 * build expects.
 * @param {string} dir toolchain root
 * @returns {string|null}
 */
export function findBrowsersJson(dir) {
  const candidates = [
    path.join(dir, 'node_modules', 'playwright-core', 'browsers.json'),
    path.join(dir, 'node_modules', 'playwright', 'node_modules', 'playwright-core', 'browsers.json'),
    path.join(dir, 'node_modules', '@playwright', 'test', 'node_modules', 'playwright-core', 'browsers.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read the browser revisions required by the installed Playwright.
 * @param {string} dir toolchain root
 * @returns {Record<string, string>} browser name -> revision
 */
export function requiredRevisions(dir) {
  const file = findBrowsersJson(dir);
  if (file === null) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const entry of parsed.browsers ?? []) {
      if (entry?.name && entry?.revision) out[entry.name] = String(entry.revision);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * List the browser revisions already present in the shared cache.
 * @param {string} cacheDir
 * @returns {Record<string, string[]>} browser name -> installed revisions
 */
export function installedRevisions(cacheDir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^(.+?)-(\d+)$/.exec(entry.name);
    if (match === null) continue;
    const [, name, revision] = match;
    if (!out[name]) out[name] = [];
    out[name].push(revision);
  }
  return out;
}

/**
 * Work out which requested browsers can run without downloading anything.
 * @param {{dir: string, browsers: string[], cacheDir?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv}} options
 * @returns {{available: string[], missing: string[], stale: string[], unknown: string[], details: object[], cacheDir: string}}
 */
export function probeBrowsers({ dir, browsers, cacheDir, platform = process.platform, env = process.env }) {
  const resolvedCache = cacheDir ?? browserCacheDir(platform, env);
  const required = requiredRevisions(dir);
  const installed = installedRevisions(resolvedCache);

  const available = [];
  const missing = [];
  const stale = [];
  const unknown = [];
  const details = [];

  for (const browser of browsers) {
    const requiredRevision = required[browser];
    const present = installed[browser] ?? [];
    const anyPresent = present.length > 0;

    let status;
    if (requiredRevision === undefined) {
      // Without an installed Playwright we cannot know the expected revision.
      // Report it as unknown rather than pretending the cache is wrong.
      status = anyPresent ? 'unknown' : 'absent';
    } else if (present.includes(requiredRevision)) {
      status = 'ready';
    } else {
      status = anyPresent ? 'revision-mismatch' : 'absent';
    }

    if (status === 'ready') available.push(browser);
    else if (status === 'revision-mismatch') stale.push(browser);
    else if (status === 'unknown') unknown.push(browser);
    else missing.push(browser);

    details.push({
      browser,
      requiredRevision: requiredRevision ?? null,
      installedRevisions: present,
      status,
    });
  }

  return { available, missing, stale, unknown, details, cacheDir: resolvedCache };
}

/**
 * Install the given browsers into the shared cache.
 * @param {{dir: string, browsers: string[], onLine?: (line: string) => void, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{ok: boolean, code: number, stderr: string}>}
 */
export async function installBrowsers({ dir, browsers, onLine, env = process.env }) {
  const cli = path.join(dir, 'node_modules', 'playwright', 'cli.js');
  const target = fs.existsSync(cli) ? cli : path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = await runCommand(process.execPath, [target, 'install', ...browsers], {
    cwd: dir,
    onLine,
    env,
  });
  return { ok: result.code === 0, code: result.code, stderr: result.stderr.trim() };
}

/**
 * Resolve the Playwright CLI entry point for running tests.
 * @param {string} dir toolchain root
 * @returns {string|null}
 */
export function resolvePlaywrightCli(dir) {
  const candidates = [
    path.join(dir, 'node_modules', 'playwright', 'cli.js'),
    path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Estimate the download size of browsers that are not cached yet.
 * @param {string[]} browsers
 * @returns {string}
 */
export function describeDownloadSize(browsers) {
  const sizes = { chromium: '约 150 MB', firefox: '约 90 MB', webkit: '约 80 MB' };
  return browsers.map((browser) => `${browser}（${sizes[browser] ?? '未知大小'}）`).join('、');
}
