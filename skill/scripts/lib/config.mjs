/**
 * Run configuration: defaults, `e2e.config.json` loading, environment
 * interpolation, and validation.
 *
 * Credentials are never stored literally. A config file references environment
 * variables with `${VAR}` and the resolved secrets stay in memory only.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Browsers Playwright can drive; `chromium` is the only one we preinstall. */
export const SUPPORTED_BROWSERS = ['chromium', 'firefox', 'webkit'];

/** Defaults applied to every run. */
export const DEFAULT_CONFIG = {
  baseURL: '',
  browsers: ['chromium'],
  headless: true,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  timeout: 30000,
  expectTimeout: 5000,
  retries: 1,
  workers: 1,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  ignoreHTTPSErrors: false,
  slowMo: 0,
  auth: {
    enabled: false,
    loginUrl: '',
    username: '',
    password: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successUrl: '',
    storageState: '',
    saveAfterLogin: true,
  },
};

const TRACE_MODES = new Set(['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries']);
const SCREENSHOT_MODES = new Set(['off', 'on', 'only-on-failure']);
const VIDEO_MODES = new Set(['off', 'on', 'retain-on-failure', 'on-first-retry']);

/**
 * Replace `${VAR}` and `$VAR` references using the supplied environment.
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} missing collects names of unset variables
 * @returns {unknown}
 */
export function interpolate(value, env, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
      const name = braced ?? bare;
      const resolved = env[name];
      if (resolved === undefined || resolved === '') {
        if (!missing.includes(name)) missing.push(name);
        return match;
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env, missing));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = interpolate(inner, env, missing);
    return out;
  }
  return value;
}

/**
 * Deep-merge a partial config over the defaults.
 * @param {Record<string, unknown>} partial
 * @returns {Record<string, any>}
 */
export function mergeConfig(partial) {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  merged.viewport = { ...DEFAULT_CONFIG.viewport, ...(partial?.viewport ?? {}) };
  merged.auth = { ...DEFAULT_CONFIG.auth, ...(partial?.auth ?? {}) };
  return merged;
}

/**
 * Validate a merged config.
 * @param {Record<string, any>} config
 * @returns {string[]} problems; empty means valid
 */
export function validateConfig(config) {
  const problems = [];

  if (!Array.isArray(config.browsers) || config.browsers.length === 0) {
    problems.push('browsers 必须是非空数组，例如 ["chromium"]。');
  } else {
    for (const browser of config.browsers) {
      if (!SUPPORTED_BROWSERS.includes(browser)) {
        problems.push(`不支持的浏览器 "${browser}"，可选：${SUPPORTED_BROWSERS.join(', ')}。`);
      }
    }
  }

  if (typeof config.headless !== 'boolean') problems.push('headless 必须是布尔值。');
  for (const field of ['timeout', 'expectTimeout', 'retries', 'workers']) {
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      problems.push(`${field} 必须是非负数字。`);
    }
  }
  if (config.workers < 1) problems.push('workers 至少为 1。');
  if (!TRACE_MODES.has(config.trace)) problems.push(`trace 取值非法：${config.trace}。`);
  if (!SCREENSHOT_MODES.has(config.screenshot)) problems.push(`screenshot 取值非法：${config.screenshot}。`);
  if (!VIDEO_MODES.has(config.video)) problems.push(`video 取值非法：${config.video}。`);

  if (config.auth?.enabled) {
    if (String(config.auth.loginUrl ?? '').trim() === '') {
      problems.push('auth.enabled 为 true 时必须提供 auth.loginUrl。');
    }
    const hasCredentials = String(config.auth.username ?? '') !== '' && String(config.auth.password ?? '') !== '';
    if (!hasCredentials) {
      problems.push(
        'auth.enabled 为 true 时必须提供 auth.username 与 auth.password；' +
          '推荐写成 "${E2E_USERNAME}" 并通过环境变量注入。',
      );
    }
  }

  return problems;
}

/**
 * Read a config file from disk.
 * @param {string} file
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{config: Record<string, any>, warnings: string[], missingEnv: string[], source: string}}
 */
export function loadConfigFile(file, env = process.env) {
  const absolute = path.resolve(file);
  const text = fs.readFileSync(absolute, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${absolute} 不是合法 JSON：${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${absolute} 的顶层必须是 JSON 对象。`);
  }

  const missingEnv = [];
  const interpolated = interpolate(parsed, env, missingEnv);
  const config = mergeConfig(interpolated);

  const warnings = [];
  if (missingEnv.length > 0) {
    warnings.push(`以下环境变量未设置，配置中的占位符未被替换：${missingEnv.join(', ')}。`);
  }
  return { config, warnings, missingEnv, source: absolute };
}

/**
 * Build a config from CLI flags and an optional config file.
 *
 * Precedence: CLI flags > config file > defaults.
 *
 * @param {{flags: Record<string, string|boolean>, env?: NodeJS.ProcessEnv}} options
 * @returns {{config: Record<string, any>, warnings: string[], problems: string[], source: string|null}}
 */
export function buildConfig({ flags, env = process.env }) {
  let base = mergeConfig({});
  const warnings = [];
  let source = null;

  const configFile = typeof flags.config === 'string' ? flags.config : null;
  if (configFile !== null) {
    const loaded = loadConfigFile(configFile, env);
    base = loaded.config;
    warnings.push(...loaded.warnings);
    source = loaded.source;
  }

  if (typeof flags.url === 'string' && flags.url.trim() !== '') base.baseURL = flags.url.trim();
  if (typeof flags['base-url'] === 'string' && flags['base-url'].trim() !== '') {
    base.baseURL = flags['base-url'].trim();
  }
  if (typeof flags.browsers === 'string') {
    base.browsers = flags.browsers.split(/[,，\s]+/).map((b) => b.trim()).filter(Boolean);
  }
  if (flags.headed === true) base.headless = false;
  if (flags['headless'] === 'false') base.headless = false;
  if (typeof flags.retries === 'string') base.retries = Number(flags.retries);
  if (typeof flags.workers === 'string') base.workers = Number(flags.workers);
  if (typeof flags.timeout === 'string') base.timeout = Number(flags.timeout);

  const problems = validateConfig(base);
  if (String(base.baseURL ?? '').trim() === '') {
    problems.push('缺少被测网址：请提供 --url，或在配置文件中设置 baseURL。');
  }

  return { config: base, warnings, problems, source };
}

/**
 * Resolve the base URL of the target under test, preferring the config file.
 * @param {Record<string, any>} config
 * @returns {string}
 */
export function effectiveBaseURL(config) {
  return String(config.baseURL ?? '').trim().replace(/\/+$/, '');
}

/**
 * Render the example config shipped in `assets/`.
 * @returns {string}
 */
export function exampleConfigText() {
  return `${JSON.stringify(
    {
      baseURL: 'https://your-app.example.com',
      browsers: ['chromium'],
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      timeout: 30000,
      expectTimeout: 5000,
      retries: 1,
      workers: 1,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
      ignoreHTTPSErrors: false,
      auth: {
        enabled: false,
        loginUrl: '/login',
        username: '${E2E_USERNAME}',
        password: '${E2E_PASSWORD}',
        usernameSelector: '',
        passwordSelector: '',
        submitSelector: '',
        successUrl: '',
        storageState: '',
        saveAfterLogin: true,
      },
    },
    null,
    2,
  )}\n`;
}
