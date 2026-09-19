import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildConfig,
  effectiveBaseURL,
  exampleConfigText,
  interpolate,
  loadConfigFile,
  mergeConfig,
  validateConfig,
} from '../skill/scripts/lib/config.mjs';

describe('environment interpolation', () => {
  it('replaces braced and bare references', () => {
    const missing = [];
    const result = interpolate({ a: '${FOO}', b: '$BAR' }, { FOO: '1', BAR: '2' }, missing);
    assert.deepEqual(result, { a: '1', b: '2' });
    assert.deepEqual(missing, []);
  });

  it('records unset variables and leaves the placeholder intact', () => {
    const missing = [];
    const result = interpolate({ a: '${NOPE}' }, {}, missing);
    assert.deepEqual(result, { a: '${NOPE}' });
    assert.deepEqual(missing, ['NOPE']);
  });

  it('walks nested objects and arrays', () => {
    const missing = [];
    const result = interpolate({ list: ['${X}'], inner: { y: '${X}' } }, { X: 'v' }, missing);
    assert.deepEqual(result, { list: ['v'], inner: { y: 'v' } });
  });

  it('leaves non-strings untouched', () => {
    const missing = [];
    assert.equal(interpolate(5, {}, missing), 5);
    assert.equal(interpolate(null, {}, missing), null);
  });
});

describe('config merging', () => {
  it('deep-merges nested objects over the defaults', () => {
    const merged = mergeConfig({ viewport: { width: 800 }, auth: { enabled: true } });
    assert.equal(merged.viewport.width, 800);
    assert.equal(merged.viewport.height, 900);
    assert.equal(merged.auth.enabled, true);
    assert.equal(merged.auth.saveAfterLogin, true);
  });

  it('keeps the default browsers when none are given', () => {
    assert.deepEqual(mergeConfig({}).browsers, ['chromium']);
  });
});

describe('config validation', () => {
  it('accepts the defaults', () => {
    assert.deepEqual(validateConfig(mergeConfig({})), []);
  });

  it('rejects an unsupported browser', () => {
    const problems = validateConfig(mergeConfig({ browsers: ['safari'] }));
    assert.ok(problems.some((p) => p.includes('不支持的浏览器')));
  });

  it('rejects an empty browser list', () => {
    const problems = validateConfig(mergeConfig({ browsers: [] }));
    assert.ok(problems.some((p) => p.includes('非空数组')));
  });

  it('rejects invalid trace, screenshot and video modes', () => {
    const problems = validateConfig(mergeConfig({ trace: 'always', screenshot: 'sometimes', video: 'maybe' }));
    assert.equal(problems.filter((p) => p.includes('取值非法')).length, 3);
  });

  it('rejects non-numeric timeouts and zero workers', () => {
    const problems = validateConfig(mergeConfig({ timeout: 'soon', workers: 0 }));
    assert.ok(problems.some((p) => p.includes('timeout')));
    assert.ok(problems.some((p) => p.includes('workers')));
  });

  it('requires loginUrl and credentials when auth is enabled', () => {
    const problems = validateConfig(mergeConfig({ auth: { enabled: true } }));
    assert.ok(problems.some((p) => p.includes('loginUrl')));
    assert.ok(problems.some((p) => p.includes('username')));
  });

  it('accepts a complete auth block', () => {
    const problems = validateConfig(
      mergeConfig({ auth: { enabled: true, loginUrl: '/login', username: 'u', password: 'p' } }),
    );
    assert.deepEqual(problems, []);
  });
});

