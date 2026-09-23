import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PLAN_STATUS, readPlanStatus, setPlanStatus } from '../skill/scripts/lib/plan.mjs';
import { renderPlanSkeleton, renderReport } from '../skill/scripts/lib/report.mjs';
import {
  annotationValue,
  caseIdFromTitle,
  flattenSuites,
  normalizeResults,
  stripAnsi,
  verdictFor,
} from '../skill/scripts/lib/results.mjs';

/** Build a Playwright-shaped JSON report. */
function makeReport(tests) {
  return {
    config: {},
    suites: [
      {
        title: 'demo.spec.ts',
        file: 'demo.spec.ts',
        specs: tests.map((test) => ({
          title: test.title,
          file: 'demo.spec.ts',
          line: test.line ?? 1,
          ok: test.status === 'expected',
          tests: [
            {
              timeout: 30000,
              annotations: test.annotations ?? [],
              tags: test.tags ?? [],
              projectName: test.project ?? 'chromium',
              status: test.status,
              results: [
                {
                  duration: test.duration ?? 100,
                  status: test.status,
                  ...(test.error ? { error: { message: test.error } } : {}),
                  attachments: test.attachments ?? [],
                },
              ],
            },
          ],
        })),
      },
    ],
    errors: [],
    stats: { startTime: '2025-01-01T00:00:00.000Z', duration: 1234, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
  };
}

const CASE_LIST = [
  { id: 'TC-001', title: '登录成功', module: '登录', priority: 'P0', rowRef: 2 },
  { id: 'TC-002', title: '密码错误', module: '登录', priority: 'P1', rowRef: 3 },
  { id: 'TC-003', title: '短信登录', module: '登录', priority: 'P1', rowRef: 4 },
];

describe('plan status gate', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-plan-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing plan', () => {
    assert.deepEqual(readPlanStatus(path.join(dir, 'nope.md')), { exists: false, status: null, raw: '' });
  });

  it('reads 待确认 from a freshly generated plan', () => {
    const file = path.join(dir, 'pending.md');
    fs.writeFileSync(file, '# 计划\n\n状态: 待确认\n');
    assert.equal(readPlanStatus(file).status, PLAN_STATUS.pending);
  });

  it('flips to 已确认 and records the timestamp', () => {
    const file = path.join(dir, 'confirm.md');
    fs.writeFileSync(file, '# 计划\n\n状态: 待确认\n');
    setPlanStatus(file, PLAN_STATUS.confirmed, { confirmedBy: '用户' });
    const after = readPlanStatus(file);
    assert.equal(after.status, PLAN_STATUS.confirmed);
    assert.ok(after.raw.includes('确认时间'));
    assert.ok(after.raw.includes('用户'));
    // Exactly one status line survives.
    assert.equal(after.raw.match(/^状态:/gm).length, 1);
  });

  it('accepts the English "status:" spelling and full-width colon', () => {
    const file = path.join(dir, 'english.md');
    fs.writeFileSync(file, 'status: 已确认\n');
    assert.equal(readPlanStatus(file).status, PLAN_STATUS.confirmed);

    const wide = path.join(dir, 'wide.md');
    fs.writeFileSync(wide, '状态：待确认\n');
    assert.equal(readPlanStatus(wide).status, PLAN_STATUS.pending);
  });

  it('treats an unmarked plan as not confirmed', () => {
    const file = path.join(dir, 'bare.md');
    fs.writeFileSync(file, '# 计划\n没有任何状态行\n');
    assert.equal(readPlanStatus(file).status, null);
  });

  it('uses the last status line when a plan was updated', () => {
    const file = path.join(dir, 'twice.md');
    fs.writeFileSync(file, '状态: 待确认\n改了一版\n状态: 已确认\n');
    assert.equal(readPlanStatus(file).status, PLAN_STATUS.confirmed);
  });

  it('renders a skeleton that is parseable and pending', () => {
    const markdown = renderPlanSkeleton({
      baseURL: 'https://x.test',
      cases: CASE_LIST,
      config: { browsers: ['chromium'] },
      runDir: '/tmp/run',
    });
    const file = path.join(dir, 'skeleton.md');
    fs.writeFileSync(file, markdown);
    assert.equal(readPlanStatus(file).status, PLAN_STATUS.pending);
    assert.ok(markdown.includes('https://x.test'));
    assert.ok(markdown.includes('TC-001'));
    assert.ok(markdown.includes('### 登录（3 条）'));
  });
});

