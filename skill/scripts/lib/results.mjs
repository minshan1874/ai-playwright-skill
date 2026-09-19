/**
 * Normalize Playwright's JSON reporter output into the flat shape the report
 * generator and any downstream CI consumer expect.
 *
 * The join key is the `caseId` annotation, falling back to a `[TC-001]` prefix in
 * the test title, so every executed test maps back to a row of the source
 * spreadsheet.
 */

/** Playwright status -> our status. */
const STATUS_MAP = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

/** CSI escape sequences, which Playwright embeds in error messages. */
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Strip terminal color codes.
 *
 * Playwright colorizes assertion diffs even when writing the JSON report, and
 * those escapes would otherwise end up verbatim in the Markdown report.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

/**
 * Extract a case id from a test title such as `[TC-001] 登录成功`.
 * @param {string} title
 * @returns {string|null}
 */
export function caseIdFromTitle(title) {
  const match = /\[([A-Za-z]+-\d+)\]/.exec(String(title ?? ''));
  return match === null ? null : match[1];
}

/**
 * Read an annotation value by type.
 * @param {object[]} annotations
 * @param {string} type
 * @returns {string|null}
 */
export function annotationValue(annotations, type) {
  for (const annotation of annotations ?? []) {
    if (annotation?.type === type) return annotation.description ?? null;
  }
  return null;
}

/**
 * Walk Playwright's nested suite tree and yield every test.
 * @param {object[]} suites
 * @param {string[]} trail
 * @returns {object[]}
 */
export function flattenSuites(suites, trail = []) {
  const out = [];
  for (const suite of suites ?? []) {
    const title = suite?.title ? String(suite.title) : '';
    // Playwright repeats the file name as the root suite title; skip that noise.
    const nextTrail = title && title !== suite?.file ? [...trail, title] : trail;
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) {
        out.push({ suite: nextTrail, spec, test });
      }
    }
    out.push(...flattenSuites(suite?.suites, nextTrail));
  }
  return out;
}

/**
 * Collect attachments from every attempt of a test.
 * @param {object[]} results
 * @returns {object[]}
 */
function collectAttachments(results) {
  const attachments = [];
  for (const result of results ?? []) {
    for (const attachment of result?.attachments ?? []) {
      attachments.push({
        name: attachment?.name ?? '',
        contentType: attachment?.contentType ?? '',
        path: attachment?.path ?? '',
      });
    }
  }
  return attachments;
}

/**
 * Pull the most useful error message out of a test's attempts.
 * @param {object[]} results
 * @returns {string}
 */
function collectError(results) {
  for (const result of results ?? []) {
    if (result?.error?.message) return stripAnsi(result.error.message).trim();
    if (typeof result?.error === 'string') return stripAnsi(result.error).trim();
  }
  return '';
}

/**
 * Normalize a Playwright JSON report.
 * @param {object} report parsed `results.json`
 * @param {{cases?: object[]}} [options] parsed `cases.json`
 * @returns {object}
 */
