import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseCsv, detectDelimiter } from '../skill/scripts/lib/csv.mjs';
import {
  countByPriority,
  groupByModule,
  mapHeaderRow,
  normalizeCase,
  normalizeKey,
  parseDataCell,
  parseTags,
  splitList,
  validateCases,
} from '../skill/scripts/lib/cases.mjs';
import { compactRows, readRows, cellText } from '../skill/scripts/lib/spreadsheet.mjs';

describe('csv parser', () => {
  it('parses a simple table', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted fields containing the delimiter and newlines', () => {
    const rows = parseCsv('id,steps\nTC-1,"打开页面\n点击登录"\n');
    assert.deepEqual(rows[1], ['TC-1', '打开页面\n点击登录']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('a\n"他说""你好"""\n');
    assert.equal(rows[1][0], '他说"你好"');
  });

  it('strips a UTF-8 BOM', () => {
    assert.deepEqual(parseCsv('\uFEFFa,b\n')[0], ['a', 'b']);
  });

  it('detects semicolon and tab delimiters', () => {
    assert.equal(detectDelimiter('a;b;c'), ';');
    assert.equal(detectDelimiter('a\tb\tc'), '\t');
    assert.equal(detectDelimiter('a,b,c'), ',');
  });

  it('does not treat a delimited character inside quotes as a separator', () => {
    const rows = parseCsv('a;b\n"x;y";z\n');
    assert.deepEqual(rows[1], ['x;y', 'z']);
  });
});

describe('header mapping', () => {
  it('accepts Chinese and English aliases', () => {
    const { mapping, missing } = mapHeaderRow(['用例编号', 'Module', '标题', 'Priority', '测试步骤', 'Expected Result']);
    assert.deepEqual(missing, []);
    assert.equal(mapping.id, 0);
    assert.equal(mapping.module, 1);
    assert.equal(mapping.title, 2);
    assert.equal(mapping.priority, 3);
    assert.equal(mapping.steps, 4);
    assert.equal(mapping.expected, 5);
  });

  it('ignores whitespace, full-width punctuation and case', () => {
    assert.equal(normalizeKey(' 用例 ID '), '用例id');
    assert.equal(normalizeKey('Case ID'), 'caseid');
    assert.equal(normalizeKey('操作步骤（必填）'), '操作步骤必填');
  });

  it('reports the missing required columns', () => {
    const { missing } = mapHeaderRow(['模块', '优先级']);
    assert.deepEqual(missing.sort(), ['steps', 'title']);
  });

  it('collects unrecognized columns', () => {
    const { unknown } = mapHeaderRow(['用例标题', '操作步骤', '负责人']);
    assert.deepEqual(unknown, ['负责人']);
  });
});

describe('multi-value cells', () => {
  it('splits on newlines and strips numbering', () => {
    assert.deepEqual(splitList('1. 打开页面\n2. 点击登录\n3、输入账号'), ['打开页面', '点击登录', '输入账号']);
  });

  it('splits on pipes', () => {
    assert.deepEqual(splitList('打开页面 | 点击登录'), ['打开页面', '点击登录']);
  });

  it('splits inline numbering on a single line', () => {
    assert.deepEqual(splitList('1. 打开页面 2. 点击登录 3. 输入账号'), ['打开页面', '点击登录', '输入账号']);
  });

  it('returns an empty list for blank input', () => {
    assert.deepEqual(splitList(''), []);
    assert.deepEqual(splitList(null), []);
  });

  it('parses key=value test data', () => {
    assert.deepEqual(parseDataCell('用户名=admin; 密码=123456'), { 用户名: 'admin', 密码: '123456' });
    assert.deepEqual(parseDataCell('a=1|b=2'), { a: '1', b: '2' });
    assert.deepEqual(parseDataCell('没有等号'), {});
  });

  it('parses tags with several separators', () => {
    assert.deepEqual(parseTags('smoke, 回归|@P0'), ['smoke', '回归', 'P0']);
  });
});

describe('case normalization', () => {
  const mapping = mapHeaderRow(['用例ID', '模块', '用例标题', '优先级', '前置条件', '操作步骤', '预期结果', '测试数据', '标签']).mapping;

  it('normalizes a full row', () => {
    const testCase = normalizeCase(
      ['TC-001', '登录', '登录成功', 'P0', '已注册', '打开页面|输入账号|点击登录', '跳转首页|显示昵称', '用户名=admin', 'smoke'],
      mapping,
      { index: 0, rowRef: 2 },
    );
    assert.equal(testCase.id, 'TC-001');
    assert.equal(testCase.module, '登录');
    assert.equal(testCase.priority, 'P0');
    assert.deepEqual(testCase.steps, ['打开页面', '输入账号', '点击登录']);
    assert.deepEqual(testCase.expected, ['跳转首页', '显示昵称']);
    assert.deepEqual(testCase.data, { 用户名: 'admin' });
    assert.deepEqual(testCase.tags, ['smoke']);
    assert.equal(testCase.rowRef, 2);
    assert.equal(testCase.autoId, false);
  });

  it('auto-numbers a missing id and defaults the module and priority', () => {
    const testCase = normalizeCase(['', '', '标题', '', '', '步骤'], mapping, { index: 4, rowRef: 6 });
    assert.equal(testCase.id, 'TC-005');
    assert.equal(testCase.autoId, true);
    assert.equal(testCase.module, '未分类');
    assert.equal(testCase.priority, 'P2');
    assert.equal(testCase.priorityAssumed, true);
  });

  it('flags an invalid priority', () => {
    const testCase = normalizeCase(['TC-1', 'm', 't', '紧急', '', 's'], mapping, { index: 0, rowRef: 2 });
    assert.equal(testCase.priority, 'P2');
    assert.equal(testCase.priorityAssumed, true);
  });
});

