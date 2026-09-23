/**
 * Authentication tests.
 *
 * Three shapes must all work, because real login flows come in all three:
 *   1. reuse an existing storageState — no login, and therefore no credentials
 *   2. single-page login       — account and password on one form
 *   3. multi-step login        — account -> Continue -> password -> submit
 *
 * The generated setup file is asserted on directly: it is the artifact that
 * actually logs in, and it must never contain a credential.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildConfig, mergeConfig, redactConfig, resolveAuth, validateConfig } from '../skill/scripts/lib/config.mjs';
import { buildLoginSteps, renderAuthSetup } from '../skill/scripts/lib/login-script.mjs';
import { STEP_ACTIONS, locatorToCode, resolveLocator, validateStep } from '../skill/scripts/lib/steps.mjs';

/** A config with credentials, as a user would write it. */
const CREDENTIAL_CONFIG = {
  baseURL: 'https://x.test',
  auth: {
    enabled: true,
    loginUrl: '/login',
    username: '${E2E_USERNAME}',
    password: '${E2E_PASSWORD}',
  },
};

describe('auth validation', () => {
  it('accepts a storageState-only config with no credentials at all', () => {
    // The whole point: "reuse the session I already have" must not require a
    // loginUrl, a username, or a password placeholder.
    const config = mergeConfig({ auth: { enabled: false, storageState: 'auth/site.json' } });
    assert.deepEqual(validateConfig(config), []);
  });

  it('accepts an enabled config that only reuses a storageState', () => {
    const config = mergeConfig({ auth: { enabled: true, storageState: 'auth/site.json' } });
    assert.deepEqual(validateConfig(config), []);
  });

  it('still requires a loginUrl and credentials when it must actually log in', () => {
    const problems = validateConfig(mergeConfig({ auth: { enabled: true } }));
    assert.equal(problems.length, 2);
    assert.ok(problems.some((problem) => problem.includes('auth.loginUrl')));
    assert.ok(problems.some((problem) => problem.includes('auth.username')));
    assert.ok(problems.some((problem) => problem.includes('storageState')));
  });

  it('accepts auth.steps in place of credentials', () => {
    const config = mergeConfig({
      auth: { enabled: true, loginUrl: '/login', steps: [{ action: 'fill', locator: { by: 'css', value: '#u' }, value: 'x' }] },
    });
    assert.deepEqual(validateConfig(config), []);
  });

  it('rejects a malformed login step with the supported action list', () => {
    const config = mergeConfig({ auth: { enabled: true, loginUrl: '/login', steps: [{ action: 'teleport' }] } });
    const problems = validateConfig(config);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('teleport'));
    assert.ok(problems[0].includes('goto'));
  });
});

