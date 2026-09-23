/**
 * Run configuration: defaults, `e2e.config.json` loading, environment
 * interpolation, and validation.
 *
 * Credentials are never stored literally. A config file references environment
 * variables with `${VAR}` and the resolved secrets stay in memory only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { validateStep } from './steps.mjs';

/** Browsers Playwright can drive; `chromium` is the only one we preinstall. */
export const SUPPORTED_BROWSERS = ['chromium', 'firefox', 'webkit'];

/** How a run obtains (or reuses) a logged-in session. */
export const AUTH_MODE = {
  none: 'none',
  storageState: 'storage-state',
  login: 'login',
};

/** Defaults applied to every run. */
export const DEFAULT_CONFIG = {
  baseURL: '',
  browsers: ['chromium'],
  // Headed by default: the tool is meant to be usable by anyone, and seeing the
  // browser work is what makes a run trustworthy. CI and headless servers
  // override this with `--headless`, since they have no display.
  headless: false,
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
  // Milliseconds to slow each action by. Only useful together with headed mode.
  slowMo: 0,
  auth: {
    enabled: false,
    loginUrl: '',
    username: '',
    password: '',
    usernameSelector: '',
    // Multi-step logins (account -> Continue -> password -> submit) need the
    // intermediate click; single-page logins simply leave this empty.
    continueSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successUrl: '',
    // A stable post-login element (account menu, model config, "Upgrade") is a
    // far better success signal than a URL that redirects through three hops.
    successSelector: '',
    storageState: '',
    saveAfterLogin: true,
    // Ignore an existing storageState and log in again.
    forceLogin: false,
    // Full escape hatch: an explicit step list, same vocabulary as explore steps.
    steps: [],
  },
  // Asynchronous work started by the product under test (image generation, batch
  // jobs, exports) is not a page interaction: submission and completion deserve
  // separate budgets, and "still running after 60s" must not read as "failed".
  asyncTasks: {
    submitTimeout: 30000,
    completionTimeout: 180000,
    pollInterval: 2000,
  },
  attempts: {
    // How many previous execution attempts to keep on disk.
    keep: 10,
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
  merged.asyncTasks = { ...DEFAULT_CONFIG.asyncTasks, ...(partial?.asyncTasks ?? {}) };
  merged.attempts = { ...DEFAULT_CONFIG.attempts, ...(partial?.attempts ?? {}) };
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
  for (const field of ['timeout', 'expectTimeout', 'retries', 'workers', 'slowMo']) {
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      problems.push(`${field} 必须是非负数字。`);
    }
  }
  if (config.workers < 1) problems.push('workers 至少为 1。');
  if (!TRACE_MODES.has(config.trace)) problems.push(`trace 取值非法：${config.trace}。`);
  if (!SCREENSHOT_MODES.has(config.screenshot)) problems.push(`screenshot 取值非法：${config.screenshot}。`);
  if (!VIDEO_MODES.has(config.video)) problems.push(`video 取值非法：${config.video}。`);

  if (config.auth?.enabled) {
    const storageState = String(config.auth.storageState ?? '').trim();
    const hasCredentials = String(config.auth.username ?? '') !== '' && String(config.auth.password ?? '') !== '';
    const hasSteps = Array.isArray(config.auth.steps) && config.auth.steps.length > 0;

    // A configured storageState means the session already exists: no login is
    // performed, so demanding credentials for it would be pure ceremony. They are
    // only required when the skill must actually log in — which is exactly the
    // case when no storageState is configured.
    if (storageState === '') {
      if (String(config.auth.loginUrl ?? '').trim() === '') {
        problems.push('auth.enabled 为 true 时必须提供 auth.loginUrl，或改为只复用已有登录态：{"auth": {"enabled": false, "storageState": "..."}}。');
      }
      if (!hasCredentials && !hasSteps) {
        problems.push(
          'auth.enabled 为 true 时必须提供 auth.username 与 auth.password（推荐写成 "${E2E_USERNAME}" / "${E2E_PASSWORD}" 并通过环境变量注入），' +
            '或用 auth.steps 自定义登录步骤。',
        );
      }
    }
  }

  for (const field of ['submitTimeout', 'completionTimeout', 'pollInterval']) {
    const value = config.asyncTasks?.[field];
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`asyncTasks.${field} 必须是正数（毫秒）。`);
    }
  }
  if (Number.isFinite(config.asyncTasks?.submitTimeout) && Number.isFinite(config.asyncTasks?.completionTimeout)) {
    if (config.asyncTasks.submitTimeout > config.asyncTasks.completionTimeout) {
      problems.push('asyncTasks.submitTimeout 不应大于 completionTimeout：提交比生成还慢通常意味着配置写反了。');
    }
  }
  if (!Number.isFinite(config.attempts?.keep) || config.attempts.keep < 1) {
    problems.push('attempts.keep 必须是不小于 1 的整数。');
  }

  if (config.auth?.steps !== undefined && !Array.isArray(config.auth.steps)) {
    problems.push('auth.steps 必须是数组。');
  } else if (Array.isArray(config.auth?.steps)) {
    config.auth.steps.forEach((step, index) => {
      const problem = validateStep(step, index);
      if (problem !== null) problems.push(`auth.steps：${problem}`);
    });
  }

  return problems;
}

