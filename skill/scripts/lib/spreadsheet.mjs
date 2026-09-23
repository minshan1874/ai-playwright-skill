/**
 * Spreadsheet readers: `.xlsx` via exceljs (with a namespace-agnostic built-in
 * fallback), `.csv` via the local parser, and Markdown tables as a
 * dependency-free fallback.
 *
 * All paths return the same thing — a sheet name plus a matrix of strings — so
 * the case normalizer only has to deal with one input shape.
 *
 * Compatibility matters more than elegance here: case sheets come out of Excel,
 * WPS, Numbers, Google Sheets, and assorted "export to spreadsheet" buttons, and
 * those tools disagree about namespaces, sheet parts, and even about whether an
 * `.xlsx` is a ZIP at all. Every reader therefore reports which strategy actually
 * produced the rows, and a total failure is reported as a *format compatibility*
 * problem rather than as "your file is wrong".
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseCsv } from './csv.mjs';
import { loadExcelJS } from './deps.mjs';
import { decodeXmlText, readXlsxNative } from './xlsx-native.mjs';

/** File extensions this module can read. */
export const SUPPORTED_EXTENSIONS = ['.xlsx', '.csv', '.md', '.markdown', '.txt'];

/** Readers that can be tried for a container, in order. */
export const STRATEGIES = ['exceljs', 'native-xlsx', 'html-table', 'delimited-text'];

/**
 * Raised when no reader could make sense of a case file.
 *
 * The distinction matters for the agent's next move: a *format* problem is fixed
 * by re-exporting the file, while a *content* problem (missing columns, no data
 * rows) is fixed by editing it.
 */
export class SpreadsheetFormatError extends Error {
  /**
   * @param {string} message
   * @param {{file?: string, attempts?: {strategy: string, error: string}[], hint?: string}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'SpreadsheetFormatError';
    this.kind = 'format-incompatible';
    this.file = options.file ?? '';
    this.attempts = options.attempts ?? [];
    this.hint = options.hint ?? '';
  }
}

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
 * Identify what a file actually is, by content rather than by extension.
 *
 * Export tools mislabel files often enough that trusting the extension is what
 * produces "Cannot read properties of undefined" instead of a useful error.
 *
 * @param {Buffer} buffer
 * @returns {'zip'|'html'|'text'|'unknown'}
 */
export function sniffFormat(buffer) {
  if (buffer.length === 0) return 'unknown';

  // ZIP local file header, empty archive, or spanned-archive marker.
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const third = buffer[2];
    const fourth = buffer[3];
    if (
      (third === 0x03 && fourth === 0x04) ||
      (third === 0x05 && fourth === 0x06) ||
      (third === 0x07 && fourth === 0x08)
    ) {
      return 'zip';
    }
  }

  const head = buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<(!doctype\s+html|html|head|body|meta|table|div|span)\b/.test(head)) return 'html';
  if (head.startsWith('<?xml') && /<(?:\w+:)?(?:workbook|table)\b/.test(head)) return 'xml';

  // A NUL byte in the first block is the classic "this is binary" tell.
  if (!buffer.subarray(0, 8192).includes(0)) return 'text';
  return 'unknown';
}

/**
 * Read the first usable HTML table out of a document.
 * @param {string} text
 * @returns {string[][]}
 */
export function readHtmlTable(text) {
  const source = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const tables = [...source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((match) => match[1]);
  if (tables.length === 0) throw new Error('HTML 中没有找到 <table> 元素。');

  const strip = (html) =>
    decodeXmlText(
      html
        .replace(/<(?:br|BR)\s*\/?>/g, '\n')
        .replace(/<\/(?:p|div|li|tr)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .replace(/\u00a0/g, ' ')
      .trim();

  const parseTable = (html) => {
    const rows = [];
    for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]\s*>/gi)) {
        const span = /colspan\s*=\s*"?(\d+)/i.exec(cellMatch[1]);
        const value = strip(cellMatch[2]);
        cells.push(value);
        // Honour colspan so a merged cell does not shift every later column.
        for (let extra = 1; extra < Number(span?.[1] ?? 1); extra += 1) cells.push(value);
      }
      if (cells.length > 0) rows.push(cells);
    }
    return rows;
  };

  const candidates = tables.map(parseTable).filter((rows) => rows.length > 0);
  if (candidates.length === 0) throw new Error('HTML 表格中没有数据行。');
  // Prefer the widest table: export pages often wrap the real sheet in layout tables.
  return candidates.sort((a, b) => Math.max(...b.map((row) => row.length)) - Math.max(...a.map((row) => row.length)))[0];
}

/**
 * Read an `.xlsx` workbook through exceljs.
 * @param {string} file
 * @param {string|null} sheetName
 * @param {string} [home] skill home holding node_modules
 * @returns {Promise<{sheet: string, rows: string[][], sheets: string[]}>}
 */
