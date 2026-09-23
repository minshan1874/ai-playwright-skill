/**
 * Tests for the static spec index.
 *
 * This is what makes "this case has no automation" a different statement from
 * "this run did not select this case". It must read specs without executing them
 * and without caring whether they compile.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { collectAutomatedCaseIds, listSpecFiles } from '../skill/scripts/lib/spec-index.mjs';

describe('spec index', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-specs-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds spec and test files, ignoring helpers and fixtures', () => {
    fs.writeFileSync(path.join(dir, 'a.spec.ts'), '');
    fs.writeFileSync(path.join(dir, 'b.test.js'), '');
    fs.writeFileSync(path.join(dir, '_fixtures.ts'), '');
    fs.writeFileSync(path.join(dir, '_auth.setup.ts'), '');
    fs.writeFileSync(path.join(dir, 'notes.md'), '');
    assert.deepEqual(
      listSpecFiles(dir).map((file) => path.basename(file)),
      ['a.spec.ts', 'b.test.js'],
    );
  });

  it('collects case ids from annotations and from title prefixes', () => {
    fs.writeFileSync(
      path.join(dir, 'a.spec.ts'),
      [
        "test('[TC-001] 登录成功', { annotation: [{ type: 'caseId', description: 'TC-001' }] }, async () => {});",
        "test('[TC-002] 密码错误', async () => {});",
        "test('临时验证', { annotation: [{ type: 'caseId', description: 'TC-009' }] }, async () => {});",
        "test.skip('[TC-003] 跳过', async () => {});",
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'b.test.js'), "test('[TC-004] x', async () => {});");

    const ids = collectAutomatedCaseIds(dir);
    assert.deepEqual([...ids].sort(), ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-009']);
  });

  it('does not execute anything or require valid syntax', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-broken-'));
    try {
      fs.writeFileSync(path.join(broken, 'x.spec.ts'), "test('[TC-500] y', { annotation: [{ type: 'caseId', description: 'TC-500' }] }, async () => { this is not code");
      assert.deepEqual([...collectAutomatedCaseIds(broken)], ['TC-500']);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a missing directory', () => {
    assert.equal(collectAutomatedCaseIds(path.join(dir, 'nope')).size, 0);
  });
});
