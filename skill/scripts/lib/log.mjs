/**
 * Output helpers shared by every skill script.
 *
 * Each script can run in two modes: human-readable (default) and `--json`
 * (machine-readable, consumed by the agent). Keeping both on the same code path
 * means the agent and the user always see the same facts.
 */

/** Marker prefix for the single machine-readable line a script emits. */
export const JSON_MARKER = '###PLAYWRIGHT_E2E_JSON###';

/**
 * Parse the common CLI flags.
 * @param {string[]} argv
 * @returns {{json: boolean, flags: Record<string, string|boolean>, positionals: string[]}}
 */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { json: flags.json === true || flags.json === 'true', flags, positionals };
}

/**
 * Build the reporter a script uses for the rest of its run.
 * @param {{json: boolean, script: string}} options
 */
export function createReporter({ json, script }) {
  const notes = [];
  const human = (line = '') => {
    if (!json) process.stdout.write(`${line}\n`);
  };
  return {
    /** Print a human-readable progress line; suppressed in `--json` mode. */
    note(line) {
      notes.push(String(line));
      human(line);
    },
    /** Print a human-readable line that is always shown, even in `--json` mode. */
    always(line) {
      notes.push(String(line));
      process.stdout.write(`${line}\n`);
    },
    /**
     * Emit the terminal result.
     * @param {{ok: boolean} & Record<string, unknown>} result
     * @returns {number} process exit code
     */
    finish(result) {
      const payload = { script, ok: Boolean(result.ok), ...result };
      delete payload.ok;
      if (json) {
        process.stdout.write(`${JSON_MARKER}\n${JSON.stringify({ script, ...result })}\n`);
      } else {
        human('');
        human(summarizeHuman(script, result));
      }
      return result.ok ? 0 : 1;
    },
    /** Collected human notes, for embedding into JSON results. */
    get notes() {
      return notes.slice();
    },
  };
}

/**
 * Render a short human summary for the common result shapes.
 * @param {string} script
 * @param {{ok: boolean} & Record<string, any>} result
 * @returns {string}
 */
function summarizeHuman(script, result) {
  const lines = [];
  if (!result.ok) {
    lines.push(`❌ ${script} 失败`);
    if (result.error) lines.push(`原因: ${result.error}`);
    if (result.hint) lines.push(result.hint);
    return lines.join('\n');
  }
  lines.push(`✅ ${script} 完成`);
  if (script === 'bootstrap') {
    lines.push(`  运行目录: ${result.home}`);
    lines.push(`  依赖: ${result.dependencies?.installed ? '已就绪' : '缺失'}`);
    lines.push(`  浏览器: ${(result.browsers?.available ?? []).join(', ') || '无'}`);
  } else if (script === 'parse-cases') {
    lines.push(`  用例总数: ${result.total}`);
    if (result.warnings?.length) lines.push(`  警告: ${result.warnings.length} 条`);
  } else if (script === 'run') {
    lines.push(`  通过 ${result.counts?.passed ?? 0} / 失败 ${result.counts?.failed ?? 0} / 跳过 ${result.counts?.skipped ?? 0}`);
  } else if (script === 'report') {
    lines.push(`  报告: ${result.report}`);
  }
  return lines.join('\n');
}

/**
 * Exit with a structured failure.
 * @param {ReturnType<typeof createReporter>} reporter
 * @param {string} script
 * @param {string} error
 * @param {string} [hint]
 * @returns {never}
 */
export function fail(reporter, script, error, hint) {
  const code = reporter.finish({ ok: false, error, ...(hint ? { hint } : {}) });
  process.exit(code);
}
