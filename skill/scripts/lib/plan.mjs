/**
 * The confirmation gate.
 *
 * `plan.md` is the artifact the user approves. `run.mjs` refuses to execute
 * unless the plan's trailing status line says `已确认`, so "wait for the user"
 * is enforced mechanically and not only by instruction.
 */

import fs from 'node:fs';

/** Statuses a plan can carry. */
export const PLAN_STATUS = {
  pending: '待确认',
  confirmed: '已确认',
};

const STATUS_PATTERN = /^\s*(?:状态|status)\s*[:：]\s*(待确认|已确认)\s*$/im;

/**
 * Read the current plan status.
 * @param {string} file
 * @returns {{exists: boolean, status: '待确认'|'已确认'|null, raw: string}}
 */
export function readPlanStatus(file) {
  if (!fs.existsSync(file)) return { exists: false, status: null, raw: '' };
  const raw = fs.readFileSync(file, 'utf8');

  // The last status line wins, so an updated plan supersedes the original.
  let status = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = STATUS_PATTERN.exec(line);
    if (match !== null) status = match[1];
  }
  return { exists: true, status, raw };
}

/**
 * Rewrite the plan's status line, appending one when absent.
 * @param {string} file
 * @param {'待确认'|'已确认'} status
 * @param {{confirmedBy?: string, note?: string}} [options]
 * @returns {string} the file path
 */
export function setPlanStatus(file, status, options = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((line) => !STATUS_PATTERN.test(line));

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const trailer = ['', `状态: ${status}`];
  if (status === PLAN_STATUS.confirmed) {
    trailer.push(`确认时间: ${new Date().toISOString()}`);
    if (options.confirmedBy) trailer.push(`确认人: ${options.confirmedBy}`);
  }
  if (options.note) trailer.push(`备注: ${options.note}`);

  fs.writeFileSync(file, `${kept.join('\n')}\n${trailer.join('\n')}\n`);
  return file;
}
