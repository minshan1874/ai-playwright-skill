import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_PLAYWRIGHT_VERSION,
  TOOLCHAIN_MANIFEST_NAME,
  assertSafeToolchainDir,
  describeDownloadSize,
  findBrowsersJson,
  installedRevisions,
  installedVersion,
  probeBrowsers,
  requiredRevisions,
  resolvePlaywrightCli,
  writeToolchainManifest,
} from '../skill/scripts/lib/toolchain.mjs';

/** Create `<dir>/node_modules/<name>/package.json`. */
function fakePackage(dir, name, version) {
  const target = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version }));
}

describe('installed versions', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-tc-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the package is absent', () => {
    assert.equal(installedVersion(dir, '@playwright/test'), null);
  });

  it('reads a scoped package version', () => {
    fakePackage(dir, '@playwright/test', '1.63.0');
    assert.equal(installedVersion(dir, '@playwright/test'), '1.63.0');
  });

  it('reads an unscoped package version', () => {
    fakePackage(dir, 'exceljs', '4.4.0');
    assert.equal(installedVersion(dir, 'exceljs'), '4.4.0');
  });

  it('returns null for a corrupt manifest instead of throwing', () => {
    const target = path.join(dir, 'node_modules', 'broken');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{ nope');
    assert.equal(installedVersion(dir, 'broken'), null);
  });
});

describe('toolchain directory ownership', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-own-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a directory with no manifest', () => {
    assert.deepEqual(assertSafeToolchainDir(dir), { safe: true });
  });

  it('accepts its own manifest', () => {
    writeToolchainManifest(dir);
    assert.deepEqual(assertSafeToolchainDir(dir), { safe: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, TOOLCHAIN_MANIFEST_NAME);
  });

  it('refuses to take over a real project manifest', () => {
    const project = path.join(dir, 'a-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'my-app', version: '1.0.0' }));

    const result = assertSafeToolchainDir(project);
    assert.equal(result.safe, false);
    assert.equal(result.existingName, 'my-app');
    assert.match(result.reason, /my-app/);
  });

  it('refuses an unparseable manifest rather than overwriting it', () => {
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), '{ not json');

    const result = assertSafeToolchainDir(broken);
    assert.equal(result.safe, false);
    assert.equal(result.existingName, null);
  });

  it('refuses a manifest with no name', () => {
    const unnamed = path.join(dir, 'unnamed');
    fs.mkdirSync(unnamed, { recursive: true });
    fs.writeFileSync(path.join(unnamed, 'package.json'), JSON.stringify({ private: true }));
    assert.equal(assertSafeToolchainDir(unnamed).safe, false);
  });
});