/**
 * Resolve how this run will obtain a logged-in session.
 *
 * This is the filesystem-aware half of auth handling: `validateConfig` can only
 * check internal consistency, while whether a `storageState` file actually exists
 * decides between "reuse it" and "log in again".
 *
 * @param {Record<string, any>} config
 * @param {{runDir: string, home: string, configDir?: string}} options
 * @returns {{
 *   mode: 'none'|'storage-state'|'login',
 *   storageStatePath: string|null,
 *   needsLoginSetup: boolean,
 *   problems: string[],
 *   notes: string[],
 *   label: string,
 * }}
 */
export function resolveAuth(config, options) {
  const { runDir, home, configDir = runDir } = options;
  const auth = config.auth ?? {};
  const problems = [];
  const notes = [];

  /** Resolve a configured path against the config file's directory. */
  const resolveConfigured = (value) => {
    const raw = String(value ?? '').trim();
    if (raw === '') return null;
    if (raw.startsWith('~')) return path.join(home, raw.replace(/^~[/\\]?/, ''));
    return path.isAbsolute(raw) ? raw : path.resolve(configDir, raw);
  };

  const configured = resolveConfigured(auth.storageState);
  const exists = configured !== null && fs.existsSync(configured);

  // Default location, so "log in once, reuse forever" works without any config.
  const defaultPath = path.join(home, 'auth', `${path.basename(runDir).replace(/-\d{8}-\d{6}$/, '')}.json`);
  const wantsLogin = auth.enabled === true;
  const forceLogin = auth.forceLogin === true;
  const saveAfterLogin = auth.saveAfterLogin !== false;
  const reusableDefault = !forceLogin && fs.existsSync(defaultPath) ? defaultPath : null;

  if (configured !== null && exists && !forceLogin) {
    return {
      mode: AUTH_MODE.storageState,
      storageStatePath: configured,
      needsLoginSetup: false,
      problems,
      notes: [`复用已有登录态：${configured}`],
      label: `复用登录态（${configured}）`,
    };
  }

  if (configured !== null && exists && forceLogin) {
    notes.push(`auth.forceLogin 为 true，忽略已有登录态 ${configured}，重新登录。`);
  }

  if (configured !== null && !exists) {
    if (!wantsLogin) {
      problems.push(
        `auth.storageState 指向的文件不存在：${configured}。` +
          '请先用 playwright codegen 手工登录导出该文件（见 references/workflow.md），' +
          '或设置 auth.enabled: true 并提供账号密码，让 skill 自动登录。',
      );
      return {
        mode: AUTH_MODE.none,
        storageStatePath: null,
        needsLoginSetup: false,
        problems,
        notes,
        label: '未启用登录',
      };
    }
    // An explicitly configured path wins over the default one: the user asked for
    // the session to live there, so log in and write it there.
    notes.push(`配置的登录态文件不存在（${configured}），将重新登录并保存。`);
    return {
      mode: AUTH_MODE.login,
      storageStatePath: configured,
      needsLoginSetup: saveAfterLogin,
      problems,
      notes,
      label: saveAfterLogin ? `自动登录并保存登录态（${configured}）` : '自动登录（不保存登录态）',
    };
  }

  // "Log in once, reuse from then on" must survive an `enabled: true` config:
  // otherwise every run pays for a login and a rotated session can never settle.
  if (reusableDefault !== null) {
    return {
      mode: AUTH_MODE.storageState,
      storageStatePath: reusableDefault,
      needsLoginSetup: false,
      problems,
      notes: [`发现可复用的登录态：${reusableDefault}`],
      label: `复用登录态（${reusableDefault}）`,
    };
  }

  if (wantsLogin) {
    return {
      mode: AUTH_MODE.login,
      storageStatePath: defaultPath,
      needsLoginSetup: saveAfterLogin,
      problems,
      notes,
      label: saveAfterLogin ? `自动登录并保存登录态（${defaultPath}）` : '自动登录（不保存登录态）',
    };
  }

  return {
    mode: AUTH_MODE.none,
    storageStatePath: null,
    needsLoginSetup: false,
    problems,
    notes,
    label: '未启用登录',
  };
}

