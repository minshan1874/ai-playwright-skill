/**
 * Diagnose browser-launch failures.
 *
 * Two failures look similar from a distance but need opposite responses:
 *
 *   - **No display** (Linux without X): headless works, so switching is the fix.
 *   - **Sandbox blocks Mach IPC** (macOS seatbelt): the browser cannot start in
 *     *either* mode, so switching to headless wastes a round trip — the fix is to
 *     let the browser launch at all.
 *
 * Telling them apart from a raw Playwright dump is hard, so this module does it.
 */

/** Failure kinds this module can recognise. */
export const LAUNCH_FAILURE = {
  sandboxMach: 'sandbox-mach',
  noDisplay: 'no-display',
  missingBrowser: 'missing-browser',
  unknown: 'unknown',
};

/** Signatures of a macOS sandbox denying Chromium its Mach ports. */
const SANDBOX_MACH_PATTERNS = [
  /bootstrap_check_in/i,
  /MachPortRendezvousServer/i,
  /crashpad[\s\S]{0,80}Permission denied/i,
  /Permission denied \(1100\)/,
  /mach_port_rendezvous/i,
];

/** Signatures of a missing display server. */
const NO_DISPLAY_PATTERNS = [
  /cannot open display/i,
  /Missing X server/i,
  /Xvfb/i,
  /no DISPLAY/i,
  /Failed to connect to the bus/i,
];

/** Signatures of a browser binary that was never downloaded. */
const MISSING_BROWSER_PATTERNS = [
  /Executable doesn't exist/i,
  /browserType\.launch:.*Executable/i,
  /please run the following command to download new browsers/i,
];

/**
 * Turn raw launch output into an actionable diagnosis.
 * @param {string} text stdout+stderr from the failed launch
 * @returns {{kind: string, cause: string, action: string, canRetryHeadless: boolean}}
 */
export function diagnoseLaunchFailure(text) {
  const haystack = String(text ?? '');

  if (MISSING_BROWSER_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      kind: LAUNCH_FAILURE.missingBrowser,
      cause: 'Playwright 找不到浏览器可执行文件。',
      action: '运行 bootstrap.mjs --install-browsers 下载浏览器后重试。',
      canRetryHeadless: false,
    };
  }

  if (SANDBOX_MACH_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      kind: LAUNCH_FAILURE.sandboxMach,
      cause:
        '当前沙箱不允许 Chromium 注册 Mach 端口（macOS 的 seatbelt 限制）。' +
        '有头和无头都用同一套多进程 IPC，所以两种模式都会失败。',
      action:
        '不要改成 --headless —— 那样不会成功。这一步需要让浏览器能真正启动：' +
        '向用户说明并申请更宽的执行权限，或让用户在有桌面会话的普通终端里跑。',
      canRetryHeadless: false,
    };
  }

  if (NO_DISPLAY_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      kind: LAUNCH_FAILURE.noDisplay,
      cause: '当前环境没有显示服务，有头浏览器无法启动。',
      action: '加 --headless 重试（这个场景下无头确实可用）。',
      canRetryHeadless: true,
    };
  }

  return {
    kind: LAUNCH_FAILURE.unknown,
    cause: '浏览器启动失败，但不匹配已知的故障特征。',
    action: '看完整输出定位；若怀疑是环境限制，向用户说明后再决定是否降级为 --headless。',
    canRetryHeadless: false,
  };
}

/**
 * Extract the most informative tail of a failed command's output.
 * @param {string} text
 * @param {number} [maxLines]
 * @returns {string}
 */
export function relevantExcerpt(text, maxLines = 15) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  return lines.slice(-maxLines).join('\n');
}
