/**
 * Probe whether this environment can actually launch a browser.
 *
 * The only reliable way to know is to try: the macOS seatbelt denial happens at
 * process start, not at import time. Probing during the planning phase turns a
 * mid-execution surprise into a decision the user makes once, up front.
 */

import { diagnoseLaunchFailure, relevantExcerpt } from './browser-errors.mjs';
import { loadPlaywright } from './deps.mjs';

/** Browser names Playwright exposes on its main export. */
const BROWSER_TYPES = ['chromium', 'firefox', 'webkit'];

/**
 * Launch a browser and close it immediately.
 * @param {{home: string, browserName?: string, headless: boolean, slowMo?: number}} options
 * @returns {Promise<{ok: boolean, headless: boolean, kind?: string, cause?: string, action?: string, canRetryHeadless?: boolean, excerpt?: string, error?: string}>}
 */
export async function probeLaunch({ home, browserName = 'chromium', headless, slowMo = 0 }) {
  let api;
  try {
    api = await loadPlaywright({ home });
  } catch (error) {
    return {
      ok: false,
      headless,
      kind: 'missing-browser',
      cause: `无法加载 Playwright：${error?.message ?? error}`,
      action: '先运行 bootstrap.mjs 安装依赖。',
      canRetryHeadless: false,
    };
  }

  const type = api[browserName];
  if (type === undefined) {
    return {
      ok: false,
      headless,
      kind: 'unknown',
      cause: `不支持的浏览器 "${browserName}"。`,
      action: `可选：${BROWSER_TYPES.join(', ')}。`,
      canRetryHeadless: false,
    };
  }

  let browser;
  try {
    browser = await type.launch({ headless, slowMo });
  } catch (error) {
    const text = `${error?.message ?? ''}\n${error?.stack ?? ''}`;
    const diagnosis = diagnoseLaunchFailure(text);
    return {
      ok: false,
      headless,
      kind: diagnosis.kind,
      cause: diagnosis.cause,
      action: diagnosis.action,
      canRetryHeadless: diagnosis.canRetryHeadless,
      excerpt: relevantExcerpt(text, 8),
    };
  }

  try {
    await browser.close();
  } catch {
    // Closing is best effort; a failure here does not change the verdict.
  }
  return { ok: true, headless };
}

/**
 * Probe both visibility modes so the caller can decide with full information.
 * @param {{home: string, browserName?: string, slowMo?: number}} options
 * @returns {Promise<{headed: object, headless: object, canShowWindow: boolean, summary: string, mustAskUser: boolean}>}
 */
export async function probeBothModes({ home, browserName = 'chromium', slowMo = 0 }) {
  const headed = await probeLaunch({ home, browserName, headless: false, slowMo });
  const headless = await probeLaunch({ home, browserName, headless: true, slowMo });

  // The promise of this skill is that a tester can watch the run.
  const canShowWindow = headed.ok;
  const summary = canShowWindow
    ? '✅ 当前环境可以弹出浏览器窗口 —— 默认有头执行，测试人员能看到全过程。'
    : headless.ok
      ? `⚠️ 当前环境无法弹出窗口（${headed.kind}），但无头可以运行。` +
        '测试人员将看不到执行过程 —— 必须先告知用户并取得同意再降级。'
      : `❌ 当前环境无法启动浏览器（${headed.kind}），有头无头都失败。` +
        '这属于环境问题，不是用例失败；需要更宽的执行权限。';

  return {
    headed,
    headless,
    canShowWindow,
    summary,
    // Headed is the promise, so any environment that cannot deliver it needs a
    // conversation with the user before the run proceeds.
    mustAskUser: !canShowWindow,
  };
}
