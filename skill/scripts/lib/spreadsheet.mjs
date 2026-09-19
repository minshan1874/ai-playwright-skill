/**
 * Spreadsheet readers: `.xlsx` via exceljs, `.csv` via the local parser, and
 * Markdown tables as a dependency-free fallback.
 *
 * All three return the same thing — a sheet name plus a matrix of strings — so
 * the case normalizer only has to deal with one input shape.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseCsv } from './csv.mjs';
import { loadExcelJS } from './deps.mjs';

/** File extensions this module can read. */
export const SUPPORTED_EXTENSIONS = ['.xlsx', '.csv', '.md', '.markdown', '.txt'];

/**
 * Flatten any exceljs cell value into plain text.
 * @param {unknown} value
 * @returns {string}
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(cellText).join('');
  if (typeof value === 'object') {
    const record = /** @type {Record<string, any>} */ (value);
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => cellText(part?.text)).join('');
    }
    if ('result' in record) return cellText(record.result);
    if ('text' in record) return cellText(record.text);
    if ('hyperlink' in record) return cellText(record.hyperlink);
    if ('error' in record) return '';
  }
  return String(value);
}

/**
 * Read an `.xlsx` workbook.
 * @param {string} file
 * @param {string|null} sheetName
 * @param {string} [home] skill home holding node_modules
 * @returns {Promise<{sheet: string, rows: string[][], sheets: string[]}>}
 */
async function readXlsx(file, sheetName, home) {
  let ExcelJS;
  try {
    ExcelJS = await loadExcelJS(home === undefined ? {} : { home });
  } catch (error) {
    throw new Error(
      `读取 .xlsx 需要 exceljs 依赖，但它未能加载（${error.message}）。` +
        '请先运行 bootstrap.mjs 安装依赖，或把用例另存为 .csv 后重试。',
    );
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const sheets = workbook.worksheets.map((worksheet) => worksheet.name);
  if (sheets.length === 0) throw new Error(`${file} 中没有任何工作表。`);

  let worksheet;
  if (sheetName !== null) {
    worksheet = workbook.worksheets.find((candidate) => candidate.name === sheetName);
    if (worksheet === undefined) {
      throw new Error(`找不到工作表 "${sheetName}"。可用工作表：${sheets.join(', ')}。`);
    }
  } else {
    // Prefer the first sheet that actually holds data.
    worksheet =
      workbook.worksheets.find((candidate) => candidate.actualRowCount > 0) ?? workbook.worksheets[0];
  }

  const rows = [];
  const columnCount = Math.max(worksheet.columnCount ?? 0, 1);

  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = row.getCell(column);
      // Merged cells other than the master read as empty; borrow the master value
      // so a merged "模块" column fills down as a spreadsheet user would expect.
      const source = cell.isMerged && cell.master && cell.master !== cell ? cell.master.value : cell.value;
      cells.push(cellText(source).trim());
    }
    rows.push(cells);
  });

  return { sheet: worksheet.name, rows, sheets };
}

/**
 * Read a Markdown table.
 * @param {string} file
 * @returns {{sheet: string, rows: string[][]}}
 */
function readMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

    // Drop the `| --- | :--: |` alignment separator row.
    if (cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }

  if (rows.length === 0) {
    throw new Error(`${file} 中没有找到 Markdown 表格。请确认用例以 | 列 | 列 | 的形式书写。`);
  }
  return { sheet: path.basename(file), rows };
}

/**
 * Read any supported case file into rows.
 * @param {string} file
 * @param {{sheet?: string|null, home?: string}} [options]
 * @returns {Promise<{format: string, sheet: string, rows: string[][], sheets?: string[]}>}
 */
export async function readRows(file, options = {}) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`找不到用例文件：${absolute}`);

  const extension = path.extname(absolute).toLowerCase();
  const sheetName = options.sheet ?? null;

  if (extension === '.xlsx') {
    const { sheet, rows, sheets } = await readXlsx(absolute, sheetName, options.home);
    return { format: 'xlsx', sheet, rows, sheets };
  }
  if (extension === '.csv' || extension === '.txt') {
    const text = fs.readFileSync(absolute, 'utf8');
    return { format: 'csv', sheet: path.basename(absolute), rows: parseCsv(text) };
  }
  if (extension === '.md' || extension === '.markdown') {
    const { sheet, rows } = readMarkdown(absolute);
    return { format: 'markdown', sheet, rows };
  }

  throw new Error(
    `不支持的用例文件格式 "${extension}"。支持：${SUPPORTED_EXTENSIONS.join(', ')}。`,
  );
}

/**
 * Drop fully empty rows and right-trim ragged rows.
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function compactRows(rows) {
  const kept = [];
  for (const row of rows) {
    const cells = row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    if (cells.every((cell) => cell.trim() === '')) continue;
    let last = cells.length - 1;
    while (last >= 0 && cells[last].trim() === '') last -= 1;
    kept.push(cells.slice(0, last + 1));
  }
  return kept;
}
