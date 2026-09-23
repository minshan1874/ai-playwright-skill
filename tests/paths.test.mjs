import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  attemptPaths,
  authDir,
  browserCacheDir,
  describeWriteDenial,
  ensureHomeLayout,
  expandTilde,
  listAttempts,
  nextAttemptId,
  npmCacheDir,
  probeWritable,
  pruneAttempts,
  resolveHome,
  runDirPath,
  runPaths,
  runsDir,
  slugify,
  storageStatePath,
  timestamp,
  toolchainDir,
} from '../skill/scripts/lib/paths.mjs';

describe('home resolution', () => {
  it('prefers PLAYWRIGHT_E2E_HOME', () => {
    assert.equal(resolveHome({ PLAYWRIGHT_E2E_HOME: '/tmp/custom', DSH_HOME: '/tmp/dsh', HOME: '/home/u' }), '/tmp/custom');
  });

  it('falls back to DSH_HOME', () => {
    assert.equal(resolveHome({ DSH_HOME: '/tmp/dsh', HOME: '/home/u' }), path.join('/tmp/dsh', 'playwright-e2e'));
  });

  it('falls back to ~/.dsh', () => {
    const resolved = resolveHome({ HOME: '/home/u' });
    assert.equal(resolved, path.join('/home/u', '.dsh', 'playwright-e2e'));
  });

  it('ignores a blank override', () => {
    assert.equal(resolveHome({ PLAYWRIGHT_E2E_HOME: '   ', DSH_HOME: '/tmp/dsh', HOME: '/home/u' }), path.join('/tmp/dsh', 'playwright-e2e'));
  });

  it('expands a leading tilde', () => {
    assert.equal(expandTilde('~/x', { HOME: '/home/u' }), path.join('/home/u', 'x'));
    assert.equal(expandTilde('~', { HOME: '/home/u' }), '/home/u');
    assert.equal(expandTilde('/abs', { HOME: '/home/u' }), '/abs');
  });
});

describe('layout paths', () => {
  const home = '/tmp/pw';

  it('derives every subdirectory from the home', () => {
    assert.equal(toolchainDir(home), home);
    assert.equal(runsDir(home), path.join(home, 'runs'));
    assert.equal(authDir(home), path.join(home, 'auth'));
    assert.equal(npmCacheDir(home), path.join(home, '.npm-cache'));
  });

  it('resolves the browser cache per platform', () => {
    assert.equal(browserCacheDir('darwin', { HOME: '/home/u' }), path.join('/home/u', 'Library', 'Caches', 'ms-playwright'));
    assert.equal(browserCacheDir('linux', { HOME: '/home/u' }), path.join('/home/u', '.cache', 'ms-playwright'));
    assert.equal(
      browserCacheDir('win32', { HOME: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }),
      path.join('C:\\Users\\u\\AppData\\Local', 'ms-playwright'),
    );
  });

  it('honours PLAYWRIGHT_BROWSERS_PATH', () => {
    assert.equal(browserCacheDir('darwin', { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' }), '/tmp/browsers');
  });

  it('builds the run path set', () => {
    const paths = runPaths('/tmp/pw/runs/demo-20250101-120000');
    assert.equal(paths.plan, '/tmp/pw/runs/demo-20250101-120000/plan.md');
    assert.equal(paths.cases, '/tmp/pw/runs/demo-20250101-120000/cases.json');
    assert.equal(paths.jsonResults, '/tmp/pw/runs/demo-20250101-120000/test-results/results.json');
    assert.equal(paths.report, '/tmp/pw/runs/demo-20250101-120000/report.md');
    assert.equal(paths.fixtures, '/tmp/pw/runs/demo-20250101-120000/specs/_fixtures.ts');
  });

  it('builds the storage state path from a slugified project name', () => {
    assert.equal(storageStatePath('/tmp/pw', 'example.com'), '/tmp/pw/auth/example-com.json');
  });
});

describe('slugify', () => {
  it('extracts the hostname from a URL', () => {
    assert.equal(slugify('https://shop.example.com/checkout?x=1'), 'shop-example-com');
    assert.equal(slugify('example.com'), 'example-com');
  });

  it('slugifies a plain name', () => {
    assert.equal(slugify('My Test Project'), 'my-test-project');
  });

  it('keeps CJK characters', () => {
    assert.equal(slugify('订单系统'), '订单系统');
  });

  it('falls back to "project" for empty or symbol-only input', () => {
    assert.equal(slugify(''), 'project');
    assert.equal(slugify('///'), 'project');
    assert.equal(slugify(null), 'project');
  });

  it('collapses separators and trims dashes', () => {
    assert.equal(slugify('--a---b--'), 'a-b');
  });

  it('caps the length', () => {
    assert.ok(slugify('a'.repeat(200)).length <= 60);
  });
});

describe('timestamps and run directories', () => {
  it('formats YYYYMMDD-HHmmss with zero padding', () => {
    assert.equal(timestamp(new Date(2025, 0, 2, 3, 4, 5)), '20250102-030405');
  });

  it('composes a run directory from slug and time', () => {
    const dir = runDirPath('/tmp/pw', 'https://a.test', new Date(2025, 5, 7, 8, 9, 10));
    assert.equal(dir, path.join('/tmp/pw', 'runs', 'a-test-20250607-080910'));
  });
});

describe('writability probing', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-paths-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports ok for a writable directory and leaves no probe file behind', () => {
    const target = path.join(dir, 'nested', 'deeper');
    assert.deepEqual(probeWritable(target), { ok: true });
    assert.deepEqual(fs.readdirSync(target), []);
  });

  it('reports a structured failure instead of throwing', () => {
    // A file where a directory is expected is a portable way to force a failure.
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    const result = probeWritable(path.join(blocked, 'child'));
    assert.equal(result.ok, false);
    assert.ok(typeof result.code === 'string' && result.code.length > 0);
    assert.ok(result.message.length > 0);
  });

  it('explains a denial with two concrete remedies', () => {
    const text = describeWriteDenial('/tmp/x', { code: 'EACCES', message: 'denied' });
    assert.ok(text.includes('EACCES'));
    assert.ok(text.includes('PLAYWRIGHT_E2E_HOME'));
    assert.ok(text.includes('提权'));
  });
});

