/**
 * Test-case normalization: turn a spreadsheet row into the canonical case shape
 * the rest of the skill consumes.
 *
 * The canonical shape is deliberately flat and JSON-safe so it can be written to
 * `cases.json`, diffed between runs, and joined with Playwright results.
 */

/** Canonical field order, also used to render the case template. */
export const CANONICAL_COLUMNS = [
  '用例ID',
  '模块',
  '用例标题',
  '优先级',
  '前置条件',
  '操作步骤',
  '预期结果',
  '测试数据',
  '标签',
];

/** Accepted header spellings, normalized via {@link normalizeKey}. */
const COLUMN_ALIASES = {
  id: ['用例id', '用例编号', '编号', 'id', 'caseid', 'case', 'no'],
  module: ['模块', '所属模块', '功能模块', '业务模块', 'module', 'feature'],
  title: ['用例标题', '标题', '用例名称', '名称', 'title', 'name', 'case title'],
  priority: ['优先级', '级别', '优先级别', 'priority', 'level', 'p'],
  preconditions: ['前置条件', '前提条件', '预置条件', '前置', 'preconditions', 'precondition'],
  steps: ['操作步骤', '测试步骤', '步骤', '操作过程', 'steps', 'step', 'actions'],
  expected: ['预期结果', '期望结果', '预期', '期望', 'expected', 'expectedresult', 'result'],
  data: ['测试数据', '数据', '测试输入', 'testdata', 'data', 'input'],
  tags: ['标签', '标记', '分类', 'tags', 'tag', 'labels'],
};

const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

/**
 * Collapse a header cell to a comparison key.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000_\-—–:：()（）[\]【】.。/、,，]/g, '')
    .trim();
}

/**
 * Map a raw header row onto canonical field names.
 * @param {unknown[]} headerRow
 * @returns {{mapping: Record<string, number>, unknown: string[], missing: string[]}}
 */
export function mapHeaderRow(headerRow) {
  const lookup = new Map();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) lookup.set(normalizeKey(alias), field);
  }

  const mapping = {};
  const unknown = [];
  headerRow.forEach((cell, index) => {
    const key = normalizeKey(cell);
    if (key === '') return;
    const field = lookup.get(key);
    if (field === undefined) {
      unknown.push(String(cell).trim());
      return;
    }
    if (mapping[field] === undefined) mapping[field] = index;
  });

  const required = ['title', 'steps'];
  const missing = required.filter((field) => mapping[field] === undefined);
  return { mapping, unknown, missing };
}

/**
 * Split a multi-value cell into an ordered list.
 *
 * Handles three authoring styles, in priority order: real newlines, pipe
 * separators, and inline numbering such as `1. 打开页面 2. 点击登录`.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitList(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (text === '') return [];

  let parts;
  if (text.includes('\n')) {
    parts = text.split('\n');
  } else if (text.includes('|')) {
    parts = text.split('|');
  } else {
    const numbered = text.split(/(?=(?:^|\s)\d+\s*[.、)）]\s*)/);
    parts = numbered.length > 1 ? numbered : [text];
  }

  return parts
    .map((part) => part.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim())
    .filter((part) => part !== '');
}

/**
 * Parse a `k=v; k2=v2` cell into an object.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
export function parseDataCell(value) {
  const text = String(value ?? '').trim();
  if (text === '' || !text.includes('=')) return {};
  const out = {};
  for (const chunk of text.split(/[\n;；|]+/)) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key !== '') out[key] = val;
  }
  return out;
}

/**
 * Parse a tag cell into a list.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseTags(value) {
  return String(value ?? '')
    .split(/[,，;；|、\s]+/)
    .map((tag) => tag.trim().replace(/^@/, ''))
    .filter((tag) => tag !== '');
}

/**
 * Normalize one spreadsheet row into a canonical case.
 * @param {unknown[]} row
 * @param {Record<string, number>} mapping
 * @param {{index: number, rowRef: number}} position
 * @returns {object}
 */