/**
 * Strip credentials out of a config before it is written to disk.
 *
 * Step values are included: `auth.steps` may legitimately contain the password
 * placeholder, and after interpolation that is a real secret.
 *
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function redactConfig(config) {
  const snapshot = JSON.parse(JSON.stringify(config));
  const secrets = [config?.auth?.username, config?.auth?.password].filter(
    (value) => typeof value === 'string' && value !== '',
  );
  if (snapshot.auth) {
    snapshot.auth.username = snapshot.auth.username ? '<已提供>' : '';
    snapshot.auth.password = snapshot.auth.password ? '<已提供>' : '';
    if (Array.isArray(snapshot.auth.steps)) {
      snapshot.auth.steps = snapshot.auth.steps.map((step) => {
        if (step === null || typeof step !== 'object') return step;
        const value = step.value;
        const isSecret = secrets.includes(value) || /^\$\{?E2E_(?:USERNAME|PASSWORD)\}?$/.test(String(value ?? ''));
        return isSecret ? { ...step, value: '<已提供>' } : step;
      });
    }
  }
  return snapshot;
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
 * @returns {{config: Record<string, any>, warnings: string[], problems: string[], source: string|null, configDir: string}}
 */
export function buildConfig({ flags, env = process.env }) {
  let base = mergeConfig({});
  const warnings = [];
  let source = null;
  let configDir = process.cwd();

  const configFile = typeof flags.config === 'string' ? flags.config : null;
  if (configFile !== null) {
    const loaded = loadConfigFile(configFile, env);
    base = loaded.config;
    warnings.push(...loaded.warnings);
    source = loaded.source;
    // Relative paths inside a config file mean "relative to that file", not to
    // whatever directory the agent happened to invoke the script from.
    configDir = path.dirname(loaded.source);
  }

  if (typeof flags.url === 'string' && flags.url.trim() !== '') base.baseURL = flags.url.trim();
  if (typeof flags['base-url'] === 'string' && flags['base-url'].trim() !== '') {
    base.baseURL = flags['base-url'].trim();
  }
  if (typeof flags.browsers === 'string') {
    base.browsers = flags.browsers.split(/[,，\s]+/).map((b) => b.trim()).filter(Boolean);
  }
  if (flags.headed === true) base.headless = false;
  // `--headless` wins over `--headed` so CI and headless servers can force it no
  // matter what a config file or a stray extra flag says.
  if (flags.headless === true || flags.headless === 'true') base.headless = true;
  if (flags.headless === 'false') base.headless = false;
  if (typeof flags['slow-mo'] === 'string') base.slowMo = Number(flags['slow-mo']);
  if (typeof flags.retries === 'string') base.retries = Number(flags.retries);
  if (typeof flags.workers === 'string') base.workers = Number(flags.workers);
  if (typeof flags.timeout === 'string') base.timeout = Number(flags.timeout);

  const problems = validateConfig(base);
  if (String(base.baseURL ?? '').trim() === '') {
    problems.push('缺少被测网址：请提供 --url，或在配置文件中设置 baseURL。');
  }

  return { config: base, warnings, problems, source, configDir };
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
      headless: false,
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
      // 三种登录方式，按需选一种：
      //   1) 复用已有登录态（最省事）：{"enabled": false, "storageState": "auth/site.json"}
      //   2) 自动登录（单页表单）：enabled=true + username/password
      //   3) 自动登录（多步骤，如 账号 -> Continue -> 密码 -> 登录）：再加 continueSelector
      auth: {
        enabled: false,
        loginUrl: '/login',
        username: '${E2E_USERNAME}',
        password: '${E2E_PASSWORD}',
        usernameSelector: '',
        continueSelector: '',
        passwordSelector: '',
        submitSelector: '',
        successUrl: '',
        successSelector: '',
        storageState: '',
        saveAfterLogin: true,
        forceLogin: false,
        steps: [],
      },
      asyncTasks: {
        submitTimeout: 30000,
        completionTimeout: 180000,
        pollInterval: 2000,
      },
      attempts: {
        keep: 10,
      },
    },
    null,
    2,
  )}\n`;
}
