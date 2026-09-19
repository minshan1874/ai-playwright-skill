#!/usr/bin/env node
/**
 * Regenerate `assets/case-template.xlsx` from `assets/case-template.csv`.
 *
 * Keeping the CSV as the source of truth means the two templates can never drift.
 * Run this after editing the CSV:
 *
 *   node scripts/make-template.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_COLUMNS } from './lib/cases.mjs';
import { parseCsv } from './lib/csv.mjs';
import { loadExcelJS } from './lib/deps.mjs';
import { createReporter, parseArgs } from './lib/log.mjs';
import { resolveHome } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(path.dirname(HERE), 'assets');

const { json, flags } = parseArgs(process.argv.slice(2));
const reporter = createReporter({ json, script: 'make-template' });

/** Column documentation written to the second worksheet. */
const COLUMN_DOCS = [
  ['列名', '是否必需', '说明'],
  ['用例ID', '否', '如 TC-001。留空时自动编号，并会在解析结果里给出提示。'],
  ['模块', '否', '如「登录」「订单管理」。留空归入「未分类」。报告与计划按此分组。'],
  ['用例标题', '是', '一句话说明这条用例验证什么。'],
  ['优先级', '否', 'P0 / P1 / P2 / P3。缺失或非法按 P2 处理。'],
  ['前置条件', '否', '执行前需要满足的条件。多值写法同「操作步骤」。'],
  ['操作步骤', '是', '用户视角的操作序列。单元格内换行，或用 | 分隔，或写 1. 2. 3.。'],
  ['预期结果', '否', '与操作步骤按顺序一一对应。缺失时只能验证「不报错」。'],
  ['测试数据', '否', '键=值 形式，多个用 ; 分隔。例如：用户名=admin; 密码=123456'],
  ['标签', '否', '逗号或竖线分隔，如 smoke, 回归。会转成 Playwright tag。'],
];

async function main() {
  const csvFile = path.join(ASSETS, 'case-template.csv');
  const outFile = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(ASSETS, 'case-template.xlsx');

  if (!fs.existsSync(csvFile)) {
    process.exit(reporter.finish({ ok: false, error: `找不到模板源文件：${csvFile}` }));
  }

  const ExcelJS = await loadExcelJS({ home: resolveHome(process.env) });
  const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'playwright-e2e skill';
  workbook.created = new Date();

  // --- Sheet 1: the template itself ----------------------------------------
  const sheet = workbook.addWorksheet('用例');
  for (const row of rows) sheet.addRow(row);

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  const widths = [12, 14, 34, 10, 24, 46, 40, 34, 16];
  CANONICAL_COLUMNS.forEach((_, index) => {
    sheet.getColumn(index + 1).width = widths[index] ?? 18;
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: CANONICAL_COLUMNS.length } };
  for (let index = 2; index <= rows.length; index += 1) {
    sheet.getRow(index).alignment = { vertical: 'top', wrapText: true };
  }

  // --- Sheet 2: column documentation ---------------------------------------
  const docs = workbook.addWorksheet('列说明');
  for (const row of COLUMN_DOCS) docs.addRow(row);
  docs.getRow(1).font = { bold: true };
  docs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
  docs.getColumn(1).width = 14;
  docs.getColumn(2).width = 10;
  docs.getColumn(3).width = 70;
  for (let index = 1; index <= COLUMN_DOCS.length; index += 1) {
    docs.getRow(index).alignment = { vertical: 'top', wrapText: true };
  }

  await workbook.xlsx.writeFile(outFile);

  reporter.note(`✅ 已生成 Excel 模板：${outFile}`);
  reporter.note(`   ${rows.length - 1} 条示例用例，${CANONICAL_COLUMNS.length} 列。`);

  process.exit(
    reporter.finish({
      ok: true,
      output: outFile,
      source: csvFile,
      exampleRows: rows.length - 1,
      columns: CANONICAL_COLUMNS,
    }),
  );
}

main().catch((error) => {
  process.exit(reporter.finish({ ok: false, error: error?.message ?? String(error) }));
});
