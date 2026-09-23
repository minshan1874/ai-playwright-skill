#!/usr/bin/env node
/**
 * Exploration phase: drive a real browser to the target page, then dump
 * everything the agent needs to author resilient specs.
 *
 * Produces, under `--out`:
 *   meta.json          page identity, viewport, timings
 *   page.png           full-page screenshot
 *   aria.yml           Playwright aria snapshot (semantic tree)
 *   dom-outline.json   interactive elements + ranked locator candidates
 *   outline.md         agent-friendly Markdown view of the same
 *   console.json       console messages and page errors
 *   network.json       failed requests and 4xx/5xx responses
 *   summary.json       machine-readable result
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildConfig, effectiveBaseURL } from './lib/config.mjs';
import { diagnoseLaunchFailure, relevantExcerpt } from './lib/browser-errors.mjs';
import { loadPlaywright } from './lib/deps.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import { rankElements, renderOutlineMarkdown } from './lib/locators.mjs';
import { probeWritable, resolveHome } from './lib/paths.mjs';
import { describeStepActions, resolveLocator, STEP_ACTIONS } from './lib/steps.mjs';

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'explore' });

/**
 * Execute the optional pre-capture step list.
 * @param {any} page
 * @param {object[]} steps
 * @param {string} screenshotsDir
 * @returns {Promise<{index: number, action: string, ok: boolean, error?: string}[]>}
 */
async function runSteps(page, steps, screenshotsDir) {
  const log = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const action = String(step.action ?? '');
    try {
      switch (action) {
        case 'goto':
          await page.goto(new URL(String(step.url), page.url()).href, { waitUntil: 'domcontentloaded' });
          break;
        case 'click':
          await resolveLocator(page, step.locator).click();
          break;
        case 'fill':
          await resolveLocator(page, step.locator).fill(String(step.value ?? ''));
          break;
        case 'press':
          await resolveLocator(page, step.locator).press(String(step.key ?? 'Enter'));
          break;
        case 'selectOption':
          await resolveLocator(page, step.locator).selectOption(String(step.value ?? ''));
          break;
        case 'check':
          await resolveLocator(page, step.locator).check();
          break;
        case 'uncheck':
          await resolveLocator(page, step.locator).uncheck();
          break;
        case 'hover':
          await resolveLocator(page, step.locator).hover();
          break;
        case 'waitFor':
          await resolveLocator(page, step.locator).waitFor({ state: step.state ?? 'visible' });
          break;
        case 'waitForTimeout':
          await page.waitForTimeout(Number(step.ms ?? 500));
          break;
        case 'waitForLoadState':
          await page.waitForLoadState(step.state ?? 'networkidle');
          break;
        case 'screenshot':
          // Standalone capture. `{"action": "screenshot", "name": "after-login"}`
          // was documented long before it was implemented; both spellings now work.
          await page.screenshot({
            path: path.join(screenshotsDir, `${String(step.name ?? `step-${index + 1}`)}.png`),
            fullPage: step.fullPage !== false,
          });
          break;
        default:
          throw new Error(
            `不支持的步骤动作 "${action}"。支持的动作：${describeStepActions()}（共 ${STEP_ACTIONS.length} 个）。`,
          );
      }

      if (step.screenshot && action !== 'screenshot') {
        const name = String(step.name ?? `step-${index + 1}`);
        await page.screenshot({ path: path.join(screenshotsDir, `${name}.png`), fullPage: true });
      }
      log.push({ index, action, ok: true });
      reporter.note(`  步骤 ${index + 1} ${action} ✅`);
    } catch (error) {
      log.push({ index, action, ok: false, error: error?.message ?? String(error) });
      reporter.note(`  步骤 ${index + 1} ${action} ❌ ${error?.message ?? error}`);
      // Stop at the first failure: later steps would produce misleading output.
      break;
    }
  }
  return log;
}