export function normalizeCase(row, mapping, position) {
  const cell = (field) => {
    const index = mapping[field];
    return index === undefined ? undefined : row[index];
  };

  const rawId = String(cell('id') ?? '').trim();
  const autoId = rawId === '';
  const id = autoId ? `TC-${String(position.index + 1).padStart(3, '0')}` : rawId;

  const rawPriority = String(cell('priority') ?? '').trim().toUpperCase();
  const priority = VALID_PRIORITIES.has(rawPriority) ? rawPriority : 'P2';

  const steps = splitList(cell('steps'));
  const expected = splitList(cell('expected'));
  const dataRaw = String(cell('data') ?? '').trim();

  return {
    id,
    autoId,
    module: String(cell('module') ?? '').trim() || '未分类',
    title: String(cell('title') ?? '').trim(),
    priority,
    priorityAssumed: !VALID_PRIORITIES.has(rawPriority),
    preconditions: splitList(cell('preconditions')),
    steps,
    expected,
    data: parseDataCell(dataRaw),
    dataRaw,
    tags: parseTags(cell('tags')),
    rowRef: position.rowRef,
  };
}

/**
 * Validate a normalized case list and collect non-fatal problems.
 * @param {object[]} cases
 * @returns {string[]}
 */
export function validateCases(cases) {
  const warnings = [];
  const seen = new Map();

  for (const testCase of cases) {
    if (testCase.title === '') {
      warnings.push(`第 ${testCase.rowRef} 行（${testCase.id}）缺少用例标题。`);
    }
    if (testCase.steps.length === 0) {
      warnings.push(`第 ${testCase.rowRef} 行（${testCase.id}）没有任何操作步骤，将无法自动化。`);
    }
    if (testCase.expected.length === 0) {
      warnings.push(`第 ${testCase.rowRef} 行（${testCase.id}）没有预期结果，只能验证「不报错」。`);
    }
    // A single expectation is the overall result for the whole case — the normal
    // way testers write a case. Only a genuine many-to-many mismatch is a problem.
    if (testCase.expected.length > 1 && testCase.expected.length !== testCase.steps.length) {
      warnings.push(
        `第 ${testCase.rowRef} 行（${testCase.id}）操作步骤 ${testCase.steps.length} 条，` +
          `预期结果 ${testCase.expected.length} 条，数量不一致，将按顺序尽力对应。`,
      );
    }
    if (testCase.priorityAssumed) {
      warnings.push(`第 ${testCase.rowRef} 行（${testCase.id}）优先级缺失或非法，已按 P2 处理。`);
    }
    if (testCase.autoId) {
      warnings.push(`第 ${testCase.rowRef} 行缺少用例ID，已自动编号为 ${testCase.id}。`);
    }
    const previous = seen.get(testCase.id);
    if (previous !== undefined) {
      warnings.push(`用例ID ${testCase.id} 重复（第 ${previous} 行与第 ${testCase.rowRef} 行）。`);
    } else {
      seen.set(testCase.id, testCase.rowRef);
    }
  }

  return warnings;
}

/**
 * Group cases by module, preserving first-seen order.
 * @param {object[]} cases
 * @returns {{module: string, cases: object[]}[]}
 */
export function groupByModule(cases) {
  const groups = new Map();
  for (const testCase of cases) {
    if (!groups.has(testCase.module)) groups.set(testCase.module, []);
    groups.get(testCase.module).push(testCase);
  }
  return [...groups.entries()].map(([module, list]) => ({ module, cases: list }));
}

/**
 * Count cases per priority.
 * @param {object[]} cases
 * @returns {Record<string, number>}
 */
export function countByPriority(cases) {
  const counts = {};
  for (const testCase of cases) {
    counts[testCase.priority] = (counts[testCase.priority] ?? 0) + 1;
  }
  return counts;
}
