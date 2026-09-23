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
  // A regex over the stable part of a dynamic name outranks the literal name:
  // "积分 1200" becomes "积分 1300" and the literal locator dies with it.
  roleRegex: 92,
  roleFragment: 91,
  role: 90,
  label: 85,
  placeholder: 80,
  textRegex: 72,
  text: 70,
  title: 60,
  css: 20,
};

/** Attributes treated as a test id, in preference order. */
export const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

/**
 * Text shapes that change on their own: counters, balances, dates, ratios.
 *
 * The distinction matters because a locator built from a changing string passes
 * today and fails tomorrow for reasons that have nothing to do with the product.
 * Deliberately narrow: `GPT-4o` and `Step 1` contain digits but are stable names,
 * so a bare digit is not enough — it needs a quantity/date/time context.
 */
export const DYNAMIC_PATTERNS = [
  /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/, // dates
  /\d{1,2}\s*[:：]\s*\d{2}(?:\s*[:：]\s*\d{2})?/, // times
  /[¥￥$€]\s*\d/, // currency
  /\d+(?:\.\d+)?\s*(?:%|积分|点数?|余额|credits?|points?|coins?|元|次|条|张|个|页|秒|分钟|小时|items?|left)/i, // "1200 积分"
  /(?:积分|余额|点数|金币|credits?|points?|coins?|count|total)\s*[:：]?\s*\d/i, // "积分 1200"
  /\d+\s*[/]\s*\d+/, // ratios such as 3/10
  /^\s*[-+]?\d[\d,.\s]*\s*$/, // a bare number
  /\b[0-9a-f]{8,}\b/i, // ids and hashes
];

/**
 * Does this text look like it will change between runs?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDynamicText(value) {
  const text = String(value ?? '').trim();
  if (text === '') return false;
  return DYNAMIC_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Escape a string for use inside a RegExp *literal*.
 *
 * The generated locators are regex literals (`name: /积分\d+/`), so the delimiter
 * must be escaped too — an unescaped `/` from a text like `3/10` would terminate
 * the literal and produce a spec that does not compile.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Generalise the volatile parts of a text into a regex source.
 *
 * `余额 100 积分` -> `余额\s+\d+\s+积分`, so the locator survives the number
 * changing. Returns '' when nothing but digits remains — there is no stable
 * pattern to match on.
 *
 * @param {unknown} value
 * @returns {string} regex source, or ''
 */
export function dynamicRegexSource(value) {
  const source = escapeRegex(String(value ?? '').replace(/\s+/g, ' ').trim())
    .replace(/\d+/g, '\\d+')
    // "1 200" arrives as two digit runs; collapse them into one pattern.
    .replace(/\\d\+(?:\s+\\d\+)+/g, '\\d+')
    .replace(/\s+/g, '\\s+');
  const withoutDigits = source.replace(/\\d\+/g, '').replace(/\\s\+/g, '');
  return withoutDigits.length > 0 ? source : '';
}

/**
 * The stable words of a dynamic text, for a loose fallback match.
 *
 * `余额 100 积分` -> `余额\s*积分`, so a reworded counter still matches even when
 * the digit pattern does not.
 *
 * @param {unknown} value
 * @returns {string} regex source, or '' when too little text remains
 */
export function stableFragmentSource(value) {
  const withoutNumbers = String(value ?? '')
    .replace(/\d+(?:\.\d+)?/g, ' ')
    .replace(/[¥￥$€%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-–—:：,，.。·|/]+|[\s\-–:：,，.。·|/]+$/g, '');
  if (withoutNumbers.length < 2) return '';
  return escapeRegex(withoutNumbers).replace(/\s+/g, '\\s*');
}

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

  const nameIsDynamic = isDynamicText(name);
  const textIsDynamic = isDynamicText(text);

  // Dynamic text gets regex candidates *above* the literal one: the literal
  // matches only today's counter value.
  if (role !== '' && name !== '' && nameIsDynamic) {
    const generalized = dynamicRegexSource(name);
    if (generalized !== '') {
      push('role', `getByRole(${quote(role)}, { name: /${generalized}/ })`, STABILITY.roleRegex, '动态文本：数字会变化，已用 \\d+ 通配');
    }
    const fragment = stableFragmentSource(name);
    if (fragment !== '' && fragment !== generalized) {
      push('role', `getByRole(${quote(role)}, { name: /${fragment}/ })`, STABILITY.roleFragment, '动态文本：只匹配稳定词，改名后仍可用');
    }
  }

  if (role !== '' && name !== '') {
    push(
      'role',
      `getByRole(${quote(role)}, { name: ${quote(name)} })`,
      STABILITY.role,
      nameIsDynamic ? '动态文本：当前文案的数字/日期会变化，直接匹配可能随时失效' : undefined,
    );
  }

  if (label !== '') push('label', `getByLabel(${quote(label)})`, STABILITY.label);
  if (placeholder !== '') push('placeholder', `getByPlaceholder(${quote(placeholder)})`, STABILITY.placeholder);

  const isClickable = ['a', 'button', 'summary'].includes(String(element.tag).toLowerCase()) ||
    ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(role);
  if (isClickable && text !== '' && text.length <= 60) {
    if (textIsDynamic) {
      const generalized = dynamicRegexSource(text);
      if (generalized !== '') {
        push('text', `getByText(/${generalized}/)`, STABILITY.textRegex, '动态文本：数字会变化，已用 \\d+ 通配');
      }
    }
    push('text', `getByText(${quote(text)})`, STABILITY.text, textIsDynamic ? '动态文本：文案会变化' : undefined);
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
    const visibleText = tidy(element.name || element.text, 80);
    return {
      ...element,
      candidates,
      recommended: candidates[0] ?? null,
      // Two fallbacks, so a spec author whose first choice breaks has a next step
      // instead of reaching for a CSS path.
      alternatives: candidates.slice(1, 3),
      dynamicText: isDynamicText(visibleText),
      ambiguous: candidates.length === 0,
    };
  });
}

