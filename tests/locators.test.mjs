import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STABILITY,
  buildLocatorCandidates,
  quote,
  rankElements,
  renderOutlineMarkdown,
  tidy,
} from '../skill/scripts/lib/locators.mjs';

/** Minimal element record with everything blank. */
const base = {
  tag: 'div',
  type: '',
  role: '',
  name: '',
  labelText: '',
  placeholder: '',
  title: '',
  alt: '',
  text: '',
  testId: '',
  testIdAttr: '',
  id: '',
  nameAttr: '',
  href: '',
  disabled: false,
  visible: true,
  cssPath: '',
};

describe('helpers', () => {
  it('escapes single quotes and backslashes in generated code', () => {
    assert.equal(quote("it's"), "'it\\'s'");
    assert.equal(quote('a\\b'), "'a\\\\b'");
  });

  it('collapses whitespace and truncates', () => {
    assert.equal(tidy('  a \n  b  '), 'a b');
    assert.equal(tidy('abcdef', 3), 'abc');
  });
});

describe('locator ranking', () => {
  it('prefers a test id above everything else', () => {
    const candidates = buildLocatorCandidates({
      ...base,
      tag: 'button',
      role: 'button',
      name: '登录',
      text: '登录',
      testId: 'submit-login',
      testIdAttr: 'data-testid',
      cssPath: 'form > button',
    });
    assert.equal(candidates[0].kind, 'testId');
    assert.equal(candidates[0].code, "getByTestId('submit-login')");
    assert.equal(candidates[0].stability, STABILITY.testId);
    assert.equal(candidates[0].note, undefined);
  });

  it('notes a non-default test id attribute', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'button', testId: 'go', testIdAttr: 'data-cy' });
    assert.ok(candidates[0].note.includes('testIdAttribute'));
    assert.ok(candidates[0].note.includes('data-cy'));
  });

  it('prefers role with an accessible name over label and text', () => {
    const candidates = buildLocatorCandidates({
      ...base,
      tag: 'button',
      role: 'button',
      name: '提交',
      text: '提交',
      labelText: '提交',
    });
    assert.equal(candidates[0].kind, 'role');
    assert.equal(candidates[0].code, "getByRole('button', { name: '提交' })");
  });

  it('falls back to label then placeholder for form fields', () => {
    const withLabel = buildLocatorCandidates({ ...base, tag: 'input', role: 'textbox', labelText: '用户名', placeholder: '请输入用户名' });
    assert.equal(withLabel[0].kind, 'label');

    const withoutLabel = buildLocatorCandidates({ ...base, tag: 'input', role: 'textbox', placeholder: '请输入用户名' });
    assert.equal(withoutLabel[0].kind, 'placeholder');
  });

  it('does not offer a text locator for a non-clickable container', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'div', text: '一段说明文字' });
    assert.equal(candidates.find((candidate) => candidate.kind === 'text'), undefined);
  });

  it('offers a text locator for links and buttons', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'a', role: 'link', href: '/x', text: '前往搜索' });
    assert.equal(candidates[0].kind, 'text');
  });

  it('skips an over-long text locator', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'a', role: 'link', text: 'x'.repeat(200) });
    assert.equal(candidates.find((candidate) => candidate.kind === 'text'), undefined);
  });

  it('always keeps the CSS path as a last resort, marked fragile', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'div', cssPath: 'div > div:nth-child(3)' });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'css');
    assert.equal(candidates[0].stability, STABILITY.css);
    assert.ok(candidates[0].note.includes('脆弱'));
  });

  it('deduplicates identical candidates', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'input', role: 'textbox', labelText: 'x', placeholder: 'x' });
    const codes = candidates.map((candidate) => candidate.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it('sorts by descending stability', () => {
    const candidates = buildLocatorCandidates({
      ...base,
      tag: 'button',
      role: 'button',
      name: 'go',
      text: 'go',
      title: 'go',
      testId: 'go',
      testIdAttr: 'data-testid',
      cssPath: '.go',
    });
    const stabilities = candidates.map((candidate) => candidate.stability);
    assert.deepEqual(stabilities, [...stabilities].sort((a, b) => b - a));
  });

  it('returns nothing for a bare element with no signals', () => {
    assert.deepEqual(buildLocatorCandidates({ ...base, tag: 'div' }), []);
  });
});

describe('rankElements', () => {
  it('attaches a recommendation and flags ambiguous elements', () => {
    const ranked = rankElements([
      { ...base, tag: 'button', role: 'button', name: '登录' },
      { ...base, tag: 'div' },
    ]);
    assert.equal(ranked[0].ambiguous, false);
    assert.equal(ranked[0].recommended.kind, 'role');
    assert.equal(ranked[1].ambiguous, true);
    assert.equal(ranked[1].recommended, null);
  });
});

describe('outline markdown', () => {
  it('renders a table with the recommended locator', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '登录' }]);
    const markdown = renderOutlineMarkdown({
      elements,
      meta: { url: 'https://x.test', title: '首页', viewport: { width: 1280, height: 720 } },
    });
    assert.ok(markdown.includes('https://x.test'));
    assert.ok(markdown.includes('| 元素 | 推荐定位器 | 稳定性 | 说明 |'));
    assert.ok(markdown.includes("page.getByRole('button', { name: '登录' })"));
  });

  it('marks elements with no semantic locator', () => {
    const elements = rankElements([{ ...base, tag: 'div' }]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'https://x.test', title: '', viewport: {} } });
    assert.ok(markdown.includes('无可语义定位器'));
  });

  it('escapes pipes so the table stays valid', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: 'a|b' }]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    const tableRow = markdown.split('\n').find((line) => line.includes('getByRole'));
    assert.ok(tableRow.includes('\\|'));
    // Four columns means five structural pipes once escaped ones are removed.
    const structural = tableRow.replace(/\\\|/g, '').split('|');
    assert.equal(structural.length, 6);
  });

  it('flags disabled elements', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '提交', disabled: true }]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    assert.ok(markdown.includes('disabled'));
  });

  it('renders a separate assertion-target section when present', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '登录' }]);
    const assertTargets = rankElements([
      { ...base, tag: 'strong', testId: 'cart-count', testIdAttr: 'data-testid', text: '0' },
    ]);
    const markdown = renderOutlineMarkdown({
      elements,
      assertTargets,
      meta: { url: 'u', title: 't', viewport: {} },
    });
    assert.ok(markdown.includes('## 可操作元素（点击 / 输入）'));
    assert.ok(markdown.includes('## 断言目标（只读，用于 expect）'));
    assert.ok(markdown.includes("getByTestId('cart-count')"));
    assert.ok(markdown.includes('可操作元素: 1'));
    assert.ok(markdown.includes('断言目标: 1'));
  });

  it('omits the assertion-target section when there is nothing to assert on', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '登录' }]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    assert.ok(!markdown.includes('断言目标（只读'));
  });
});
