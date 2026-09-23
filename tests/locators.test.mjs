import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STABILITY,
  buildLocatorCandidates,
  dynamicRegexSource,
  isDynamicText,
  quote,
  rankElements,
  renderOutlineMarkdown,
  stableFragmentSource,
  suggestSuccessSignals,
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
    assert.ok(markdown.includes('| 元素 | 文本类型 | 推荐定位器 | 稳定性 | 备选定位器 | 说明 |'));
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
    // Six columns means seven structural pipes once escaped ones are removed.
    const structural = tableRow.replace(/\\\|/g, '').split('|');
    assert.equal(structural.length, 8);
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

describe('dynamic text', () => {
  it('flags text that changes with the data', () => {
    for (const text of ['积分 1200', '余额：¥58.00', '第 3 页', '3/10', '2025-01-02', '12:30', '生成中 45%', '5 items left']) {
      assert.equal(isDynamicText(text), true, `${text} 应被判为动态文本`);
    }
  });

  it('leaves stable names alone even when they contain digits', () => {
    // A bare digit is not enough: model names and step labels are stable.
    for (const text of ['GPT-4o', 'Step 1', '登录', 'Claude 3.5 Sonnet 模型配置', '']) {
      assert.equal(isDynamicText(text), false, `${text} 不应被判为动态文本`);
    }
  });

  it('generalises numbers into a digit pattern', () => {
    assert.equal(dynamicRegexSource('积分 1200'), '积分\\s+\\d+');
    assert.equal(dynamicRegexSource('3/10'), '\\d+\\/\\d+');
  });

  it('keeps the stable words for a loose fallback', () => {
    assert.equal(stableFragmentSource('积分 1200'), '积分');
    assert.equal(stableFragmentSource('余额 100 积分'), '余额\\s*积分');
    // Nothing but numbers left: no usable fragment.
    assert.equal(stableFragmentSource('1200'), '');
  });

  it('ranks a regex locator above the literal one for a dynamic name', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'button', role: 'button', name: '积分 1200', text: '积分 1200' });
    assert.equal(candidates[0].code, "getByRole('button', { name: /积分\\s+\\d+/ })");
    assert.equal(candidates[0].stability, STABILITY.roleRegex);
    assert.ok(candidates[0].note.includes('动态'));
    // The literal locator is still offered, with a warning attached.
    const literal = candidates.find((candidate) => candidate.code.includes("name: '积分 1200'"));
    assert.ok(literal.note.includes('可能随时失效'));
  });

  it('keeps the literal locator first when the name is stable', () => {
    const candidates = buildLocatorCandidates({ ...base, tag: 'button', role: 'button', name: '登录', text: '登录' });
    assert.equal(candidates[0].code, "getByRole('button', { name: '登录' })");
    assert.equal(candidates[0].note, undefined);
  });

  it('marks dynamic and stable text in the outline', () => {
    const elements = rankElements([
      { ...base, tag: 'button', role: 'button', name: '积分 1200' },
      { ...base, tag: 'button', role: 'button', name: '登录' },
    ]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    assert.ok(markdown.includes('⚠️ 动态文本'));
    assert.ok(markdown.includes('✅ 稳定文本'));
    assert.ok(markdown.includes('动态文本元素: 1'));
  });

  it('offers fallback locators so a broken first choice has a next step', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '积分 1200', testId: 'points' }]);
    assert.equal(elements[0].recommended.kind, 'testId');
    assert.ok(elements[0].alternatives.length >= 2);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    assert.ok(markdown.includes('备选定位器'));
    assert.ok(markdown.includes('page.getByRole'));
  });
});

describe('post-login signals', () => {
  it('suggests stable post-login elements', () => {
    const elements = rankElements([
      { ...base, tag: 'button', role: 'button', name: 'Upgrade' },
      { ...base, tag: 'button', role: 'button', name: '登录' },
      { ...base, tag: 'button', role: 'button', name: '账户菜单' },
      { ...base, tag: 'button', role: 'button', name: '忘记密码' },
    ]);
    const signals = suggestSuccessSignals(elements);
    assert.deepEqual(signals.map((element) => element.name), ['Upgrade', '账户菜单']);
  });

  it('does not suggest login-form fields as success signals', () => {
    // A textbox labelled 「账号」 matches the keyword but is on the login form.
    const elements = rankElements([
      { ...base, tag: 'input', role: 'textbox', name: '账号', labelText: '账号' },
      { ...base, tag: 'button', role: 'button', name: '账户菜单' },
    ]);
    assert.deepEqual(suggestSuccessSignals(elements).map((element) => element.name), ['账户菜单']);
  });

  it('renders them as a config-ready section', () => {
    const elements = rankElements([{ ...base, tag: 'button', role: 'button', name: '模型配置' }]);
    const markdown = renderOutlineMarkdown({ elements, meta: { url: 'u', title: 't', viewport: {} } });
    assert.ok(markdown.includes('登录成功信号候选（用于 auth.successSelector）'));
  });
});