async function main() {
  const outDir = typeof flags.out === 'string' ? flags.out : null;
  if (outDir === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --out 参数',
        hint: '用法：node explore.mjs --url <网址> --out <探索输出目录> [--steps steps.json] [--config e2e.config.json]',
      }),
    );
  }

  const { config, warnings, problems, configDir } = buildConfig({ flags });
  if (problems.length > 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `配置有问题：${problems.join(' ')}`,
        hint: '请修正 --url 或配置文件后重试。',
      }),
    );
  }
  for (const warning of warnings) reporter.note(`⚠️  ${warning}`);

  const home = resolveHome(process.env);
  const baseURL = effectiveBaseURL(config);
  const browserName = (typeof flags.browser === 'string' ? flags.browser : config.browsers[0]) ?? 'chromium';

  // Fail early with actionable advice rather than a Playwright stack trace.
  const probe = probeWritable(path.dirname(path.resolve(outDir)));
  if (!probe.ok) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `无法写入探索输出目录（${probe.code}）`,
        hint:
          `目录 ${path.dirname(path.resolve(outDir))} 不可写。` +
          '若这是 agent 沙箱限制，请批准提权，或把输出目录换到可写位置。',
      }),
    );
  }

  const absoluteOut = path.resolve(outDir);
  const screenshotsDir = path.join(absoluteOut, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const { chromium, firefox, webkit } = await loadPlaywright({ home });
  const browserTypes = { chromium, firefox, webkit };
  const browserType = browserTypes[browserName];
  if (browserType === undefined) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `不支持的浏览器 "${browserName}"`,
        hint: '可选：chromium、firefox、webkit。',
      }),
    );
  }

  // A storageState may come from the flag or from the config. Either way a
  // relative path means "relative to the config file", which is where the agent
  // wrote it — not the directory this script happened to be invoked from.
  const storageState = typeof flags['storage-state'] === 'string'
    ? path.resolve(flags['storage-state'])
    : String(config.auth.storageState ?? '').trim() !== ''
      ? path.resolve(configDir, String(config.auth.storageState).trim())
      : null;

  if (storageState !== null && !fs.existsSync(storageState)) {
    reporter.note(`⚠️  指定的登录态文件不存在，将忽略：${storageState}`);
  }
  const usableStorageState = storageState !== null && fs.existsSync(storageState) ? storageState : undefined;

  reporter.note(`正在用 ${browserName} 探索 ${baseURL} …`);

  let browser;
  try {
    browser = await browserType.launch({ headless: config.headless, slowMo: config.slowMo });
  } catch (error) {
    // A raw Playwright dump is hard to act on; classify it so the agent gets a
    // precise instruction instead of guessing that --headless will help.
    const diagnosis = diagnoseLaunchFailure(`${error?.message ?? ''}\n${error?.stack ?? ''}`);
    reporter.note(`❌ 浏览器启动失败（${diagnosis.kind}）：${diagnosis.cause}`);
    process.exit(
      reporter.finish({
        ok: false,
        error: `浏览器启动失败：${diagnosis.cause}`,
        hint: diagnosis.action,
        failureKind: diagnosis.kind,
        canRetryHeadless: diagnosis.canRetryHeadless,
        launchMode: config.headless ? 'headless' : 'headed',
        excerpt: relevantExcerpt(`${error?.message ?? ''}\n${error?.stack ?? ''}`),
      }),
    );
  }

  const context = await browser.newContext({
    viewport: config.viewport,
    locale: config.locale,
    timezoneId: config.timezoneId,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors,
    ...(usableStorageState ? { storageState: usableStorageState } : {}),
  });

  const page = await context.newPage();

  /** @type {object[]} */
  const consoleMessages = [];
  /** @type {object[]} */
  const pageErrors = [];
  /** @type {object[]} */
  const failedRequests = [];
  /** @type {object[]} */
  const badResponses = [];

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push({ message: error.message, stack: String(error.stack ?? '').split('\n').slice(0, 5).join('\n') });
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText ?? 'unknown',
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
    }
  });

  const startedAt = Date.now();
  let navigationError = null;
  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    // SPAs keep sockets open, so networkidle is best-effort.
    await page.waitForLoadState('networkidle', { timeout: Math.min(config.timeout, 8000) }).catch(() => {});
  } catch (error) {
    navigationError = error?.message ?? String(error);
  }

  let stepsLog = [];
  if (navigationError === null) {
    const stepsFile = typeof flags.steps === 'string' ? path.resolve(flags.steps) : null;
    if (stepsFile !== null) {
      if (!fs.existsSync(stepsFile)) {
        process.exit(
          reporter.finish({ ok: false, error: `找不到步骤文件：${stepsFile}`, hint: '请检查 --steps 路径。' }),
        );
      }
      let steps;
      try {
        steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
      } catch (error) {
        process.exit(
          reporter.finish({ ok: false, error: `步骤文件不是合法 JSON：${error.message}`, hint: '请检查 steps.json 格式。' }),
        );
      }
      if (!Array.isArray(steps)) {
        process.exit(reporter.finish({ ok: false, error: '步骤文件的顶层必须是数组。' }));
      }
      reporter.note(`执行 ${steps.length} 个探索步骤 …`);
      stepsLog = await runSteps(page, steps, screenshotsDir);
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (navigationError !== null) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(
      reporter.finish({
        ok: false,
        error: `无法访问 ${baseURL}：${navigationError}`,
        hint:
          '请确认网址可访问、网络/代理正常、证书可信。' +
          '若页面需要登录，请先在配置里启用 auth，或提供 --storage-state。' +
          '这类失败属于环境问题，请回到计划阶段与用户确认后再执行。',
        console: consoleMessages,
        failedRequests,
      }),
    );
  }

  // --- Capture --------------------------------------------------------------
  const meta = {
    url: baseURL,
    finalUrl: page.url(),
    title: await page.title(),
    viewport: config.viewport,
    locale: config.locale,
    timezoneId: config.timezoneId,
    browser: browserName,
    headless: config.headless,
    // Recording whether the capture was authenticated saves the agent from
    // guessing why a page looks like a login screen.
    storageState: usableStorageState ?? null,
    capturedAt: new Date().toISOString(),
    elapsedMs,
  };

  await page.screenshot({ path: path.join(absoluteOut, 'page.png'), fullPage: true });

  let ariaSnapshot = '';
  try {
    ariaSnapshot = await page.locator('body').ariaSnapshot();
  } catch (error) {
    ariaSnapshot = `# ariaSnapshot 失败：${error?.message ?? error}\n`;
  }
  fs.writeFileSync(path.join(absoluteOut, 'aria.yml'), `${ariaSnapshot}\n`);

  const rawElements = await page.evaluate(COLLECT_ELEMENTS_SCRIPT);
  // Controls the agent can operate, versus elements it can only assert on.
  const elements = rankElements(rawElements.filter((record) => record.interactive));
  const assertTargets = rankElements(
    rawElements.filter(
      (record) =>
        !record.interactive &&
        !record.hasTestIdDescendant &&
        (record.testId !== '' || /^h[1-6]$/.test(record.tag)),
    ),
  );

  const outline = {
    meta,
    elements,
    assertTargets,
    counts: {
      total: elements.length,
      assertTargets: assertTargets.length,
      ambiguous: elements.filter((element) => element.ambiguous).length,
      dynamicText: elements.filter((element) => element.dynamicText).length,
    },
  };
  fs.writeFileSync(path.join(absoluteOut, 'dom-outline.json'), `${JSON.stringify(outline, null, 2)}\n`);
  fs.writeFileSync(path.join(absoluteOut, 'outline.md'), renderOutlineMarkdown({ elements, assertTargets, meta }));

  fs.writeFileSync(path.join(absoluteOut, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(
    path.join(absoluteOut, 'console.json'),
    `${JSON.stringify({ messages: consoleMessages, pageErrors }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(absoluteOut, 'network.json'),
    `${JSON.stringify({ failedRequests, badResponses }, null, 2)}\n`,
  );

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const summary = {
    ok: true,
    out: absoluteOut,
    meta,
    files: {
      screenshot: path.join(absoluteOut, 'page.png'),
      aria: path.join(absoluteOut, 'aria.yml'),
      outline: path.join(absoluteOut, 'outline.md'),
      domOutline: path.join(absoluteOut, 'dom-outline.json'),
      console: path.join(absoluteOut, 'console.json'),
      network: path.join(absoluteOut, 'network.json'),
    },
    counts: outline.counts,
    steps: stepsLog,
    console: { messages: consoleMessages.length, pageErrors: pageErrors.length },
    network: { failedRequests: failedRequests.length, badResponses: badResponses.length },
    hints: [
      consoleMessages.length > 0 ? '页面有控制台错误，写用例前先确认这是不是环境/数据问题。' : '',
      pageErrors.length > 0 ? '页面抛出了 JS 异常，相关功能可能不可用。' : '',
      outline.counts.ambiguous > 0
        ? `${outline.counts.ambiguous} 个元素没有语义定位器，需要为它们补 data-testid，或使用文本/层级定位。`
        : '',
      outline.counts.dynamicText > 0
        ? `${outline.counts.dynamicText} 个元素的文案会随数据变化（积分/计数/日期），` +
          '请用 outline.md 里的正则候选定位器，不要直接用字面文案。'
        : '',
    ].filter(Boolean),
  };
  fs.writeFileSync(path.join(absoluteOut, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  reporter.note(
    `✅ 探索完成：${elements.length} 个可操作元素、${assertTargets.length} 个断言目标，截图与快照已写入 ${absoluteOut}。`,
  );
  if (summary.hints.length > 0) {
    for (const hint of summary.hints) reporter.note(`   ⚠️  ${hint}`);
  }

  process.exit(reporter.finish(summary));
}

/**
 * Injected into the page. Must be self-contained: it runs in the browser.
 * @returns {object[]}
 */
function COLLECT_ELEMENTS_SCRIPT() {
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role]',
    '[onclick]',
    '[contenteditable="true"]',
    ...TEST_ID_ATTRS.map((attribute) => `[${attribute}]`),
  ].join(',');

  const IMPLICIT_ROLES = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
  };
  const INPUT_ROLES = {
    text: 'textbox',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    url: 'textbox',
    password: 'textbox',
    number: 'spinbutton',
    range: 'slider',
    checkbox: 'checkbox',
    radio: 'radio',
    submit: 'button',
    button: 'button',
    reset: 'button',
    image: 'button',
    file: 'button',
  };

  const text = (node) => (node ? String(node.textContent ?? '').replace(/\s+/g, ' ').trim() : '');

  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const accessibleName = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (element.id) {
        const escaped = window.CSS && CSS.escape ? CSS.escape(element.id) : element.id;
        const explicit = document.querySelector(`label[for="${escaped}"]`);
        if (explicit) return text(explicit);
      }
      const wrapping = element.closest('label');
      if (wrapping) return text(wrapping);
    }
    if (tag === 'img') return element.getAttribute('alt') ?? '';
    const title = element.getAttribute('title');
    if (title) return title.trim();
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    const value = element.getAttribute('value');
    if (value && (tag === 'input' || tag === 'button')) return value.trim();
    return text(element);
  };

  const labelText = (element) => {
    const tag = element.tagName.toLowerCase();
    if (!['input', 'select', 'textarea'].includes(tag)) return '';
    if (element.id) {
      const escaped = window.CSS && CSS.escape ? CSS.escape(element.id) : element.id;
      const explicit = document.querySelector(`label[for="${escaped}"]`);
      if (explicit) return text(explicit);
    }
    const wrapping = element.closest('label');
    if (wrapping) return text(wrapping);
    return '';
  };

  const role = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.trim();
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') return INPUT_ROLES[element.getAttribute('type') ?? 'text'] ?? 'textbox';
    return IMPLICIT_ROLES[tag] ?? '';
  };

  const cssPath = (element) => {
    const escape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
    if (element.id && document.querySelectorAll(`#${escape(element.id)}`).length === 1) {
      return `#${escape(element.id)}`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id && document.querySelectorAll(`#${escape(node.id)}`).length === 1) {
        parts.unshift(`#${escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const records = [];
  for (const element of document.querySelectorAll(SELECTOR)) {
    const testIdAttr = TEST_ID_ATTRS.find((attribute) => element.getAttribute(attribute));
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const explicitRole = (element.getAttribute('role') ?? '').trim();
    // A `<div data-testid="app">` wrapper is not something a test should click.
    // Only keep elements that are genuinely operable.
    const interactive =
      ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag) ||
      explicitRole !== '' ||
      element.hasAttribute('onclick') ||
      element.getAttribute('contenteditable') === 'true';

    // A test id on a wrapper that contains other test ids marks a container, not
    // an assertion target; its text is the whole page and its value is noise.
    const testIdSelector = TEST_ID_ATTRS.map((attribute) => `[${attribute}]`).join(',');

    records.push({
      tag,
      type: element.getAttribute('type') ?? '',
      role: role(element),
      explicitRole,
      interactive,
      hasTestIdDescendant: element.querySelector(testIdSelector) !== null,
      name: accessibleName(element),
      labelText: labelText(element),
      placeholder: element.getAttribute('placeholder') ?? '',
      title: element.getAttribute('title') ?? '',
      alt: element.getAttribute('alt') ?? '',
      text: text(element).slice(0, 120),
      testId: testIdAttr ? element.getAttribute(testIdAttr) : '',
      testIdAttr: testIdAttr ?? '',
      id: element.id ?? '',
      nameAttr: element.getAttribute('name') ?? '',
      href: element.getAttribute('href') ?? '',
      value: element.getAttribute('value') ?? '',
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      visible: visible(element),
      cssPath: cssPath(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  }

  // Keep every visible element; the caller separates operable controls from
  // assertion targets such as a `<strong data-testid="cart-count">`.
  return records.filter((record) => record.visible);
}

main().catch((error) => {
  process.exit(
    reporter.finish({
      ok: false,
      error: error?.message ?? String(error),
      hint: '探索失败。若提示依赖未安装，请先运行 bootstrap.mjs。',
    }),
  );
});
