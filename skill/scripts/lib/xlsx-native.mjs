/**
 * Dependency-free `.xlsx` reader.
 *
 * `exceljs` is the primary reader, but it assumes one specific OOXML shape: its
 * workbook parser does `workbook.sheets` on the result of parsing
 * `xl/workbook.xml`, and when that element carries a namespace or structure it
 * does not recognise (Strict OOXML, prefixed elements, a workbook rewritten by a
 * third-party export tool) the result is `undefined` and the caller sees the
 * unhelpful `Cannot read properties of undefined (reading 'sheets')`.
 *
 * This module reads the same container without assuming anything about namespace
 * prefixes: ZIP central directory -> inflate -> namespace-agnostic XML scanning.
 * It exists so that a spreadsheet exceljs refuses still produces rows.
 *
 * Scope is deliberately narrow — enough for tabular case sheets: shared strings,
 * inline strings, formula results, sparse cells, merged ranges, and Zip64. Cell
 * number formats (dates, percentages) are NOT interpreted; raw values are
 * returned, which is what a test-case table needs.
 */

import zlib from 'node:zlib';

/** ZIP signatures. */
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Maximum length of the ZIP end-of-central-directory comment. */
const MAX_COMMENT = 0xffff;

/**
 * Locate the end-of-central-directory record.
 * @param {Buffer} buffer
 * @returns {number} offset, or -1 when not found
 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Read the ZIP64 end-of-central-directory record when the classic one is
 * saturated. Export tools happily emit Zip64 for files far below 4 GB.
 * @param {Buffer} buffer
 * @param {number} eocd offset of the classic record
 * @returns {{entries: number, offset: number}|null}
 */
function readZip64Directory(buffer, eocd) {
  // The Zip64 locator sits immediately before the classic EOCD record.
  const locator = eocd - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) return null;
  const zip64Offset = Number(buffer.readBigUInt64LE(locator + 8));
  if (zip64Offset < 0 || zip64Offset + 56 > buffer.length) return null;
  if (buffer.readUInt32LE(zip64Offset) !== ZIP64_EOCD_SIGNATURE) return null;
  return {
    entries: Number(buffer.readBigUInt64LE(zip64Offset + 32)),
    offset: Number(buffer.readBigUInt64LE(zip64Offset + 48)),
  };
}

/**
 * List the entries of a ZIP container.
 * @param {Buffer} buffer
 * @returns {{name: string, method: number, compressedSize: number, size: number, offset: number}[]}
 */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP 容器（找不到中央目录）。');

  let entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) {
    const zip64 = readZip64Directory(buffer, eocd);
    if (zip64 !== null) {
      entries = zip64.entries;
      offset = zip64.offset;
    }
  }

  const out = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    let size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // Zip64 stores saturated fields in an extra field (header id 0x0001), in the
    // order: uncompressed size, compressed size, local header offset.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = cursor + 46 + nameLength;
      let extra = extraStart;
      const extraEnd = extraStart + extraLength;
      while (extra + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(extra);
        const dataSize = buffer.readUInt16LE(extra + 2);
        if (headerId === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) {
            size = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(field));
          break;
        }
        extra += 4 + dataSize;
      }
    }

    out.push({ name, method, compressedSize, size, offset: localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (out.length === 0) throw new Error('ZIP 容器中没有可读条目。');
  return out;
}

/**
 * Extract one entry's bytes.
 * @param {Buffer} buffer
 * @param {{name: string, method: number, compressedSize: number, offset: number}} entry
 * @returns {Buffer}
 */
export function extractZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new Error(`条目 ${entry.name} 的本地文件头无效。`);
  }
  const nameLength = buffer.readUInt16LE(entry.offset + 26);
  const extraLength = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`条目 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}）。`);
}

/** Decode the XML entities that appear in spreadsheet text. */
export function decodeXmlText(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Match an element regardless of its namespace prefix.
 *
 * `<sheet>`, `<x:sheet>` and `<ss:sheet>` are the same element to us. The
 * lookahead keeps `<sheetPr>`/`<sheetViews>` from matching `<sheet>`.
 *
 * @param {string} name local element name
 * @returns {RegExp}
 */
function tagPattern(name) {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?=[\\s/>])`, 'g');
}

/**
 * Read an attribute from a start tag, tolerating any namespace prefix.
 * @param {string} attributes raw attribute text
 * @param {string} name attribute name (matched with or without a prefix)
 * @returns {string}
 */
function attribute(attributes, name) {
  const pattern = new RegExp(`(?:^|\\s)(?:[A-Za-z0-9_.-]+:)?${name}\\s*=\\s*"([^"]*)"`, 'i');
  const match = pattern.exec(attributes);
  return match === null ? '' : decodeXmlText(match[1]);
}

/**
 * Split a document into the blocks matched by an element name.
 * @param {string} xml
 * @param {string} name
 * @returns {{attributes: string, inner: string}[]}
 */
