/**
 * Resolve dependencies installed in the skill home rather than next to these
 * scripts.
 *
 * The skill bundle lives at `<dshHome>/skills/playwright-e2e/` while the
 * installed toolchain lives at `<home>/node_modules/`. Plain ESM resolution
 * would walk up from the bundle and never see it, so every runtime dependency is
 * resolved explicitly through a `createRequire` rooted at the home directory.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { resolveHome } from './paths.mjs';

/**
 * Resolve the on-disk entry point of a dependency installed in the skill home.
 * @param {string} home
 * @param {string} name
 * @returns {string|null} absolute file path, or null when not installed
 */
export function dependencyPath(home, name) {
  const require = createRequire(path.join(home, 'package.json'));
  try {
    return require.resolve(name);
  } catch {
    return null;
  }
}

/**
 * Import a dependency from the skill home.
 * @param {string} name
 * @param {{home?: string}} [options]
 * @returns {Promise<any>} the module namespace, or the CJS export as `default`
 * @throws {Error} with an actionable message when the dependency is missing
 */
export async function loadDependency(name, options = {}) {
  const home = options.home ?? resolveHome(process.env);
  const resolved = dependencyPath(home, name);
  if (resolved === null) {
    throw new Error(
      `依赖 "${name}" 未安装（查找位置：${path.join(home, 'node_modules')}）。` +
        '请先运行：node scripts/bootstrap.mjs',
    );
  }
  return import(pathToFileURL(resolved).href);
}

/**
 * Import the Playwright browser API (`chromium`/`firefox`/`webkit`).
 * @param {{home?: string}} [options]
 * @returns {Promise<{chromium: any, firefox: any, webkit: any, devices: any}>}
 */
export async function loadPlaywright(options = {}) {
  const module = await loadDependency('playwright', options);
  const api = module?.chromium ? module : module?.default;
  if (!api?.chromium) {
    throw new Error('已安装的 playwright 包没有导出 chromium/firefox/webkit，请重新运行 bootstrap.mjs。');
  }
  return api;
}

/**
 * Import the exceljs workbook class.
 * @param {{home?: string}} [options]
 * @returns {Promise<any>}
 */
export async function loadExcelJS(options = {}) {
  const module = await loadDependency('exceljs', options);
  const ExcelJS = module?.Workbook ? module : module?.default;
  if (!ExcelJS?.Workbook) {
    throw new Error('已安装的 exceljs 包没有导出 Workbook，请重新运行 bootstrap.mjs。');
  }
  return ExcelJS;
}