async function readXlsxWithExcelJS(file, sheetName, home) {
  const ExcelJS = await loadExcelJS(home === undefined ? {} : { home });

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
 * Build the "we could not read this" message.
 * @param {string} file
 * @param {{strategy: string, error: string}[]} attempts
 * @returns {SpreadsheetFormatError}
 */
function formatError(file, attempts) {
  const detail = attempts.map((attempt) => `  · ${attempt.strategy}：${attempt.error}`).join('\n');
  const message = [
    `用例文件格式兼容问题：${path.basename(file)} 无法解析。`,
    detail,
    '这通常是文件结构/命名空间与解析器不兼容导致的（常见于第三方工具导出的 .xlsx），而不是用例内容有误。',
  ]
    .filter(Boolean)
    .join('\n');

  return new SpreadsheetFormatError(message, {
    file,
    attempts,
    hint:
      '请用 Excel / WPS / Numbers 打开该文件，另存为 .csv（UTF-8）或标准 .xlsx 后重试；' +
      '也可以直接把表格内容粘贴成 Markdown 表格（| 列 | 列 |）交给 skill。',
  });
}

/**
 * Read any supported case file into rows.
 *
 * Strategy order for a spreadsheet container: exceljs (best fidelity) -> built-in
 * namespace-agnostic reader. A file whose *content* is HTML or delimited text is
 * parsed as such regardless of its extension.
 *
 * @param {string} file
 * @param {{sheet?: string|null, home?: string}} [options]
 * @returns {Promise<{format: string, sheet: string, rows: string[][], sheets?: string[], strategy: string, warnings: string[]}>}
 */
export async function readRows(file, options = {}) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`找不到用例文件：${absolute}`);

  const extension = path.extname(absolute).toLowerCase();
  const sheetName = options.sheet ?? null;
  const buffer = fs.readFileSync(absolute);
  const sniffed = sniffFormat(buffer);
  const warnings = [];

  // --- Spreadsheets ---------------------------------------------------------
  if (extension === '.xlsx') {
    // Export tools sometimes write HTML or delimited text under an .xlsx name.
    if (sniffed === 'html') {
      warnings.push('文件扩展名是 .xlsx，但内容其实是 HTML 表格，已按 HTML 解析。');
      return { format: 'xlsx', strategy: 'html-table', sheet: path.basename(absolute), rows: readHtmlTable(buffer.toString('utf8')), warnings };
    }
    if (sniffed === 'text') {
      warnings.push('文件扩展名是 .xlsx，但内容其实是分隔符文本，已按 CSV/TSV 解析。');
      return { format: 'xlsx', strategy: 'delimited-text', sheet: path.basename(absolute), rows: parseCsv(buffer.toString('utf8')), warnings };
    }

    /** @type {{strategy: string, error: string}[]} */
    const attempts = [];

    try {
      const result = await readXlsxWithExcelJS(absolute, sheetName, options.home);
      return { format: 'xlsx', strategy: 'exceljs', ...result, warnings };
    } catch (error) {
      attempts.push({ strategy: 'exceljs', error: error?.message ?? String(error) });
    }

    try {
      const result = readXlsxNative(buffer, { sheet: sheetName });
      warnings.push(
        `exceljs 无法读取该文件（${attempts[0].error}），已改用内置读取器解析成功；` +
          '若结果与预期不符，请把文件另存为 .csv 后重新解析。',
      );
      return { format: 'xlsx', strategy: 'native-xlsx', ...result, warnings };
    } catch (error) {
      attempts.push({ strategy: 'native-xlsx', error: error?.message ?? String(error) });
    }

    throw formatError(absolute, attempts);
  }

  // --- Delimited text -------------------------------------------------------
  if (extension === '.csv' || extension === '.txt') {
    if (sniffed === 'html') {
      warnings.push('文件扩展名是 .csv/.txt，但内容其实是 HTML 表格，已按 HTML 解析。');
      return { format: 'csv', strategy: 'html-table', sheet: path.basename(absolute), rows: readHtmlTable(buffer.toString('utf8')), warnings };
    }
    return { format: 'csv', strategy: 'delimited-text', sheet: path.basename(absolute), rows: parseCsv(buffer.toString('utf8')), warnings };
  }

  // --- Markdown -------------------------------------------------------------
  if (extension === '.md' || extension === '.markdown') {
    try {
      const { sheet, rows } = readMarkdown(absolute);
      return { format: 'markdown', strategy: 'markdown-table', sheet, rows, warnings };
    } catch (error) {
      if (sniffed === 'html') {
        warnings.push('Markdown 文件中没有表格，但内容是 HTML 表格，已按 HTML 解析。');
        return { format: 'markdown', strategy: 'html-table', sheet: path.basename(absolute), rows: readHtmlTable(buffer.toString('utf8')), warnings };
      }
      throw error;
    }
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
