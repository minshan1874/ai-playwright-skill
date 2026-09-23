#!/usr/bin/env node
/**
 * Convert a test-case spreadsheet into `cases.json`.
 *
 * Accepts `.xlsx`, `.csv`, and Markdown tables. The header row is discovered
 * rather than assumed, so a title banner or an empty leading row is tolerated.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createReporter, parseArgs } from './lib/log.mjs';
import { CANONICAL_COLUMNS, countByPriority, groupByModule, mapHeaderRow, normalizeCase, validateCases } from './lib/cases.mjs';
import { stringifyCsv } from './lib/csv.mjs';
import { compactRows, readRows, SUPPORTED_EXTENSIONS } from './lib/spreadsheet.mjs';

/** How many leading rows to scan while looking for the header. */
const HEADER_SCAN_LIMIT = 20;

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'parse-cases' });

const input = typeof flags.input === 'string' ? flags.input : null;
const out = typeof flags.out === 'string' ? flags.out : null;
const sheet = typeof flags.sheet === 'string' ? flags.sheet : null;

/**
 * Locate the header row and its column mapping.
 * @param {string[][]} rows
 * @returns {{headerIndex: number, mapping: Record<string, number>, unknown: string[]}}
 */
function findHeader(rows) {
  const limit = Math.min(rows.length, HEADER_SCAN_LIMIT);
  let best = null;

  for (let index = 0; index < limit; index += 1) {
    const { mapping, unknown, missing } = mapHeaderRow(rows[index]);
    if (missing.length === 0) return { headerIndex: index, mapping, unknown };

    // Remember the closest miss so the error message can be specific.
    const score = Object.keys(mapping).length;
    if (best === null || score > best.score) best = { index, mapping, unknown, missing, score };
  }

  const found = best?.mapping ? Object.keys(best.mapping) : [];
  const detail = [
    `未能识别用例表头。需要至少包含「用例标题」和「操作步骤」两列。`,
    `标准列：${CANONICAL_COLUMNS.join(' | ')}`,
    found.length > 0 ? `在第 ${best.index + 1} 行识别到这些列：${found.join(', ')}` : '前 20 行中没有找到任何可识别的列名。',
    best?.unknown?.length ? `未识别的列名：${best.unknown.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  throw new Error(detail);
}

/**
 * Return whether a row repeats the header.
 * @param {string[]} row
 * @returns {boolean}
 */
function looksLikeHeader(row) {
  return mapHeaderRow(row).missing.length === 0;
}

async function main() {
  if (input === null) {
    process.exit(
      reporter.finish({
        ok: false,
        error: '缺少 --input 参数',
        hint: `用法：node parse-cases.mjs --input <用例文件> [--out <cases.json>] [--sheet <工作表>]。支持：${SUPPORTED_EXTENSIONS.join(', ')}。`,
      }),
    );
  }

  const absoluteInput = path.resolve(input);
  const {
    format,
    sheet: sheetName,
    rows,
    sheets,
    strategy,
    warnings: readWarnings,
  } = await readRows(absoluteInput, { sheet });

  if (rows.length === 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `${absoluteInput} 中没有任何数据行`,
        hint: '请确认文件中确实包含用例内容。',
      }),
    );
  }

  const { headerIndex, mapping, unknown } = findHeader(rows);

  const cases = [];
  let skippedHeaderRepeats = 0;

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (compactRows([cells]).length === 0) continue;
    if (looksLikeHeader(cells)) {
      skippedHeaderRepeats += 1;
      continue;
    }
    cases.push(
      normalizeCase(cells, mapping, {
        index: cases.length,
        rowRef: index + 1,
      }),
    );
  }

  const warnings = [...(readWarnings ?? []), ...validateCases(cases)];
  if (unknown.length > 0) {
    warnings.push(`以下列名未被识别，已忽略：${unknown.join(', ')}。如需纳入，请参考 references/case-format.md。`);
  }
  if (skippedHeaderRepeats > 0) {
    warnings.push(`跳过了 ${skippedHeaderRepeats} 个重复出现的表头行。`);
  }

  if (cases.length === 0) {
    process.exit(
      reporter.finish({
        ok: false,
        error: `表头在第 ${headerIndex + 1} 行，但其后没有任何用例数据行`,
        hint: '请确认用例数据紧跟在表头下方。',
      }),
    );
  }

  const payload = {
    source: absoluteInput,
    format,
    sheet: sheetName,
    strategy,
    ...(sheets ? { sheets } : {}),
    parsedAt: new Date().toISOString(),
    headerRow: headerIndex + 1,
    columns: mapping,
    unknownColumns: unknown,
    total: cases.length,
    byModule: groupByModule(cases).map((group) => ({ module: group.module, count: group.cases.length })),
    byPriority: countByPriority(cases),
    warnings,
    cases,
  };

  let written = null;
  if (out !== null) {
    const absoluteOut = path.resolve(out);
    fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
    fs.writeFileSync(absoluteOut, `${JSON.stringify(payload, null, 2)}\n`);
    written = absoluteOut;
  }

  // When the primary reader could not open a spreadsheet, leave a readable copy
  // of exactly what the fallback saw. Silently "fixing" a file the user cannot
  // reproduce is how a parsing bug turns into a mysterious wrong test result.
  let recovered = null;
  if (out !== null && format === 'xlsx' && strategy !== 'exceljs') {
    const absoluteOut = path.resolve(out);
    recovered = path.join(path.dirname(absoluteOut), `${path.basename(absoluteInput, path.extname(absoluteInput))}.recovered.csv`);
    fs.writeFileSync(recovered, stringifyCsv(compactRows(rows)));
    warnings.push(`已把解析到的内容另存为 ${recovered}，请核对无误后再执行测试。`);
    payload.recovered = recovered;
  }

  reporter.note(
    `已解析 ${cases.length} 条用例，来自 ${format} 文件 ${path.basename(absoluteInput)}` +
      `（工作表：${sheetName}，读取方式：${strategy}）。`,
  );
  for (const group of payload.byModule) {
    reporter.note(`  · ${group.module}: ${group.count} 条`);
  }
  if (warnings.length > 0) {
    reporter.note('');
    reporter.note(`⚠️  ${warnings.length} 条提示：`);
    for (const warning of warnings.slice(0, 20)) reporter.note(`  - ${warning}`);
    if (warnings.length > 20) reporter.note(`  … 其余 ${warnings.length - 20} 条见 cases.json 的 warnings 字段。`);
  }

  process.exit(
    reporter.finish({
      ok: true,
      output: written,
      source: absoluteInput,
      format,
      strategy,
      sheet: sheetName,
      ...(sheets ? { sheets } : {}),
      ...(recovered ? { recovered } : {}),
      headerRow: headerIndex + 1,
      columns: mapping,
      unknownColumns: unknown,
      total: cases.length,
      byModule: payload.byModule,
      byPriority: payload.byPriority,
      warnings,
      caseIds: cases.map((testCase) => testCase.id),
    }),
  );
}

main().catch((error) => {
  // A format problem and a content problem need opposite responses: re-export the
  // file versus edit it. Never collapse them into one vague "please fix".
  const isFormatIssue = error?.kind === 'format-incompatible' || error?.name === 'SpreadsheetFormatError';
  const isHeaderIssue = /表头|列名/.test(String(error?.message ?? ''));

  process.exit(
    reporter.finish({
      ok: false,
      error: error?.message ?? String(error),
      hint: isFormatIssue
        ? error.hint
        : isHeaderIssue
          ? `请对照 references/case-format.md 修正列名后重试。标准列：${CANONICAL_COLUMNS.join(' | ')}。`
          : '请修正用例文件后重试；列名要求见 references/case-format.md。',
      ...(isFormatIssue ? { formatIssue: true, attempts: error.attempts } : {}),
    }),
  );
});