describe('title and annotation parsing', () => {
  it('extracts a case id from a bracketed title', () => {
    assert.equal(caseIdFromTitle('[TC-001] 登录成功'), 'TC-001');
    assert.equal(caseIdFromTitle('TC-001 登录成功'), null);
    assert.equal(caseIdFromTitle('[ABC-12] x'), 'ABC-12');
    assert.equal(caseIdFromTitle(''), null);
  });

  it('reads an annotation by type', () => {
    assert.equal(annotationValue([{ type: 'caseId', description: 'TC-9' }], 'caseId'), 'TC-9');
    assert.equal(annotationValue([], 'caseId'), null);
    assert.equal(annotationValue(undefined, 'caseId'), null);
  });
});

describe('suite flattening', () => {
  it('walks nested suites and skips the file-name root', () => {
    const report = {
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [{ title: 'top', tests: [{ status: 'expected' }] }],
          suites: [{ title: '分组', specs: [{ title: 'nested', tests: [{ status: 'expected' }] }] }],
        },
      ],
    };
    const flat = flattenSuites(report.suites);
    assert.equal(flat.length, 2);
    assert.deepEqual(flat[0].suite, []);
    assert.deepEqual(flat[1].suite, ['分组']);
  });
});

describe('ansi stripping', () => {
  it('removes Playwright colour codes from error text', () => {
    const colored = '\u001B[2mexpect(\u001B[22m\u001B[31mlocator\u001B[39m)\u001B[2m.\u001B[22mtoHaveText';
    assert.equal(stripAnsi(colored), 'expect(locator).toHaveText');
  });

  it('leaves plain text untouched and tolerates null', () => {
    assert.equal(stripAnsi('普通错误信息'), '普通错误信息');
    assert.equal(stripAnsi(null), '');
  });

  it('keeps ANSI out of the normalized error field', () => {
    const report = makeReport([
      { title: '[TC-001] x', status: 'unexpected', error: '\u001B[31mboom\u001B[39m' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.tests[0].error, 'boom');
  });

  it('keeps ANSI out of infrastructure errors', () => {
    const report = makeReport([]);
    report.errors = [{ message: '\u001B[2mbad\u001B[22m' }];
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.infrastructureErrors[0].message, 'bad');
  });
});

describe('results normalization', () => {
  it('maps statuses and joins to cases', () => {
    const report = makeReport([
      { title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] },
      { title: '[TC-002] 密码错误', status: 'unexpected', error: '期望 X 实际 Y' },
      { title: '[TC-003] 短信登录', status: 'skipped' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });

    assert.deepEqual(summary.counts, { total: 3, passed: 1, failed: 1, flaky: 0, skipped: 1, unknown: 0 });
    assert.equal(summary.tests[1].error, '期望 X 实际 Y');
    assert.equal(summary.tests[1].caseId, 'TC-002');
    assert.equal(summary.tests[1].module, '登录');
    assert.equal(summary.tests[1].priority, 'P1');
    assert.equal(summary.tests[0].matchedCase, true);
  });

  it('reports cases with no executed test as not automated', () => {
    const report = makeReport([{ title: '[TC-001] 登录成功', status: 'expected' }]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.deepEqual(summary.notAutomated.map((entry) => entry.id), ['TC-002', 'TC-003']);
  });

  it('marks a case as failed when any of its tests fails', () => {
    const report = makeReport([
      { title: '[TC-001] 登录成功', status: 'expected', project: 'chromium' },
      { title: '[TC-001] 登录成功', status: 'unexpected', project: 'firefox', error: 'boom' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    const entry = summary.caseStatus.find((item) => item.id === 'TC-001');
    assert.equal(entry.status, 'failed');
    assert.equal(entry.attempts, 2);
  });

  it('marks a case as skipped only when every attempt was skipped', () => {
    const report = makeReport([
      { title: '[TC-001] x', status: 'skipped' },
      { title: '[TC-001] x', status: 'expected' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.caseStatus.find((item) => item.id === 'TC-001').status, 'passed');
  });

  it('reports tests that match no case', () => {
    const report = makeReport([{ title: '临时验证', status: 'expected' }]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.unmatchedTests.length, 1);
    assert.equal(summary.unmatchedTests[0].caseId, null);
  });

  it('collects attachments and retry counts', () => {
    const report = makeReport([
      {
        title: '[TC-001] x',
        status: 'unexpected',
        error: 'boom',
        attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/tmp/s.png' }],
      },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.tests[0].attachments[0].path, '/tmp/s.png');
    assert.equal(summary.tests[0].retries, 0);
  });

  it('surfaces infrastructure errors', () => {
    const report = makeReport([]);
    report.errors = [{ message: 'browser not found', location: { file: 'a.ts', line: 3 } }];
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.infrastructureErrors.length, 1);
    assert.ok(summary.infrastructureErrors[0].location.includes('a.ts:3'));
  });

  it('computes the pass rate over executed tests only', () => {
    const report = makeReport([
      { title: '[TC-001] a', status: 'expected' },
      { title: '[TC-002] b', status: 'unexpected' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.passRate, 50);
  });

  it('counts flaky tests as passing for the rate', () => {
    const report = makeReport([
      { title: '[TC-001] a', status: 'flaky' },
      { title: '[TC-002] b', status: 'expected' },
    ]);
    const summary = normalizeResults(report, { cases: CASE_LIST });
    assert.equal(summary.passRate, 100);
    assert.equal(summary.counts.flaky, 1);
  });
});

describe('verdicts', () => {
  const baseSummary = (overrides = {}) => ({
    counts: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0 },
    notAutomated: [],
    infrastructureErrors: [],
    passRate: 100,
    ...overrides,
  });

  it('passes a clean run', () => {
    assert.equal(verdictFor(baseSummary(), { cases: CASE_LIST }).verdict, 'passed');
  });

  it('fails when a test failed', () => {
    const verdict = verdictFor(baseSummary({ counts: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0, unknown: 0 } }), {
      cases: CASE_LIST,
    });
    assert.equal(verdict.verdict, 'failed');
    assert.ok(verdict.reasons.some((reason) => reason.includes('失败')));
  });

  it('is partial when cases were not automated', () => {
    const verdict = verdictFor(baseSummary({ notAutomated: [{ id: 'TC-003' }] }), { cases: CASE_LIST });
    assert.equal(verdict.verdict, 'partial');
  });

  it('is partial when tests were skipped', () => {
    const verdict = verdictFor(baseSummary({ counts: { total: 1, passed: 0, failed: 0, flaky: 0, skipped: 1, unknown: 0 } }), {
      cases: CASE_LIST,
    });
    assert.equal(verdict.verdict, 'partial');
  });

  it('is partial when a test was flaky', () => {
    const verdict = verdictFor(baseSummary({ counts: { total: 1, passed: 0, failed: 0, flaky: 1, skipped: 0, unknown: 0 } }), {
      cases: CASE_LIST,
    });
    assert.equal(verdict.verdict, 'partial');
  });

  it('fails when nothing ran', () => {
    const verdict = verdictFor(baseSummary({ counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, unknown: 0 } }), {
      cases: CASE_LIST,
    });
    assert.equal(verdict.verdict, 'failed');
  });

  it('fails on infrastructure errors even when tests passed', () => {
    const verdict = verdictFor(baseSummary({ infrastructureErrors: [{ message: 'x' }] }), { cases: CASE_LIST });
    assert.equal(verdict.verdict, 'failed');
  });
});

describe('report rendering', () => {
  const summary = {
    counts: { total: 2, passed: 1, failed: 1, flaky: 0, skipped: 0, unknown: 0 },
    passRate: 50,
    durationMs: 65000,
    startedAt: '2025-01-01T10:00:00.000Z',
    browsers: ['chromium'],
    tests: [
      {
        caseId: 'TC-001',
        title: '[TC-001] 登录成功',
        module: '登录',
        priority: 'P0',
        status: 'passed',
        durationMs: 900,
        error: '',
        retries: 0,
        file: 'demo.spec.ts',
        line: 10,
        attachments: [],
      },
      {
        caseId: 'TC-002',
        title: '[TC-002] 密码错误',
        module: '登录',
        priority: 'P1',
        status: 'failed',
        durationMs: 1200,
        error: 'Expected: "用户名或密码错误"\nReceived: ""',
        retries: 1,
        file: 'demo.spec.ts',
        line: 40,
        attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/tmp/run/test-results/f.png' }],
      },
    ],
    caseStatus: [
      { id: 'TC-001', title: '登录成功', module: '登录', priority: 'P0', status: 'passed', attempts: 1 },
      { id: 'TC-002', title: '密码错误', module: '登录', priority: 'P1', status: 'failed', attempts: 1 },
      { id: 'TC-003', title: '短信登录', module: '登录', priority: 'P1', status: 'not-automated', attempts: 0 },
    ],
    notAutomated: [{ id: 'TC-003', title: '短信登录', module: '登录', priority: 'P1' }],
    unmatchedTests: [],
    infrastructureErrors: [],
    verdict: { verdict: 'failed', label: '❌ 未通过', reasons: ['1 条用例失败。'] },
    artifacts: {
      htmlReport: '/tmp/run/playwright-report',
      jsonResults: '/tmp/run/test-results/results.json',
      summary: '/tmp/run/results-summary.json',
      testResults: '/tmp/run/test-results',
    },
  };

  const markdown = renderReport({
    cases: CASE_LIST,
    summary,
    config: { browsers: ['chromium'], headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', timeout: 30000, retries: 1, workers: 1 },
    runDir: '/tmp/run',
    baseURL: 'https://x.test',
    generatedAt: '2025-01-01T10:05:00.000Z',
  });

  it('starts with a title and the verdict', () => {
    assert.ok(markdown.startsWith('# 自动化测试报告'));
    assert.ok(markdown.includes('❌ 未通过'));
  });

  it('includes the summary table with all outcomes', () => {
    assert.ok(markdown.includes('| 通过 | 失败 | 不稳定 | 跳过 | 本次未执行 | 未自动化 | 通过率 |'));
    assert.ok(markdown.includes('| 1 | 1 | 0 | 0 | 0 | 1 | 50% |'));
  });

  it('lists every case with a status badge', () => {
    assert.ok(markdown.includes('✅ 通过'));
    assert.ok(markdown.includes('❌ 失败'));
    assert.ok(markdown.includes('🚫 未自动化'));
  });

  it('renders failure details with the error and screenshot', () => {
    assert.ok(markdown.includes('### 1. TC-002 [TC-002] 密码错误'));
    assert.ok(markdown.includes('Received: ""'));
    assert.ok(markdown.includes('/tmp/run/test-results/f.png'));
  });

  it('lists the not-automated coverage gap', () => {
    assert.ok(markdown.includes('## 四、未自动化用例'));
    assert.ok(markdown.includes('TC-003'));
    assert.ok(markdown.includes('不计入通过率'));
  });

  it('links the artifacts', () => {
    assert.ok(markdown.includes('/tmp/run/playwright-report/index.html'));
    assert.ok(markdown.includes('/tmp/run/results-summary.json'));
  });

  it('formats durations readably', () => {
    assert.ok(markdown.includes('1m5s'));
    assert.ok(markdown.includes('900ms'));
  });

  it('escapes pipes inside case titles', () => {
    const withPipe = renderReport({
      cases: [{ id: 'TC-9', title: 'a|b', module: 'm', priority: 'P0' }],
      summary: { ...summary, caseStatus: [], tests: [], notAutomated: [], unmatchedTests: [], infrastructureErrors: [] },
      config: {},
      runDir: '/tmp/run',
      baseURL: 'u',
    });
    assert.ok(withPipe.includes('a\\|b'));
  });

  it('says so when there are no failures', () => {
    const clean = renderReport({
      cases: [{ id: 'TC-1', title: 't', module: 'm', priority: 'P0' }],
      summary: {
        ...summary,
        tests: [summary.tests[0]],
        notAutomated: [],
        unmatchedTests: [],
        infrastructureErrors: [],
        counts: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0 },
        verdict: { verdict: 'passed', label: '✅ 通过', reasons: ['全部用例通过。'] },
      },
      config: {},
      runDir: '/tmp/run',
      baseURL: 'u',
    });
    assert.ok(clean.includes('没有失败用例。'));
    assert.ok(clean.includes('所有用例都已自动化。'));
  });
});

describe('coverage versus execution scope', () => {
  const CASES = [
    { id: 'TC-001', title: '登录成功', module: '登录', priority: 'P0' },
    { id: 'TC-002', title: '密码错误', module: '登录', priority: 'P1' },
    { id: 'TC-003', title: '短信登录', module: '登录', priority: 'P1' },
  ];

  /** A run that executed exactly one case, as `--grep TC-001` would. */
  const grepRun = () =>
    normalizeResults(
      makeReport([
        { title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] },
      ]),
      { cases: CASES, automatedCaseIds: ['TC-001', 'TC-002'], filter: { grep: 'TC-001' } },
    );

  it('separates "never automated" from "not executed this run"', () => {
    const summary = grepRun();
    assert.deepEqual(summary.notAutomated.map((entry) => entry.id), ['TC-003']);
    assert.deepEqual(summary.notExecuted.map((entry) => entry.id), ['TC-002']);
  });

  it('marks each case with the right status', () => {
    const byId = new Map(grepRun().caseStatus.map((entry) => [entry.id, entry.status]));
    assert.equal(byId.get('TC-001'), 'passed');
    assert.equal(byId.get('TC-002'), 'not-executed');
    assert.equal(byId.get('TC-003'), 'not-automated');
  });

  it('does not call a filtered run a coverage gap', () => {
    const pureFiltered = normalizeResults(
      makeReport([{ title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] }]),
      { cases: CASES, automatedCaseIds: CASES.map((entry) => entry.id), filter: { grep: 'TC-001' } },
    );
    const verdict = verdictFor(pureFiltered, { cases: CASES });
    assert.equal(verdict.verdict, 'partial');
    assert.equal(verdict.label, '⚠️ 筛选执行（未跑全量）');
    assert.ok(verdict.reasons.some((reason) => reason.includes('不是覆盖缺口')));
    assert.ok(verdict.reasons.some((reason) => reason.includes('--grep "TC-001"')));
  });

  it('still reports a real coverage gap as a coverage gap', () => {
    const summary = normalizeResults(
      makeReport([
        { title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] },
      ]),
      { cases: CASES, automatedCaseIds: ['TC-001'] },
    );
    const verdict = verdictFor(summary, { cases: CASES });
    assert.equal(verdict.label, '⚠️ 部分覆盖');
    assert.ok(verdict.reasons.some((reason) => reason.includes('2 条用例未自动化')));
  });

  it('mentions both when a filtered run also has a coverage gap', () => {
    const summary = grepRun();
    const verdict = verdictFor({ ...summary, notAutomated: [...summary.notAutomated, { id: 'TC-004' }] }, { cases: CASES });
    assert.ok(verdict.reasons.some((reason) => reason.includes('未自动化')));
    assert.ok(verdict.reasons.some((reason) => reason.includes('本次未执行')));
  });

  it('falls back to executed cases when no static index is available', () => {
    // Without the index there is no way to tell the two apart, so the summary
    // must not invent a "not executed" bucket.
    const summary = normalizeResults(
      makeReport([{ title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] }]),
      { cases: CASES },
    );
    assert.deepEqual(summary.notExecuted, []);
    assert.deepEqual(summary.notAutomated.map((entry) => entry.id), ['TC-002', 'TC-003']);
  });
});

describe('report sections for execution scope', () => {
  const CASES = [
    { id: 'TC-001', title: '登录成功', module: '登录', priority: 'P0' },
    { id: 'TC-002', title: '密码错误', module: '登录', priority: 'P1' },
    { id: 'TC-003', title: '短信登录', module: '登录', priority: 'P1' },
  ];

  const summary = normalizeResults(
    makeReport([{ title: '[TC-001] 登录成功', status: 'expected', annotations: [{ type: 'caseId', description: 'TC-001' }] }]),
    { cases: CASES, automatedCaseIds: ['TC-001', 'TC-002'], filter: { grep: 'TC-001' } },
  );

  const markdown = renderReport({
    cases: CASES,
    summary: { ...summary, verdict: verdictFor(summary, { cases: CASES }), attempt: { id: 'attempt-1', dir: '/tmp/run/attempts/attempt-1' } },
    config: { asyncTasks: { submitTimeout: 30000, completionTimeout: 180000 }, timeout: 30000 },
    runDir: '/tmp/run',
    baseURL: 'u',
  });

  it('renders the filtered-out cases as a separate section', () => {
    assert.ok(markdown.includes('本次未执行用例（筛选执行，非覆盖缺口）'));
    assert.ok(markdown.includes('已经有自动化代码'));
    assert.ok(markdown.includes('⏸️ 本次未执行'));
  });

  it('keeps the coverage-gap section about coverage only', () => {
    assert.ok(markdown.includes('未自动化用例（覆盖缺口）'));
    const gapSection = markdown.slice(markdown.indexOf('## 四、未自动化用例'), markdown.indexOf('## 五、本次未执行用例'));
    assert.ok(gapSection.includes('TC-003'));
    assert.ok(!gapSection.includes('TC-002'));
  });

  it('counts both buckets separately in the summary table', () => {
    assert.ok(markdown.includes('| 通过 | 失败 | 不稳定 | 跳过 | 本次未执行 | 未自动化 | 通过率 |'));
    assert.ok(markdown.includes('| 1 | 0 | 0 | 0 | 1 | 1 | 100% |'));
  });

  it('names the attempt directory so artifacts cannot be confused', () => {
    assert.ok(markdown.includes('attempt-1'));
    assert.ok(markdown.includes('附件不跨批次混用'));
  });

  it('documents the async budget', () => {
    assert.ok(markdown.includes('异步任务预算'));
    assert.ok(markdown.includes('等待异步任务的用例会自动放宽'));
  });
});

describe('step timeline in the report', () => {
  it('renders the timeline and points at the failing step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-timeline-'));
    const timeline = path.join(dir, 'timeline.json');
    fs.writeFileSync(
      timeline,
      JSON.stringify({
        steps: [
          { title: '提交生成任务', status: 'passed', durationMs: 120 },
          {
            title: '等待生成完成',
            status: 'failed',
            durationMs: 181000,
            observations: [
              { at: 0, state: 'Queued' },
              { at: 5000, state: '生成中' },
            ],
          },
        ],
      }),
    );

    const report = makeReport([
      {
        title: '[TC-001] 文生图',
        status: 'unexpected',
        error: '等待「等待生成完成」超时（180s）',
        annotations: [{ type: 'caseId', description: 'TC-001' }],
        attachments: [{ name: 'timeline', contentType: 'application/json', path: timeline }],
      },
    ]);
    const summary = normalizeResults(report, { cases: [{ id: 'TC-001', title: '文生图', module: '生成', priority: 'P0' }] });
    const markdown = renderReport({
      cases: [{ id: 'TC-001', title: '文生图', module: '生成', priority: 'P0' }],
      summary,
      config: {},
      runDir: '/tmp/run',
      baseURL: 'u',
    });

    assert.ok(markdown.includes('步骤时间线'));
    assert.ok(markdown.includes('提交生成任务'));
    assert.ok(markdown.includes('Queued（0ms） → 生成中（5.0s）'));
    assert.ok(markdown.includes('失败发生在「等待生成完成」这一步'));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('omits the timeline when no attachment was written', () => {
    const report = makeReport([{ title: '[TC-001] x', status: 'unexpected', error: 'boom' }]);
    const summary = normalizeResults(report, { cases: [] });
    const markdown = renderReport({ cases: [], summary, config: {}, runDir: '/tmp/run', baseURL: 'u' });
    assert.ok(!markdown.includes('步骤时间线'));
  });
});