describe('auth resolution', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-auth-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runDir = () => path.join(dir, 'site-20250101-000000');
  const home = () => path.join(dir, 'home');

  it('reuses an existing storageState and never logs in', () => {
    const state = path.join(dir, 'auth', 'site.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    const auth = resolveAuth(mergeConfig({ auth: { enabled: false, storageState: 'auth/site.json' } }), {
      runDir: runDir(),
      home: home(),
      configDir: dir,
    });
    assert.equal(auth.mode, 'storage-state');
    assert.equal(auth.storageStatePath, state);
    assert.equal(auth.needsLoginSetup, false);
    assert.deepEqual(auth.problems, []);
  });

  it('resolves a relative storageState against the config file, not the cwd', () => {
    const state = path.join(dir, 'run', 'auth', 'other.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    const auth = resolveAuth(mergeConfig({ auth: { storageState: 'auth/other.json' } }), {
      runDir: runDir(),
      home: home(),
      configDir: path.join(dir, 'run'),
    });
    assert.equal(auth.mode, 'storage-state');
    assert.equal(auth.storageStatePath, state);
  });

  it('explains how to fix a storageState that does not exist', () => {
    const auth = resolveAuth(mergeConfig({ auth: { enabled: false, storageState: 'auth/missing.json' } }), {
      runDir: runDir(),
      home: home(),
      configDir: dir,
    });
    assert.equal(auth.mode, 'none');
    assert.equal(auth.problems.length, 1);
    assert.ok(auth.problems[0].includes('不存在'));
    assert.ok(auth.problems[0].includes('codegen'));
  });

  it('falls back to logging in when the configured storageState is missing', () => {
    const auth = resolveAuth(mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, storageState: 'auth/missing.json' } }), {
      runDir: runDir(),
      home: home(),
      configDir: dir,
    });
    assert.equal(auth.mode, 'login');
    assert.equal(auth.needsLoginSetup, true);
    assert.deepEqual(auth.problems, []);
    assert.ok(auth.notes.some((note) => note.includes('将重新登录')));
  });

  it('logs in when nothing is configured yet', () => {
    const auth = resolveAuth(mergeConfig(CREDENTIAL_CONFIG), { runDir: runDir(), home: home(), configDir: dir });
    assert.equal(auth.mode, 'login');
    assert.equal(auth.needsLoginSetup, true);
    assert.ok(auth.storageStatePath.endsWith(path.join('auth', 'site.json')));
  });

  it('reuses the default state file once one has been saved', () => {
    const homeDir = home();
    const state = path.join(homeDir, 'auth', 'site.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    const auth = resolveAuth(mergeConfig(CREDENTIAL_CONFIG), { runDir: runDir(), home: homeDir, configDir: dir });
    assert.equal(auth.mode, 'storage-state');
    assert.equal(auth.storageStatePath, state);
    assert.equal(auth.needsLoginSetup, false);
  });

  it('honours auth.forceLogin over an existing state file', () => {
    const homeDir = home();
    const auth = resolveAuth(mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, forceLogin: true } }), {
      runDir: runDir(),
      home: homeDir,
      configDir: dir,
    });
    assert.equal(auth.mode, 'login');
    assert.equal(auth.needsLoginSetup, true);
  });

  it('does not save the state when saveAfterLogin is false', () => {
    const auth = resolveAuth(mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, saveAfterLogin: false } }), {
      runDir: runDir(),
      home: path.join(dir, 'empty-home'),
      configDir: dir,
    });
    assert.equal(auth.mode, 'login');
    assert.equal(auth.needsLoginSetup, false);
  });
});

describe('login steps', () => {
  it('derives a single-page flow with no continue step', () => {
    const steps = buildLoginSteps(mergeConfig(CREDENTIAL_CONFIG));
    assert.deepEqual(
      steps.map((step) => step.action),
      ['goto', 'waitFor', 'fill', 'waitFor', 'fill', 'click'],
    );
    assert.ok(!steps.some((step) => step.name === '点击继续'));
  });

  it('inserts the continue click for a multi-step flow', () => {
    const steps = buildLoginSteps(
      mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, continueSelector: '#continue' } }),
    );
    const actions = steps.map((step) => step.action);
    assert.deepEqual(actions, ['goto', 'waitFor', 'fill', 'click', 'waitFor', 'fill', 'click']);
    const continueStep = steps[3];
    assert.equal(continueStep.name, '点击继续');
    assert.deepEqual(continueStep.locator, { by: 'css', value: '#continue' });
    // Password is filled only after the continue click advances the form; with no
    // explicit selector it falls back to the generic password-field locator.
    assert.match(String(steps[4].locator), /input\[type="password"\]/);
  });

  it('hints at continueSelector when a password box never appears', () => {
    const steps = buildLoginSteps(mergeConfig(CREDENTIAL_CONFIG));
    const passwordWait = steps.find((step) => step.name === '等待密码输入框');
    assert.ok(passwordWait.hint.includes('continueSelector'));
  });

  it('uses explicit selectors when given', () => {
    const steps = buildLoginSteps(
      mergeConfig({
        ...CREDENTIAL_CONFIG,
        auth: { ...CREDENTIAL_CONFIG.auth, usernameSelector: '#account', passwordSelector: '#pw', submitSelector: '.go' },
      }),
    );
    assert.deepEqual(steps[1].locator, { by: 'css', value: '#account' });
    assert.deepEqual(steps[3].locator, { by: 'css', value: '#pw' });
    assert.deepEqual(steps[5].locator, { by: 'css', value: '.go' });
  });

  it('lets an explicit step list override the shorthand entirely', () => {
    const custom = [
      { action: 'goto', url: '/sso' },
      { action: 'click', locator: { by: 'text', value: '使用 Google 登录' } },
      { action: 'fill', locator: { by: 'css', value: '#pw' }, value: '${E2E_PASSWORD}' },
    ];
    const steps = buildLoginSteps(mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, steps: custom } }));
    assert.deepEqual(steps.map((step) => step.action), ['goto', 'click', 'fill']);
    assert.equal(steps[0].name, '打开页面 1');
    assert.equal(steps[1].name, '点击 2');
  });
});