describe('toolchain manifest', () => {
  it('pins the Playwright version and the exceljs range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-manifest-'));
    try {
      const manifest = writeToolchainManifest(dir, { playwrightVersion: '1.63.0' });
      assert.equal(manifest.dependencies['@playwright/test'], '1.63.0');
      assert.ok(manifest.dependencies.exceljs.startsWith('^4'));
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.deepEqual(onDisk.dependencies, manifest.dependencies);
      assert.equal(onDisk.private, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to the pinned Playwright version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-manifest2-'));
    try {
      assert.equal(
        writeToolchainManifest(dir).dependencies['@playwright/test'],
        DEFAULT_PLAYWRIGHT_VERSION,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('browser revision probing', () => {
  /** @type {string} */
  let toolchain;
  /** @type {string} */
  let cache;

  before(() => {
    toolchain = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-browsers-'));
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cache-'));

    // A minimal playwright-core install declaring required revisions.
    const core = path.join(toolchain, 'node_modules', 'playwright-core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(
      path.join(core, 'browsers.json'),
      JSON.stringify({
        browsers: [
          { name: 'chromium', revision: '1243' },
          { name: 'chromium-headless-shell', revision: '1243' },
          { name: 'firefox', revision: '1543' },
          { name: 'webkit', revision: '2359' },
          { name: 'ffmpeg', revision: '1011' },
        ],
      }),
    );

    // Only chromium and ffmpeg are cached.
    for (const name of ['chromium-1243', 'chromium_headless_shell-1243', 'ffmpeg-1011']) {
      fs.mkdirSync(path.join(cache, name), { recursive: true });
    }
  });

  after(() => {
    fs.rmSync(toolchain, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('locates browsers.json', () => {
    assert.ok(findBrowsersJson(toolchain).endsWith(path.join('playwright-core', 'browsers.json')));
    assert.equal(findBrowsersJson(cache), null);
  });

  it('reads the required revisions', () => {
    const required = requiredRevisions(toolchain);
    assert.equal(required.chromium, '1243');
    assert.equal(required.firefox, '1543');
  });

  it('returns an empty map when browsers.json is missing', () => {
    assert.deepEqual(requiredRevisions(cache), {});
  });

  it('lists installed revisions from directory names', () => {
    const installed = installedRevisions(cache);
    assert.deepEqual(installed.chromium, ['1243']);
    assert.deepEqual(installed.firefox, undefined);
  });

  it('returns an empty map for a missing cache directory', () => {
    assert.deepEqual(installedRevisions(path.join(cache, 'does-not-exist')), {});
  });

  it('classifies a cached browser as available', () => {
    const probe = probeBrowsers({ dir: toolchain, browsers: ['chromium'], cacheDir: cache });
    assert.deepEqual(probe.available, ['chromium']);
    assert.deepEqual(probe.missing, []);
    assert.equal(probe.details[0].status, 'ready');
  });

  it('classifies an uncached browser as missing', () => {
    const probe = probeBrowsers({ dir: toolchain, browsers: ['firefox'], cacheDir: cache });
    assert.deepEqual(probe.missing, ['firefox']);
    assert.equal(probe.details[0].status, 'absent');
    assert.equal(probe.details[0].requiredRevision, '1543');
  });

  it('flags a revision mismatch as stale, not missing', () => {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-stale-'));
    try {
      fs.mkdirSync(path.join(stale, 'chromium-9999'), { recursive: true });
      const probe = probeBrowsers({ dir: toolchain, browsers: ['chromium'], cacheDir: stale });
      assert.deepEqual(probe.stale, ['chromium']);
      assert.deepEqual(probe.missing, []);
      assert.deepEqual(probe.available, []);
      assert.equal(probe.details[0].status, 'revision-mismatch');
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it('handles a mixed request', () => {
    const probe = probeBrowsers({ dir: toolchain, browsers: ['chromium', 'firefox', 'webkit'], cacheDir: cache });
    assert.deepEqual(probe.available, ['chromium']);
    assert.deepEqual(probe.missing, ['firefox', 'webkit']);
  });

  it('reports unknown rather than stale when the expected revision is unknowable', () => {
    // Before the toolchain is installed there is no browsers.json to compare against.
    const probe = probeBrowsers({ dir: cache, browsers: ['chromium', 'firefox'], cacheDir: cache });
    assert.deepEqual(probe.unknown, ['chromium']);
    assert.deepEqual(probe.stale, []);
    assert.deepEqual(probe.missing, ['firefox']);
    assert.equal(probe.details[0].status, 'unknown');
  });

  it('estimates download sizes for missing browsers', () => {
    const text = describeDownloadSize(['firefox', 'webkit']);
    assert.ok(text.includes('firefox'));
    assert.ok(text.includes('MB'));
  });
});

describe('playwright cli resolution', () => {
  it('returns null when nothing is installed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cli-'));
    try {
      assert.equal(resolvePlaywrightCli(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the playwright package cli', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cli2-'));
    try {
      const target = path.join(dir, 'node_modules', 'playwright');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'cli.js'), '// cli');
      assert.equal(resolvePlaywrightCli(dir), path.join(target, 'cli.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the @playwright/test cli', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cli3-'));
    try {
      const target = path.join(dir, 'node_modules', '@playwright', 'test');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'cli.js'), '// cli');
      assert.equal(resolvePlaywrightCli(dir), path.join(target, 'cli.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