/**
 * Elements that make good "login succeeded" signals.
 *
 * A post-login element (account menu, plan/Upgrade badge, model configuration) is
 * a far more stable success check than a URL: redirect chains, onboarding
 * interstitials and A/B landing pages all move the URL around.
 *
 * @param {object[]} elements ranked element records
 * @param {number} [limit]
 * @returns {object[]}
 */
export function suggestSuccessSignals(elements, limit = 10) {
  const positive = /upgrade|升级|会员|订阅|账户|账号|个人中心|profile|avatar|logout|sign\s*out|退出|设置|settings|模型|model|余额|积分|credits?|points?/i;
  const negative = /登录|登陆|注册|sign\s*in|log\s*in|password|密码|忘记密码/i;
  // A labelled input on the login form ("账号") matches the words above but is
  // the opposite of a post-login signal.
  const formRoles = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton']);
  return elements
    .filter((element) => {
      const text = `${element.name ?? ''} ${element.text ?? ''}`;
      if (!positive.test(text) || negative.test(text)) return false;
      if (formRoles.has(String(element.role ?? ''))) return false;
      if (['input', 'select', 'textarea'].includes(String(element.tag ?? '').toLowerCase())) return false;
      return element.recommended !== null;
    })
    .slice(0, limit);
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

  const textKind = (element) => {
    const value = element.name || element.text;
    if (String(value ?? '').trim() === '') return '—';
    return element.dynamicText ? '⚠️ 动态文本' : '✅ 稳定文本';
  };

  const row = (element) => {
    const label = tidy(element.text || element.name || element.placeholder || element.tag, 30) || element.tag;
    const recommended = element.recommended;
    const code = recommended === null ? '（无可语义定位器）' : `page.${recommended.code}`;
    const stability = recommended === null ? '-' : String(recommended.stability);
    const alternatives = (element.alternatives ?? [])
      .map((candidate) => `\`page.${candidate.code}\``)
      .join('<br>');
    const note = [recommended?.note, element.disabled ? '元素处于 disabled 状态' : ''].filter(Boolean).join('；');
    return `| \`${escapeCell(label)}\` | ${textKind(element)} | \`${escapeCell(code)}\` | ${escapeCell(stability)} | ${alternatives || '—'} | ${escapeCell(note)} |`;
  };

  const table = (list) => {
    const lines = [
      '| 元素 | 文本类型 | 推荐定位器 | 稳定性 | 备选定位器 | 说明 |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const element of list) lines.push(row(element));
    return lines;
  };

  const dynamicCount = elements.filter((element) => element.dynamicText).length;
  const lines = [];
  lines.push(`# 页面结构快照`);
  lines.push('');
  lines.push(`- URL: ${meta.url}`);
  lines.push(`- 标题: ${meta.title || '(空)'}`);
  lines.push(`- 视口: ${meta.viewport?.width}×${meta.viewport?.height}`);
  lines.push(`- 可操作元素: ${elements.length}`);
  lines.push(`- 断言目标: ${assertTargets.length}`);
  if (meta.storageState) lines.push(`- 登录态: ${meta.storageState}`);
  lines.push(`- 动态文本元素: ${dynamicCount}（这类元素的文案会随数据变化，优先用正则候选定位器）`);
  lines.push('');
  lines.push('## 可操作元素（点击 / 输入）');
  lines.push('');
  lines.push(...table(elements));
  lines.push('');

  if (assertTargets.length > 0) {
    lines.push('## 断言目标（只读，用于 expect）');
    lines.push('');
    lines.push('这些元素不可点击，但带有 `data-testid` 或是标题，适合用来断言状态与文案。');
    lines.push('');
    lines.push(...table(assertTargets));
    lines.push('');
  }

  const signals = suggestSuccessSignals([...elements, ...assertTargets]);
  if (signals.length > 0) {
    lines.push('## 登录成功信号候选（用于 auth.successSelector）');
    lines.push('');
    lines.push('登录后的稳定元素比 URL 更适合作为「登录成功」的判据：');
    lines.push('');
    lines.push('| 元素 | 推荐定位器 | 稳定性 |');
    lines.push('| --- | --- | --- |');
    for (const element of signals) {
      const label = tidy(element.name || element.text || element.tag, 30);
      lines.push(`| \`${escapeCell(label)}\` | \`page.${escapeCell(element.recommended.code)}\` | ${element.recommended.stability} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