describe('generated auth setup', () => {
  const render = (configOverrides = {}) => {
    const config = mergeConfig({ ...CREDENTIAL_CONFIG, ...configOverrides });
    return renderAuthSetup({
      config,
      steps: buildLoginSteps(config),
      storageStatePath: '/home/auth/site.json',
    });
  };

  it('writes the storageState path and reads credentials from the environment', () => {
    const source = render();
    assert.ok(source.includes('const STORAGE_STATE = "/home/auth/site.json";'));
    assert.ok(source.includes("const USERNAME = process.env.E2E_USERNAME ?? '';"));
    assert.ok(source.includes('await page.context().storageState({ path: STORAGE_STATE });'));
  });

  it('never emits a credential, even when the config holds the resolved secret', () => {
    const source = render({ auth: { ...CREDENTIAL_CONFIG.auth, username: 'real@user.test', password: 'sup3r-s3cret' } });
    assert.ok(!source.includes('sup3r-s3cret'));
    assert.ok(!source.includes('real@user.test'));
    assert.ok(source.includes('.fill(USERNAME, { timeout: SUBMIT_TIMEOUT })'));
    assert.ok(source.includes('.fill(PASSWORD, { timeout: SUBMIT_TIMEOUT })'));
  });

  it('renders the multi-step flow with a continue click', () => {
    const source = render({ auth: { ...CREDENTIAL_CONFIG.auth, continueSelector: '#continue' } });
    assert.ok(source.includes('await page.locator("#continue").click({ timeout: SUBMIT_TIMEOUT });'));
    assert.ok(source.includes('1/7 打开登录页'));
    assert.ok(source.includes('4/7 点击继续'));
    // Every step is visible in the HTML report instead of one opaque "login" line.
    assert.equal((source.match(/await setup\.step\(/g) ?? []).length, 7);
  });

  it('uses a stable element as the success signal when configured', () => {
    const source = render({ auth: { ...CREDENTIAL_CONFIG.auth, successSelector: '[data-testid="account-menu"]' } });
    assert.ok(source.includes('toBeVisible({ timeout: SUCCESS_TIMEOUT })'));
    assert.ok(source.includes('auth.successSelector=[data-testid="account-menu"]'));
  });

  it('extends its own timeout to cover every step', () => {
    const source = render({ asyncTasks: { submitTimeout: 45000 } });
    assert.ok(source.includes('const SUBMIT_TIMEOUT = 45000;'));
    assert.ok(source.includes('setup.setTimeout('));
  });

  it('produces balanced braces and a TypeScript-shaped file', () => {
    const source = render({ auth: { ...CREDENTIAL_CONFIG.auth, continueSelector: '#go', successUrl: '/app' } });
    assert.equal((source.match(/\{/g) ?? []).length, (source.match(/\}/g) ?? []).length);
    assert.ok(source.includes("import { test as setup, expect } from '@playwright/test';"));
  });

  it('rejects an unusable step list instead of writing broken code', () => {
    const config = mergeConfig({ ...CREDENTIAL_CONFIG, auth: { ...CREDENTIAL_CONFIG.auth, steps: [{ action: 'fill' }] } });
    assert.throws(
      () => renderAuthSetup({ config, steps: buildLoginSteps(config), storageStatePath: '/x.json' }),
      /缺少 locator/,
    );
  });
});

describe('step vocabulary', () => {
  it('includes the screenshot action the manual documents', () => {
    assert.ok(STEP_ACTIONS.includes('screenshot'));
  });

  it('validates step shape', () => {
    assert.equal(validateStep({ action: 'click', locator: { by: 'text', value: 'x' } }, 0), null);
    assert.match(validateStep({ action: 'click' }, 2), /第 3 个步骤.*缺少 locator/);
    assert.match(validateStep({ locator: {} }, 0), /缺少 action/);
    assert.match(validateStep('nope', 0), /不是对象/);
  });

  it('accepts a locator expression with or without the page prefix', () => {
    assert.equal(locatorToCode("getByRole('button')"), "page.getByRole('button')");
    assert.equal(locatorToCode('page.getByRole("button")'), 'page.getByRole("button")');
    assert.equal(locatorToCode('page\n  .getByText("x")'), 'page\n  .getByText("x")');
  });

  it('builds the same locator for live use and for generated code', () => {
    const page = {
      getByTestId: (value) => `testId:${value}`,
      getByRole: (role, options) => `role:${role}:${options?.name ?? ''}`,
      getByLabel: (value) => `label:${value}`,
      locator: (value) => `css:${value}`,
    };
    assert.equal(resolveLocator(page, { by: 'testId', value: 'x' }), 'testId:x');
    assert.equal(resolveLocator(page, { by: 'role', role: 'button', name: '登录' }), 'role:button:登录');
    assert.equal(resolveLocator(page, { by: 'css', value: '#a' }), 'css:#a');
    assert.equal(resolveLocator(page, { by: 'label', value: '账号' }), 'label:账号');
  });

  it('explains an unknown locator kind', () => {
    assert.throws(() => locatorToCode({ by: 'magic', value: 'x' }), /可用 by/);
  });
});

describe('credential redaction', () => {
  it('masks credentials and step values that carry them', () => {
    const config = mergeConfig({
      auth: {
        ...CREDENTIAL_CONFIG.auth,
        username: 'real@user.test',
        password: 'sup3r-s3cret',
        steps: [
          { action: 'fill', locator: { by: 'css', value: '#u' }, value: 'real@user.test' },
          { action: 'fill', locator: { by: 'css', value: '#p' }, value: 'sup3r-s3cret' },
          { action: 'fill', locator: { by: 'css', value: '#o' }, value: 'public' },
        ],
      },
    });
    const redacted = redactConfig(config);
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes('sup3r-s3cret'));
    assert.ok(!serialized.includes('real@user.test'));
    assert.equal(redacted.auth.steps[2].value, 'public');
    assert.equal(redacted.auth.steps[0].value, '<已提供>');
  });

  it('leaves the original config untouched', () => {
    const config = mergeConfig({ auth: { ...CREDENTIAL_CONFIG.auth, password: 'p' } });
    redactConfig(config);
    assert.equal(config.auth.password, 'p');
  });
});

describe('buildConfig', () => {
  it('reports the config directory so relative paths resolve correctly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cfg-'));
    const file = path.join(dir, 'e2e.config.json');
    fs.writeFileSync(file, JSON.stringify({ baseURL: 'https://x.test', auth: { storageState: 'auth/site.json' } }));
    const { config, configDir, problems } = buildConfig({ flags: { config: file }, env: {} });
    assert.deepEqual(problems, []);
    assert.equal(configDir, dir);
    assert.equal(config.auth.storageState, 'auth/site.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults the async budgets to a submit/completion split', () => {
    const { config } = buildConfig({ flags: { url: 'https://x.test' }, env: {} });
    assert.equal(config.asyncTasks.submitTimeout, 30000);
    assert.equal(config.asyncTasks.completionTimeout, 180000);
    assert.ok(config.asyncTasks.completionTimeout > config.asyncTasks.submitTimeout);
  });
});