describe('case validation', () => {
  const mapping = mapHeaderRow(['用例ID', '模块', '用例标题', '优先级', '前置条件', '操作步骤', '预期结果', '测试数据', '标签']).mapping;
  const build = (row, index) => normalizeCase(row, mapping, { index, rowRef: index + 2 });

  it('accepts a clean list', () => {
    const cases = [build(['TC-001', 'm', 't', 'P0', '', 'step', 'expect', '', ''], 0)];
    assert.deepEqual(validateCases(cases), []);
  });

  it('warns about a missing title and steps', () => {
    const warnings = validateCases([build(['TC-001', 'm', '', 'P0', '', '', 'expect', '', ''], 0)]);
    assert.ok(warnings.some((w) => w.includes('缺少用例标题')));
    assert.ok(warnings.some((w) => w.includes('没有任何操作步骤')));
  });

  it('warns when several steps map to several mismatched expectations', () => {
    const warnings = validateCases([build(['TC-001', 'm', 't', 'P0', '', 'a|b|c', 'x|y', '', ''], 0)]);
    assert.ok(warnings.some((w) => w.includes('数量不一致')));
  });

  it('treats a single expectation as the overall result, without warning', () => {
    const warnings = validateCases([build(['TC-001', 'm', 't', 'P0', '', 'a|b|c', '全部成功', '', ''], 0)]);
    assert.deepEqual(warnings, []);
  });

  it('warns about duplicate ids', () => {
    const warnings = validateCases([
      build(['TC-001', 'm', 'a', 'P0', '', 's', 'e', '', ''], 0),
      build(['TC-001', 'm', 'b', 'P0', '', 's', 'e', '', ''], 1),
    ]);
    assert.ok(warnings.some((w) => w.includes('重复')));
  });

  it('warns when the expected result is missing', () => {
    const warnings = validateCases([build(['TC-001', 'm', 't', 'P0', '', 's', '', '', ''], 0)]);
    assert.ok(warnings.some((w) => w.includes('没有预期结果')));
  });
});

describe('grouping helpers', () => {
  const cases = [
    { module: '登录', priority: 'P0' },
    { module: '登录', priority: 'P1' },
    { module: '搜索', priority: 'P0' },
  ];

  it('groups by module preserving order', () => {
    const groups = groupByModule(cases);
    assert.deepEqual(groups.map((g) => [g.module, g.cases.length]), [
      ['登录', 2],
      ['搜索', 1],
    ]);
  });

  it('counts by priority', () => {
    assert.deepEqual(countByPriority(cases), { P0: 2, P1: 1 });
  });
});

describe('spreadsheet readers', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cases-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a Markdown table and skips the alignment row', async () => {
    const file = path.join(dir, 'cases.md');
    fs.writeFileSync(
      file,
      ['| 用例ID | 用例标题 | 操作步骤 |', '| --- | --- | --- |', '| TC-001 | 登录 | 打开页面<br>点击登录 |'].join('\n'),
    );
    const { format, rows } = await readRows(file);
    assert.equal(format, 'markdown');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], ['TC-001', '登录', '打开页面<br>点击登录']);
  });

  it('throws a helpful error when a Markdown file has no table', async () => {
    const file = path.join(dir, 'plain.md');
    fs.writeFileSync(file, '# 没有表格\n');
    await assert.rejects(() => readRows(file), /没有找到 Markdown 表格/);
  });

  it('reads CSV through the shared entry point', async () => {
    const file = path.join(dir, 'cases.csv');
    fs.writeFileSync(file, '用例标题,操作步骤\n登录,打开页面\n');
    const { format, rows } = await readRows(file);
    assert.equal(format, 'csv');
    assert.equal(rows.length, 2);
  });

  it('rejects unsupported extensions with the supported list', async () => {
    const file = path.join(dir, 'cases.pdf');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => readRows(file), /不支持的用例文件格式/);
  });

  it('reports a missing file clearly', async () => {
    await assert.rejects(() => readRows(path.join(dir, 'nope.csv')), /找不到用例文件/);
  });

  it('compacts empty rows and trailing empty cells', () => {
    assert.deepEqual(compactRows([['a', 'b', ''], ['', ' '], ['c']]), [['a', 'b'], ['c']]);
  });

  it('flattens rich text and formula cell values', () => {
    assert.equal(cellText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
    assert.equal(cellText({ result: 42 }), '42');
    assert.equal(cellText({ text: 'hi', hyperlink: 'http://x' }), 'hi');
    assert.equal(cellText({ error: '#REF!' }), '');
    assert.equal(cellText(null), '');
    assert.equal(cellText(7), '7');
  });

  it('parses the shipped CSV template', async () => {
    const template = path.join(process.cwd(), 'skill', 'assets', 'case-template.csv');
    const { rows } = await readRows(template);
    const { mapping, missing } = mapHeaderRow(rows[0]);
    assert.deepEqual(missing, []);

    const cases = rows.slice(1).map((row, index) => normalizeCase(row, mapping, { index, rowRef: index + 2 }));
    assert.ok(cases.length >= 5);
    assert.deepEqual(validateCases(cases), []);
    assert.ok(cases.every((testCase) => testCase.steps.length > 0));
  });
});
