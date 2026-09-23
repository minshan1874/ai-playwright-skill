/**
 * Index of the automation that exists on disk.
 *
 * Coverage and execution are different questions, and conflating them is how a
 * `--grep` re-run of one case ends up looking like a coverage hole:
 *
 *   - "未自动化"      — no spec was ever written for this case
 *   - "本次未执行"    — a spec exists, but this run's filter excluded it
 *
 * Playwright's JSON report only describes what ran, so the second answer has to
 * come from reading the spec files themselves. This is a static scan: it never
 * executes anything, and it degrades gracefully when a spec does not compile.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Spec file naming convention used by the generated runs. */
const SPEC_PATTERN = /\.(spec|test)\.(ts|js|mts|mjs|cts|cjs)$/;

/**
 * List the spec files of a run, sorted for stable output.
 * @param {string} specsDir
 * @returns {string[]} absolute paths
 */
export function listSpecFiles(specsDir) {
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir)
    .filter((name) => SPEC_PATTERN.test(name))
    .sort()
    .map((name) => path.join(specsDir, name));
}

/**
 * Collect every case id that has automation code.
 *
 * Three spellings are read, because a spec may use any of them:
 *   - the Playwright annotation, `{ type: 'caseId', description: 'TC-001' }`
 *   - a shorthand property, `caseId: 'TC-001'`
 *   - the `[TC-001]` title prefix the plan asks for
 *
 * @param {string} specsDir
 * @returns {Set<string>}
 */
export function collectAutomatedCaseIds(specsDir) {
  const ids = new Set();
  const add = (value) => {
    const id = String(value ?? '').trim();
    if (id !== '') ids.add(id);
  };

  const QUOTED = `['"\`]([^'"\`]+)['"\`]`;
  const patterns = [
    // { type: 'caseId', description: 'TC-001' } — and the reversed property order.
    new RegExp(`type\\s*:\\s*${QUOTED}\\s*,\\s*description\\s*:\\s*${QUOTED}`, 'g'),
    new RegExp(`description\\s*:\\s*${QUOTED}\\s*,\\s*type\\s*:\\s*${QUOTED}`, 'g'),
    // caseId: 'TC-001' / caseId = 'TC-001'
    new RegExp(`caseId\\s*[:=]\\s*${QUOTED}`, 'g'),
    // test('[TC-001] 标题', ...)
    /\btest(?:\.\w+)?\(\s*['"`]\[([^\]'"`]+)\]/g,
  ];

  for (const file of listSpecFiles(specsDir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const [index, pattern] of patterns.entries()) {
      for (const match of text.matchAll(pattern)) {
        if (index === 0) {
          // Only a `caseId` annotation counts; the same shape carries module/priority.
          if (match[1] === 'caseId') add(match[2]);
        } else if (index === 1) {
          if (match[2] === 'caseId') add(match[1]);
        } else {
          add(match[1]);
        }
      }
    }
  }
  return ids;
}
