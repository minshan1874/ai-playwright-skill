/**
 * Launch-failure diagnostics.
 *
 * The macOS signatures below are verbatim excerpts from a real Codex run where
 * headed Chromium could not start. Getting this wrong costs a wasted round trip:
 * the old guidance said "retry with --headless", which cannot work when the
 * sandbox blocks the Mach IPC that *both* modes rely on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAUNCH_FAILURE,
  diagnoseLaunchFailure,
  relevantExcerpt,
} from '../skill/scripts/lib/browser-errors.mjs';

/** Verbatim from the 2026-09-19 Codex session (PIDs trimmed). */
const REAL_MACH_FAILURE = `
<launched> pid=61151
[pid=61151][err] [0919/232416.773856:ERROR:third_party/crashpad/crashpad/util/mach/bootstrap.cc:65] bootstrap_check_in org.chromium.crashpad.child_port_handshake.61155.15847147.GSJGXUHOYVUNPSNS: Permission denied (1100)
[pid=61151][err] [0919/232417.048867:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:208] open /Users/f/Library/Application Support/Google/Chrome for Testing/Crashpad/settings.dat: Operation not permitted (1)
[pid=61151][err] Received signal 6
`;

/** Headless hits the same wall via a different component. */
const REAL_MACH_FAILURE_HEADLESS = `
[pid=61174][err] [0919/232422.330059:FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.61174: Permission denied (1100)
`;

describe('macOS sandbox (Mach) failures', () => {
  it('recognises the headed crashpad failure', () => {
    const diagnosis = diagnoseLaunchFailure(REAL_MACH_FAILURE);
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.sandboxMach);
    assert.match(diagnosis.cause, /沙箱|Mach/);
  });

  it('recognises the headless MachPortRendezvous failure', () => {
    const diagnosis = diagnoseLaunchFailure(REAL_MACH_FAILURE_HEADLESS);
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.sandboxMach);
  });

  it('must NOT recommend retrying headless — that cannot work here', () => {
    // Both modes use the same Mach IPC, so the old blanket advice wasted a round.
    for (const text of [REAL_MACH_FAILURE, REAL_MACH_FAILURE_HEADLESS]) {
      const diagnosis = diagnoseLaunchFailure(text);
      assert.equal(diagnosis.canRetryHeadless, false);
      assert.match(diagnosis.action, /不要.*--headless|不会成功|申请.*权限/);
    }
  });

  it('says the browser must be allowed to launch at all', () => {
    const diagnosis = diagnoseLaunchFailure(REAL_MACH_FAILURE);
    assert.match(diagnosis.action, /权限|提权|普通终端/);
  });
});

describe('no-display failures', () => {
  it('recognises a missing X server', () => {
    const diagnosis = diagnoseLaunchFailure(
      'browserType.launch: Target page, context or browser has been closed\nMissing X server or $DISPLAY',
    );
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.noDisplay);
  });

  it('DOES recommend headless here, because it genuinely helps', () => {
    const diagnosis = diagnoseLaunchFailure('Error: cannot open display :0');
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.noDisplay);
    assert.equal(diagnosis.canRetryHeadless, true);
    assert.match(diagnosis.action, /--headless/);
  });
});

describe('missing browser binaries', () => {
  it('points at bootstrap --install-browsers', () => {
    const diagnosis = diagnoseLaunchFailure(
      "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app",
    );
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.missingBrowser);
    assert.match(diagnosis.action, /--install-browsers/);
    assert.equal(diagnosis.canRetryHeadless, false);
  });
});

describe('classification order and fallbacks', () => {
  it('prefers missing-browser over a generic Mach mention', () => {
    const mixed = "Executable doesn't exist\nbootstrap_check_in failed";
    assert.equal(diagnoseLaunchFailure(mixed).kind, LAUNCH_FAILURE.missingBrowser);
  });

  it('prefers sandbox-mach over no-display when both appear', () => {
    // A crashpad denial is the real cause; a stray DISPLAY mention is noise.
    const mixed = 'bootstrap_check_in: Permission denied (1100)\nDISPLAY not set';
    assert.equal(diagnoseLaunchFailure(mixed).kind, LAUNCH_FAILURE.sandboxMach);
  });

  it('falls back to unknown, and still refuses to promise headless', () => {
    const diagnosis = diagnoseLaunchFailure('some entirely new error');
    assert.equal(diagnosis.kind, LAUNCH_FAILURE.unknown);
    assert.equal(diagnosis.canRetryHeadless, false);
    assert.ok(diagnosis.action.length > 0);
  });

  it('handles empty input', () => {
    for (const value of ['', null, undefined]) {
      assert.equal(diagnoseLaunchFailure(value).kind, LAUNCH_FAILURE.unknown);
    }
  });
});

describe('output excerpt', () => {
  it('keeps the trailing lines, where the real cause lives', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const excerpt = relevantExcerpt(text, 3);
    assert.equal(excerpt, 'line 37\nline 38\nline 39');
  });

  it('drops blank lines and tolerates null', () => {
    assert.equal(relevantExcerpt('a\n\n\nb'), 'a\nb');
    assert.equal(relevantExcerpt(null), '');
  });
});
