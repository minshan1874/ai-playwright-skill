/**
 * Launch probing.
 *
 * `probeLaunch` cannot be unit-tested without a browser, but its classification
 * logic can: given a diagnosis from `browser-errors`, the probe's verdict about
 * whether the user must be consulted is the part that matters.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { diagnoseLaunchFailure, LAUNCH_FAILURE } from '../skill/scripts/lib/browser-errors.mjs';

const SKILL_DIR = path.join(process.cwd(), 'skill');
const BOOTSTRAP = path.join(SKILL_DIR, 'scripts', 'bootstrap.mjs');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

describe('bootstrap --probe-launch', () => {
  const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');

  it('is wired to a real launch, not just a config read', () => {
    assert.match(bootstrap, /--?probe-launch|probeLaunchFlag/, 'bootstrap 未实现 --probe-launch');
    assert.match(bootstrap, /probeBothModes/, 'bootstrap 未调用探测函数');
  });

  it('skips gracefully when dependencies are missing', () => {
    assert.match(bootstrap, /跳过浏览器启动探测/, '依赖缺失时应有明确的跳过提示');
  });

  it('exposes the verdict at the top level of its result', () => {
    assert.match(bootstrap, /^\s+launch,$/m, 'launch 未进入返回的 JSON');
  });

  it('probes both modes so the fallback can be judged', () => {
    const probe = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'lib', 'launch-probe.mjs'), 'utf8');
    assert.match(probe, /headless: false/);
    assert.match(probe, /headless: true/);
    assert.match(probe, /canShowWindow/, '缺少 canShowWindow 结论');
    assert.match(probe, /mustAskUser/, '缺少 mustAskUser 结论');
  });

  it('closes the browser it started', () => {
    const probe = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'lib', 'launch-probe.mjs'), 'utf8');
    assert.match(probe, /browser\.close\(\)/);
  });
});

describe('the mandated decision procedure', () => {
  const skill = fs.readFileSync(SKILL_MD, 'utf8');

  it('makes the probe mandatory, not optional', () => {
    assert.match(skill, /--check --probe-launch/, '阶段 0 必须包含 --probe-launch');
    assert.match(skill, /强制的、不可跳过|必须探测/, '必须写明探测不可跳过');
  });

  it('routes sandbox-mach to escalation, never to headless', () => {
    const section = skill.slice(skill.indexOf('弹不出窗口时的固定流程'));
    assert.ok(section.length > 0, '缺少「弹不出窗口时的固定流程」一节');
    const body = section.slice(0, section.indexOf('\n### ', 1));

    assert.match(body, /sandbox-mach/);
    assert.match(body, /不要改成 `--headless`/, '必须明确禁止换成无头');
    assert.match(body, /提权/, '必须要求申请更宽的执行权限');
    assert.match(body, /在有头模式下重新探测|有头模式/, '提权后必须以有头重试');
    assert.match(body, /停下来问用户|问用户/, '仍失败时必须让用户选择');
  });

  it('routes no-display to headless, but still with consent', () => {
    const section = skill.slice(skill.indexOf('弹不出窗口时的固定流程'));
    const tail = section.slice(section.indexOf("no-display"));
    assert.match(tail, /先告知用户/, '即使换无头可用也必须先告知用户');
  });

  it('tells the agent to record visibility in the plan', () => {
    const report = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'lib', 'report.mjs'), 'utf8');
    assert.match(report, /浏览器可见性.*必填/s, '计划骨架必须有可见性必填项');
  });

  it('never tells the agent to silently fall back', () => {
    // The old wording caused a wasted round trip; make sure it cannot return.
    assert.ok(
      !/显示服务 —— 加 `--headless` 重试，不要反复重跑/.test(skill),
      '旧的「无差别换无头」措辞又出现了',
    );
  });

  it('agrees with the classifier on which kinds allow a headless retry', () => {
    // The doc and the code must not drift apart on this point.
    assert.equal(diagnoseLaunchFailure('bootstrap_check_in: Permission denied (1100)').canRetryHeadless, false);
    assert.equal(diagnoseLaunchFailure('FATAL: MachPortRendezvousServer Permission denied').canRetryHeadless, false);
    assert.equal(diagnoseLaunchFailure('cannot open display').canRetryHeadless, true);
    assert.equal(diagnoseLaunchFailure('Missing X server').canRetryHeadless, true);
    assert.equal(LAUNCH_FAILURE.sandboxMach, 'sandbox-mach');
  });
});
