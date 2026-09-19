/**
 * Locator candidate ranking.
 *
 * Playwright rewards semantic locators; CSS paths break on every refactor. This
 * module turns the raw element record collected by `explore.mjs` into an ordered
 * list of candidate locators, best first, so the agent writes resilient specs
 * instead of guessing.
 *
 * The ranking lives here — not in the injected browser script — so it can be
 * unit-tested without a browser.
 */

/** Higher is more resilient to UI refactors. */
export const STABILITY = {
  testId: 100,
  role: 90,
  label: 85,
  placeholder: 80,
  text: 70,
  title: 60,
  css: 20,
};

/** Attributes treated as a test id, in preference order. */
export const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

/**
 * Escape a string for use inside a single-quoted JS literal.
 * @param {string} value
 * @returns {string}
 */
export function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * Collapse whitespace and cap length so generated code stays readable.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function tidy(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Build ordered locator candidates for one element.
 * @param {object} element raw record from the page
 * @returns {{kind: string, code: string, stability: number, note?: string}[]}
 */
export function buildLocatorCandidates(element) {
  const candidates = [];
  const push = (kind, code, stability, note) => {
    if (code === null || code === undefined) return;
    if (candidates.some((candidate) => candidate.code === code)) return;
    candidates.push({ kind, code, stability, ...(note ? { note } : {}) });
  };

  const role = tidy(element.role);
  const name = tidy(element.name);
  const label = tidy(element.labelText);
  const placeholder = tidy(element.placeholder);
  const text = tidy(element.text);
  const title = tidy(element.title);
  const testId = tidy(element.testId);
  const testIdAttr = tidy(element.testIdAttr) || 'data-testid';

  if (testId !== '') {
    const note = testIdAttr === 'data-testid' ? undefined : `需在 playwright.config.ts 设置 testIdAttribute: ${quote(testIdAttr)}`;
    push('testId', `getByTestId(${quote(testId)})`, STABILITY.testId, note);
  }

  if (role !== '' && name !== '') {
    push('role', `getByRole(${quote(role)}, { name: ${quote(name)} })`, STABILITY.role);
  }

  if (label !== '') push('label', `getByLabel(${quote(label)})`, STABILITY.label);
  if (placeholder !== '') push('placeholder', `getByPlaceholder(${quote(placeholder)})`, STABILITY.placeholder);

  const isClickable = ['a', 'button', 'summary'].includes(String(element.tag).toLowerCase()) ||
    ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(role);
  if (isClickable && text !== '' && text.length <= 60) {
    push('text', `getByText(${quote(text)})`, STABILITY.text);
  }

  if (title !== '') push('title', `getByTitle(${quote(title)})`, STABILITY.title);

  if (typeof element.cssPath === 'string' && element.cssPath !== '') {
    push('css', `locator(${quote(element.cssPath)})`, STABILITY.css, '脆弱：仅在无语义定位器时使用');
  }

  return candidates.sort((a, b) => b.stability - a.stability);
}

/**
 * Attach ranked candidates to every element record.
 * @param {object[]} elements
 * @returns {object[]}
 */
export function rankElements(elements) {
  return elements.map((element) => {
    const candidates = buildLocatorCandidates(element);
    return {
      ...element,
      candidates,
      recommended: candidates[0] ?? null,
      ambiguous: candidates.length === 0,
    };
  });
}

/**
 * Produce a compact, agent-friendly summary of the page.
 * @param {{elements: object[], assertTargets?: object[], meta: object}} input
 * @returns {string} Markdown
 */
export function renderOutlineMarkdown({ elements, assertTargets = [], meta }) {
  // Generated locators routinely contain a pipe (a name like `a|b`), which would
  // otherwise split the table row. Escape every cell.
  const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  const row = (element) => {
    const label = tidy(element.text || element.name || element.placeholder || element.tag, 30) || element.tag;
    const recommended = element.recommended;
    const code = recommended === null ? '（无可语义定位器）' : `page.${recommended.code}`;
    const stability = recommended === null ? '-' : String(recommended.stability);
    const note = [recommended?.note, element.disabled ? '元素处于 disabled 状态' : ''].filter(Boolean).join('；');
    return `| \`${escapeCell(label)}\` | \`${escapeCell(code)}\` | ${escapeCell(stability)} | ${escapeCell(note)} |`;
  };

  const lines = [];
  lines.push(`# 页面结构快照`);
  lines.push('');
  lines.push(`- URL: ${meta.url}`);
  lines.push(`- 标题: ${meta.title || '(空)'}`);
  lines.push(`- 视口: ${meta.viewport?.width}×${meta.viewport?.height}`);
  lines.push(`- 可操作元素: ${elements.length}`);
  lines.push(`- 断言目标: ${assertTargets.length}`);
  lines.push('');
  lines.push('## 可操作元素（点击 / 输入）');
  lines.push('');
  lines.push('| 元素 | 推荐定位器 | 稳定性 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const element of elements) lines.push(row(element));
  lines.push('');

  if (assertTargets.length > 0) {
    lines.push('## 断言目标（只读，用于 expect）');
    lines.push('');
    lines.push('这些元素不可点击，但带有 `data-testid` 或是标题，适合用来断言状态与文案。');
    lines.push('');
    lines.push('| 元素 | 推荐定位器 | 稳定性 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    for (const element of assertTargets) lines.push(row(element));
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