export function normalizeResults(report, options = {}) {
  const cases = options.cases ?? [];
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

  const tests = [];
  for (const entry of flattenSuites(report?.suites)) {
    const { spec, test, suite } = entry;
    const annotations = test?.annotations ?? [];
    const results = test?.results ?? [];

    const caseId = annotationValue(annotations, 'caseId') ?? caseIdFromTitle(spec?.title);
    const durationMs = results.reduce((total, result) => total + (Number(result?.duration) || 0), 0);
    const known = caseId === null ? undefined : byId.get(caseId);

    tests.push({
      caseId,
      title: String(spec?.title ?? ''),
      suite: suite.join(' › '),
      module: annotationValue(annotations, 'module') ?? known?.module ?? (suite[0] ?? '未分类'),
      priority: annotationValue(annotations, 'priority') ?? known?.priority ?? 'P2',
      tags: (test?.tags ?? []).map((tag) => String(tag).replace(/^@/, '')),
      status: STATUS_MAP[test?.status] ?? 'unknown',
      rawStatus: String(test?.status ?? 'unknown'),
      durationMs,
      error: collectError(results),
      retries: Math.max(0, results.length - 1),
      project: String(test?.projectName ?? ''),
      file: String(spec?.file ?? ''),
      line: Number(spec?.line ?? 0),
      attachments: collectAttachments(results),
      matchedCase: known !== undefined,
    });
  }

  const counts = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0, unknown: 0 };
  for (const test of tests) {
    if (counts[test.status] === undefined) counts.unknown += 1;
    else counts[test.status] += 1;
  }

  // Coverage: which spreadsheet cases never produced a test.
  const executed = new Set(tests.map((test) => test.caseId).filter((id) => id !== null));
  const notAutomated = cases
    .filter((testCase) => !executed.has(testCase.id))
    .map((testCase) => ({ id: testCase.id, title: testCase.title, module: testCase.module, priority: testCase.priority }));

  const caseStatus = cases.map((testCase) => {
    const matches = tests.filter((test) => test.caseId === testCase.id);
    // Precedence: a failure anywhere wins, then flakiness, then a real pass.
    // Only when every attempt was skipped is the case itself skipped.
    let status = 'not-automated';
    if (matches.some((test) => test.status === 'failed')) status = 'failed';
    else if (matches.some((test) => test.status === 'flaky')) status = 'flaky';
    else if (matches.some((test) => test.status === 'passed')) status = 'passed';
    else if (matches.length > 0 && matches.every((test) => test.status === 'skipped')) status = 'skipped';
    else if (matches.length > 0) status = matches[0].status;
    return {
      id: testCase.id,
      title: testCase.title,
      module: testCase.module,
      priority: testCase.priority,
      rowRef: testCase.rowRef,
      status,
      attempts: matches.length,
    };
  });

  const matched = new Set(cases.map((testCase) => testCase.id));
  const unmatchedTests = tests
    .filter((test) => test.caseId === null || !matched.has(test.caseId))
    .map((test) => ({ title: test.title, caseId: test.caseId, file: test.file, line: test.line }));

  const infrastructureErrors = (report?.errors ?? []).map((error) => ({
    message: stripAnsi(error?.message ?? error ?? '').trim(),
    location: error?.location ? `${error.location.file}:${error.location.line}` : '',
  }));

  const attempted = counts.passed + counts.failed + counts.flaky;
  const passRate = attempted === 0 ? 0 : Number((((counts.passed + counts.flaky) / attempted) * 100).toFixed(1));

  return {
    counts,
    passRate,
    durationMs: Number(report?.stats?.duration ?? 0),
    startedAt: report?.stats?.startTime ?? null,
    tests,
    caseStatus,
    notAutomated,
    unmatchedTests,
    infrastructureErrors,
    projects: [...new Set(tests.map((test) => test.project).filter(Boolean))],
    playwrightStats: {
      expected: Number(report?.stats?.expected ?? 0),
      unexpected: Number(report?.stats?.unexpected ?? 0),
      flaky: Number(report?.stats?.flaky ?? 0),
      skipped: Number(report?.stats?.skipped ?? 0),
    },
  };
}

/**
 * Decide the overall verdict for a run.
 * @param {object} summary normalized results
 * @param {{cases?: object[]}} [options]
 * @returns {{verdict: 'passed'|'failed'|'partial', label: string, reasons: string[]}}
 */
export function verdictFor(summary, options = {}) {
  const reasons = [];
  const totalCases = (options.cases ?? []).length;

  if (summary.infrastructureErrors.length > 0) {
    // Something broke outside the tests themselves, so the run cannot be trusted
    // even if every test that did execute passed.
    reasons.push(`${summary.infrastructureErrors.length} 个基础设施错误（用例未真正执行）。`);
    return { verdict: 'failed', label: '❌ 未通过', reasons };
  }
  if (summary.counts.total === 0) {
    reasons.push('没有执行任何用例。');
    return { verdict: 'failed', label: '❌ 未执行', reasons };
  }
  if (summary.counts.failed > 0) {
    reasons.push(`${summary.counts.failed} 条用例失败。`);
    return { verdict: 'failed', label: '❌ 未通过', reasons };
  }
  if (summary.notAutomated.length > 0) {
    reasons.push(`${summary.notAutomated.length} 条用例未自动化（共 ${totalCases} 条）。`);
    return { verdict: 'partial', label: '⚠️ 部分覆盖', reasons };
  }
  if (summary.counts.skipped > 0) {
    reasons.push(`${summary.counts.skipped} 条用例被跳过。`);
    return { verdict: 'partial', label: '⚠️ 部分覆盖', reasons };
  }
  if (summary.counts.flaky > 0) {
    reasons.push(`${summary.counts.flaky} 条用例重试后通过（flaky）。`);
    return { verdict: 'partial', label: '⚠️ 存在不稳定用例', reasons };
  }
  reasons.push('全部用例通过。');
  return { verdict: 'passed', label: '✅ 通过', reasons };
}