describe('config files', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-config-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a file and interpolates credentials from the environment', () => {
    const file = path.join(dir, 'e2e.config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ baseURL: 'https://x.test', auth: { enabled: true, loginUrl: '/login', username: '${U}', password: '${P}' } }),
    );
    const { config, missingEnv } = loadConfigFile(file, { U: 'admin', P: 'secret' });
    assert.equal(config.auth.username, 'admin');
    assert.equal(config.auth.password, 'secret');
    assert.deepEqual(missingEnv, []);
  });

  it('warns about unset placeholders', () => {
    const file = path.join(dir, 'missing.json');
    fs.writeFileSync(file, JSON.stringify({ baseURL: 'https://x.test', auth: { username: '${UNSET_VAR}' } }));
    const { warnings, missingEnv } = loadConfigFile(file, {});
    assert.deepEqual(missingEnv, ['UNSET_VAR']);
    assert.ok(warnings.some((w) => w.includes('UNSET_VAR')));
  });

  it('rejects malformed JSON with the file name', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => loadConfigFile(file, {}), /不是合法 JSON/);
  });

  it('rejects a non-object top level', () => {
    const file = path.join(dir, 'array.json');
    fs.writeFileSync(file, '[1,2]');
    assert.throws(() => loadConfigFile(file, {}), /顶层必须是 JSON 对象/);
  });
});

describe('config building', () => {
  it('lets CLI flags win over the config file', () => {
    const { config } = buildConfig({
      flags: { url: 'https://cli.test', browsers: 'chromium,firefox', retries: '3' },
      env: {},
    });
    assert.equal(config.baseURL, 'https://cli.test');
    assert.deepEqual(config.browsers, ['chromium', 'firefox']);
    assert.equal(config.retries, 3);
  });

  it('reports a missing base URL', () => {
    const { problems } = buildConfig({ flags: {}, env: {} });
    assert.ok(problems.some((p) => p.includes('缺少被测网址')));
  });

  it('is headed by default, so a user can watch the run', () => {
    const { config } = buildConfig({ flags: { url: 'https://x.test' }, env: {} });
    assert.equal(config.headless, false);
  });

  it('maps --headed onto headless=false', () => {
    const { config } = buildConfig({ flags: { url: 'https://x.test', headed: true }, env: {} });
    assert.equal(config.headless, false);
  });

  it('lets --headless override both the default and --headed', () => {
    // CI runners and headless servers have no display; this must always win.
    for (const flags of [
      { url: 'https://x.test', headless: true },
      { url: 'https://x.test', headless: 'true' },
      { url: 'https://x.test', headed: true, headless: true },
    ]) {
      assert.equal(buildConfig({ flags, env: {} }).config.headless, true, JSON.stringify(flags));
    }
  });

  it('lets --headless=false opt back into a window', () => {
    const { config } = buildConfig({ flags: { url: 'https://x.test', headless: 'false' }, env: {} });
    assert.equal(config.headless, false);
  });

  it('parses --slow-mo into a number', () => {
    assert.equal(buildConfig({ flags: { url: 'https://x.test', 'slow-mo': '500' }, env: {} }).config.slowMo, 500);
  });

  it('rejects a negative or non-numeric slowMo', () => {
    for (const slowMo of [-1, 'fast']) {
      const problems = validateConfig(mergeConfig({ slowMo }));
      assert.ok(problems.some((p) => p.includes('slowMo')), `slowMo=${slowMo} 应被拒绝`);
    }
  });

  it('defaults slowMo to 0 so runs are not needlessly slow', () => {
    assert.equal(mergeConfig({}).slowMo, 0);
  });

  it('strips trailing slashes from the effective base URL', () => {
    assert.equal(effectiveBaseURL({ baseURL: 'https://x.test///' }), 'https://x.test');
  });

  it('ships a parseable example config', () => {
    const parsed = JSON.parse(exampleConfigText());
    assert.equal(parsed.baseURL, 'https://your-app.example.com');
    assert.deepEqual(parsed.browsers, ['chromium']);
    assert.deepEqual(validateConfig(mergeConfig(parsed)), []);
  });

  it('keeps the shipped example config in sync with exampleConfigText()', () => {
    // The asset is generated from this function; if they drift, users copy a
    // config that no longer matches the documented defaults.
    const asset = fs.readFileSync(
      path.join(process.cwd(), 'skill', 'assets', 'e2e.config.example.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(asset), JSON.parse(exampleConfigText()));
  });
});