function elementBlocks(xml, name) {
  const blocks = [];
  const pattern = tagPattern(name);
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const tagEnd = xml.indexOf('>', match.index);
    if (tagEnd < 0) break;
    const attributes = xml.slice(match.index + match[0].length, tagEnd);
    if (attributes.endsWith('/')) {
      blocks.push({ attributes: attributes.slice(0, -1), inner: '' });
      pattern.lastIndex = tagEnd + 1;
      continue;
    }
    const closing = new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${name}\\s*>`, 'g');
    closing.lastIndex = tagEnd + 1;
    const end = closing.exec(xml);
    if (end === null) {
      blocks.push({ attributes, inner: xml.slice(tagEnd + 1) });
      break;
    }
    blocks.push({ attributes, inner: xml.slice(tagEnd + 1, end.index) });
    pattern.lastIndex = closing.lastIndex;
  }
  return blocks;
}

/**
 * Concatenate the text runs of one `<si>`/`<is>` block.
 * Phonetic runs (`<rPh>`, Japanese furigana) are display metadata, not content.
 * @param {string} inner
 * @returns {string}
 */
function textRuns(inner) {
  const withoutPhonetics = inner.replace(
    new RegExp(`<(?:[A-Za-z0-9_.-]+:)?rPh(?=[\\s/>])[\\s\\S]*?</(?:[A-Za-z0-9_.-]+:)?rPh\\s*>`, 'g'),
    '',
  );
  const parts = [];
  const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?t(?=[\\s/>])([^>]*)>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?t\\s*>`, 'g');
  let match;
  while ((match = pattern.exec(withoutPhonetics)) !== null) parts.push(decodeXmlText(match[2]));
  return parts.join('');
}

/**
 * Parse `xl/sharedStrings.xml`.
 * @param {string} xml
 * @returns {string[]}
 */
export function parseSharedStrings(xml) {
  return elementBlocks(xml, 'si').map((block) => textRuns(block.inner));
}

/**
 * Parse the `<sheets>` list of `xl/workbook.xml`.
 * @param {string} xml
 * @returns {{name: string, sheetId: string, relId: string, state: string}[]}
 */
export function parseWorkbookSheets(xml) {
  return elementBlocks(xml, 'sheet').map((block) => ({
    name: attribute(block.attributes, 'name'),
    sheetId: attribute(block.attributes, 'sheetId'),
    relId: attribute(block.attributes, 'id'),
    state: attribute(block.attributes, 'state'),
  }));
}

/**
 * Parse a `.rels` part into an id -> target map.
 * @param {string} xml
 * @returns {Map<string, string>}
 */
export function parseRelationships(xml) {
  const map = new Map();
  for (const block of elementBlocks(xml, 'Relationship')) {
    const id = attribute(block.attributes, 'Id');
    const target = attribute(block.attributes, 'Target');
    if (id !== '' && target !== '') map.set(id, target);
  }
  return map;
}

/**
 * Turn a cell reference such as `AB12` into a zero-based column index.
 * @param {string} reference
 * @returns {number} -1 when the reference is unparseable
 */
