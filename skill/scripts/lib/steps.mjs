/**
 * The step vocabulary shared by exploration steps (`explore.mjs --steps`) and
 * generated login flows (`auth.steps`).
 *
 * One list, one implementation of locator resolution, so the documentation can
 * never promise an action the scripts reject — the mismatch that made
 * `{"action": "screenshot"}` fail while the manual said it worked.
 */

/** Every action both the explorer and the generated login setup can perform. */
export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'press',
  'selectOption',
  'check',
  'uncheck',
  'hover',
  'waitFor',
  'waitForLoadState',
  'waitForTimeout',
  'screenshot',
];

/** Actions that need a `locator`. */
export const LOCATOR_ACTIONS = new Set([
  'click',
  'fill',
  'press',
  'selectOption',
  'check',
  'uncheck',
  'hover',
  'waitFor',
]);

/** Human-readable list used in error messages and docs. */
export function describeStepActions() {
  return STEP_ACTIONS.join('/');
}

/**
 * Validate a step's shape, without executing it.
 * @param {unknown} step
 * @param {number} index
 * @returns {string|null} a problem description, or null when the step is usable
 */
export function validateStep(step, index = 0) {
  const where = `第 ${index + 1} 个步骤`;
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    return `${where}不是对象。`;
  }
  const record = /** @type {Record<string, unknown>} */ (step);
  const action = String(record.action ?? '');
  if (action === '') return `${where}缺少 action 字段。`;
  if (!STEP_ACTIONS.includes(action)) {
    return `${where}的动作 "${action}" 不受支持。可用动作：${describeStepActions()}。`;
  }
  if (LOCATOR_ACTIONS.has(action) && record.locator === undefined) {
    return `${where}（${action}）缺少 locator 字段。`;
  }
  return null;
}

/**
 * Build the JS expression for a locator spec.
 *
 * @param {string|object} spec either a raw `page.`-relative expression, or a
 *   structured `{by, value|role|name}` object
 * @returns {string} an expression that evaluates against `page`
 */
export function locatorToCode(spec) {
  if (typeof spec === 'string') {
    // Both `"getByRole('button')"` and a full `"page.getByRole('button')"`
    // expression are accepted, so a caller can paste either form.
    const trimmed = spec.trim();
    return /^page[\s.[]/.test(trimmed) ? trimmed : `page.${trimmed}`;
  }
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`locator 必须是字符串表达式或结构化对象，收到：${JSON.stringify(spec)}。`);
  }
  const record = /** @type {Record<string, any>} */ (spec);
  const value = record.value ?? record.name ?? '';
  const quote = (input) => JSON.stringify(String(input));

  switch (record.by) {
    case 'testId':
      return `page.getByTestId(${quote(value)})`;
    case 'role':
      return record.name === undefined
        ? `page.getByRole(${quote(record.role)})`
        : `page.getByRole(${quote(record.role)}, { name: ${quote(record.name)} })`;
    case 'label':
      return `page.getByLabel(${quote(value)})`;
    case 'placeholder':
      return `page.getByPlaceholder(${quote(value)})`;
    case 'text':
      return `page.getByText(${quote(value)})`;
    case 'title':
      return `page.getByTitle(${quote(value)})`;
    case 'alt':
      return `page.getByAltText(${quote(value)})`;
    case 'css':
      return `page.locator(${quote(value)})`;
    default:
      throw new Error(
        `无法识别的定位方式：${JSON.stringify(spec)}。可用 by：testId/role/label/placeholder/text/title/alt/css。`,
      );
  }
}

/**
 * Turn a locator spec into a live Playwright locator.
 *
 * @param {any} page
 * @param {string|object} spec
 * @returns {any} locator
 */
export function resolveLocator(page, spec) {
  // Generated code and live execution share one mapping, so a locator that works
  // during exploration cannot compile into something different in a spec.
  // Steps files are local, agent-authored content; never accept one from an
  // untrusted source.
  return new Function('page', `return ${locatorToCode(spec)};`)(page);
}