describe('ensureHomeLayout', () => {
  it('creates every directory once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-home-'));
    try {
      const layout = ensureHomeLayout(home);
      for (const value of Object.values(layout)) assert.ok(fs.statSync(value).isDirectory());
      // Idempotent on a second call.
      assert.doesNotThrow(() => ensureHomeLayout(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('execution attempts', () => {
  /** @type {string} */
  let runDir;
  before(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-attempt-'));
  });
  after(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('gives every attempt its own artifact directories', () => {
    const attempt = attemptPaths(runDir, 'attempt-20250101-120000');
    assert.equal(attempt.dir, path.join(runDir, 'attempts', 'attempt-20250101-120000'));
    assert.equal(attempt.testResults, path.join(attempt.dir, 'test-results'));
    assert.equal(attempt.jsonResults, path.join(attempt.dir, 'test-results', 'results.json'));
    assert.equal(attempt.htmlReport, path.join(attempt.dir, 'playwright-report'));
    assert.equal(attempt.meta, path.join(attempt.dir, 'attempt.json'));
    // Artifacts must not be shared with the run root or with another attempt.
    assert.ok(!attempt.testResults.startsWith(path.join(runDir, 'test-results')));
    assert.notEqual(attempt.testResults, attemptPaths(runDir, 'attempt-20250101-120001').testResults);
  });

  it('never hands out the same id twice', () => {
    const date = new Date(2025, 0, 1, 12, 0, 0);
    const first = nextAttemptId(runDir, date);
    fs.mkdirSync(path.join(runDir, 'attempts', first), { recursive: true });
    const second = nextAttemptId(runDir, date);
    assert.notEqual(first, second);
    assert.ok(second.startsWith(first));
  });

  it('lists attempts oldest first and prunes the oldest beyond the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-prune-'));
    try {
      for (const id of ['attempt-20250101-000001', 'attempt-20250101-000002', 'attempt-20250101-000003']) {
        fs.mkdirSync(path.join(dir, 'attempts', id), { recursive: true });
        fs.writeFileSync(path.join(dir, 'attempts', id, 'marker.txt'), id);
      }
      assert.deepEqual(listAttempts(dir), [
        'attempt-20250101-000001',
        'attempt-20250101-000002',
        'attempt-20250101-000003',
      ]);

      const removed = pruneAttempts(dir, 2);
      assert.deepEqual(removed, ['attempt-20250101-000001']);
      assert.deepEqual(listAttempts(dir), ['attempt-20250101-000002', 'attempt-20250101-000003']);
      // Pruning nothing is a no-op, not an error.
      assert.deepEqual(pruneAttempts(dir, 5), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the attempts directory from runPaths', () => {
    assert.equal(runPaths('/run/x').attempts, path.join('/run/x', 'attempts'));
  });
});