export function columnIndex(reference) {
  const match = /^([A-Za-z]+)/.exec(String(reference ?? ''));
  if (match === null) return -1;
  let index = 0;
  for (const char of match[1].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Resolve the value of one `<c>` cell.
 * @param {{attributes: string, inner: string}} cell
 * @param {string[]} sharedStrings
 * @returns {string}
 */
function cellValue(cell, sharedStrings) {
  const type = attribute(cell.attributes, 't');

  if (type === 'inlineStr') {
    const inline = elementBlocks(cell.inner, 'is')[0];
    return inline === undefined ? '' : textRuns(inline.inner);
  }
  if (type === 's') {
    const raw = /<(?:[A-Za-z0-9_.-]+:)?v(?=[\s/>])[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?v\s*>/.exec(cell.inner);
    const index = raw === null ? Number.NaN : Number.parseInt(decodeXmlText(raw[1]).trim(), 10);
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : '';
  }

  const value = /<(?:[A-Za-z0-9_.-]+:)?v(?=[\s/>])[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?v\s*>/.exec(cell.inner);
  if (value === null) return '';
  const text = decodeXmlText(value[1]).trim();

  if (type === 'b') return text === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return '';
  return text;
}

/**
 * Parse one worksheet part into a matrix of strings.
 * @param {string} xml
 * @param {string[]} sharedStrings
 * @returns {string[][]}
 */
export function parseWorksheet(xml, sharedStrings = []) {
  const rows = [];

  for (const row of elementBlocks(xml, 'row')) {
    const rowNumber = Number.parseInt(attribute(row.attributes, 'r'), 10);
    const target = Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber - 1 : rows.length;

    const cells = [];
    let cursor = 0;
    for (const cell of elementBlocks(row.inner, 'c')) {
      const declared = columnIndex(attribute(cell.attributes, 'r'));
      const column = declared >= 0 ? declared : cursor;
      while (cells.length < column) cells.push('');
      cells[column] = cellValue(cell, sharedStrings);
      cursor = column + 1;
    }

    while (rows.length < target) rows.push([]);
    rows[target] = cells;
  }

  applyMergedCells(xml, rows);
  return rows;
}

/**
 * Fill merged ranges from their master cell.
 *
 * A "模块" column merged down its rows reads as empty for every row but the
 * first; spreadsheet users expect the value to apply to the whole range, and the
 * exceljs path behaves the same way.
 *
 * @param {string} xml
 * @param {string[][]} rows
 */
function applyMergedCells(xml, rows) {
  const container = elementBlocks(xml, 'mergeCells')[0];
  if (container === undefined) return;

  for (const merge of elementBlocks(container.inner, 'mergeCell')) {
    const ref = attribute(merge.attributes, 'ref');
    const [start, end] = ref.split(':');
    if (start === undefined || end === undefined) continue;

    const startColumn = columnIndex(start);
    const endColumn = columnIndex(end);
    const startRow = Number.parseInt(/(\d+)/.exec(start)?.[1] ?? '', 10) - 1;
    const endRow = Number.parseInt(/(\d+)/.exec(end)?.[1] ?? '', 10) - 1;
    if (startColumn < 0 || endColumn < 0 || !Number.isInteger(startRow) || !Number.isInteger(endRow)) continue;

    const master = rows[startRow]?.[startColumn] ?? '';
    if (master === '') continue;
    for (let row = startRow; row <= endRow; row += 1) {
      if (rows[row] === undefined) rows[row] = [];
      const target = rows[row];
      while (target.length <= endColumn) target.push('');
      for (let column = startColumn; column <= endColumn; column += 1) {
        if (row === startRow && column === startColumn) continue;
        if ((target[column] ?? '') === '') target[column] = master;
      }
    }
  }
}

/**
 * Read an `.xlsx` workbook without exceljs.
 *
 * @param {Buffer} buffer raw file bytes
 * @param {{sheet?: string|null}} [options]
 * @returns {{sheet: string, rows: string[][], sheets: string[]}}
 */
export function readXlsxNative(buffer, options = {}) {
  const entries = readZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, ''), entry]));

  const workbookEntry = byName.get('xl/workbook.xml');
  if (workbookEntry === undefined) {
    const names = entries.map((entry) => entry.name).slice(0, 12).join(', ');
    throw new Error(`压缩包内没有 xl/workbook.xml（可能是 .ods 或其他格式）。包内条目：${names}`);
  }

  const workbookXml = extractZipEntry(buffer, workbookEntry).toString('utf8');
  const sheets = parseWorkbookSheets(workbookXml);
  if (sheets.length === 0) throw new Error('xl/workbook.xml 中没有解析到任何工作表。');

  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  const rels = relsEntry === undefined ? new Map() : parseRelationships(extractZipEntry(buffer, relsEntry).toString('utf8'));

  const sharedEntry = byName.get('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry === undefined ? [] : parseSharedStrings(extractZipEntry(buffer, sharedEntry).toString('utf8'));

  /** Resolve a sheet's part name, tolerating missing/absolute/odd rel targets. */
  const partFor = (sheet, index) => {
    const target = rels.get(sheet.relId);
    if (typeof target === 'string' && target !== '') {
      const normalized = target.replace(/^\/+/, '').replace(/^\.\//, '');
      const candidates = [normalized, `xl/${normalized}`];
      for (const candidate of candidates) {
        const entry = byName.get(candidate);
        if (entry !== undefined) return entry;
      }
    }
    // Fall back to the conventional layout: sheet1.xml, sheet2.xml, ...
    for (const name of [`xl/worksheets/sheet${index + 1}.xml`, `xl/worksheets/sheet${sheet.sheetId}.xml`]) {
      const entry = byName.get(name);
      if (entry !== undefined) return entry;
    }
    return undefined;
  };

  const requested = options.sheet ?? null;
  const parts = sheets.map((sheet, index) => ({ sheet, entry: partFor(sheet, index) }));

  let chosen;
  if (requested !== null) {
    chosen = parts.find((part) => part.sheet.name === requested);
    if (chosen === undefined) {
      throw new Error(`找不到工作表 "${requested}"。可用工作表：${sheets.map((sheet) => sheet.name).join(', ')}。`);
    }
  } else {
    // Match the exceljs path: prefer the first sheet that actually holds data.
    chosen =
      parts.find((part) => {
        if (part.entry === undefined) return false;
        try {
          return parseWorksheet(extractZipEntry(buffer, part.entry).toString('utf8'), sharedStrings).some(
            (row) => row.some((value) => String(value ?? '').trim() !== ''),
          );
        } catch {
          return false;
        }
      }) ?? parts[0];
  }

  if (chosen === undefined || chosen.entry === undefined) {
    throw new Error(`工作表 "${sheets.map((sheet) => sheet.name).join(', ')}" 的 XML 部件缺失。`);
  }

  const rows = parseWorksheet(extractZipEntry(buffer, chosen.entry).toString('utf8'), sharedStrings);
  return { sheet: chosen.sheet.name, rows, sheets: sheets.map((sheet) => sheet.name) };
}
