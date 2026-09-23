/**
 * Spreadsheet compatibility tests.
 *
 * The bug these pin down: exceljs does `model.sheets = workbook.sheets` on the
 * result of parsing `xl/workbook.xml`, so a workbook whose elements carry an
 * unexpected namespace prefix makes it throw
 * `Cannot read properties of undefined (reading 'sheets')` — an error that says
 * nothing about the actual problem and sent users off to "fix" perfectly good
 * files. The built-in reader must open what exceljs refuses, and a total failure
 * must be reported as a format compatibility problem.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { parseCsv, stringifyCsv } from '../skill/scripts/lib/csv.mjs';
import {
  SpreadsheetFormatError,
  compactRows,
  readHtmlTable,
  readRows,
  sniffFormat,
} from '../skill/scripts/lib/spreadsheet.mjs';
import {
  columnIndex,
  decodeXmlText,
  parseSharedStrings,
  parseWorkbookSheets,
  parseWorksheet,
  readXlsxNative,
  readZipEntries,
} from '../skill/scripts/lib/xlsx-native.mjs';

/**
 * Build a ZIP archive in memory.
 *
 * The fixture has to be a real ZIP because the whole point is to exercise the
 * container reader; the CRC table is the standard reflected-polynomial one.
 * @param {Record<string, string>} files
 * @returns {Buffer}
 */
function buildZip(files) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buffer) => {
    let c = -1;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/**
 * A workbook with prefixed element names and a Strict-OOXML namespace — the
 * shape that makes exceljs throw.
 * @returns {Buffer}
 */
function strictWorkbook() {
  const ns = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
  return buildZip({
    'xl/workbook.xml':
      `<?xml version="1.0"?><x:workbook xmlns:x="${ns}" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships">` +
      `<x:sheets><x:sheet name="用例" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      `<?xml version="1.0"?><x:sst xmlns:x="${ns}" count="4" uniqueCount="4">` +
      '<x:si><x:t>用例ID</x:t></x:si><x:si><x:t>用例标题</x:t></x:si>' +
      '<x:si><x:r><x:t>操作</x:t></x:r><x:r><x:t>步骤</x:t></x:r></x:si>' +
      '<x:si><x:t>登录 &amp; 退出</x:t></x:si></x:sst>',
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0"?><x:worksheet xmlns:x="${ns}"><x:sheetData>` +
      '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row>' +
      '<x:row r="3"><x:c r="A3" t="s"><x:v>3</x:v></x:c><x:c r="B3" t="inlineStr"><x:is><x:t>内联文本</x:t></x:is></x:c>' +
      '<x:c r="C3" t="s"><x:v>2</x:v></x:c></x:row>' +
      '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="C3:C4"/></x:mergeCells></x:worksheet>',
  });
}

describe('container sniffing', () => {
  it('recognises a ZIP by its magic bytes, not its extension', () => {
    assert.equal(sniffFormat(buildZip({ 'a.txt': 'x' })), 'zip');
  });

  it('recognises HTML and delimited text', () => {
    assert.equal(sniffFormat(Buffer.from('<!DOCTYPE html><table><tr><td>x</td></tr></table>')), 'html');
    assert.equal(sniffFormat(Buffer.from('\uFEFF用例ID,用例标题\nTC-001,登录\n')), 'text');
    assert.equal(sniffFormat(Buffer.alloc(0)), 'unknown');
  });
});

describe('built-in xlsx reader', () => {
  it('lists ZIP entries', () => {
    const entries = readZipEntries(buildZip({ 'xl/workbook.xml': '<x/>' }));
    assert.deepEqual(entries.map((entry) => entry.name), ['xl/workbook.xml']);
  });

  it('decodes XML entities, including numeric ones', () => {
    assert.equal(decodeXmlText('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
  });

  it('maps cell references to column indexes', () => {
    assert.equal(columnIndex('A1'), 0);
    assert.equal(columnIndex('B7'), 1);
    assert.equal(columnIndex('AA3'), 26);
    assert.equal(columnIndex('12'), -1);
  });

  it('reads shared strings and joins rich-text runs', () => {
    const xml = '<sst><si><t>甲</t></si><si><r><t>乙</t></r><r><t>丙</t></r></si></sst>';
    assert.deepEqual(parseSharedStrings(xml), ['甲', '乙丙']);
  });

  it('ignores phonetic runs that are not cell content', () => {
    const xml = '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si></sst>';
    assert.deepEqual(parseSharedStrings(xml), ['東京']);
  });

  it('reads the sheet list regardless of namespace prefix', () => {
    const sheets = parseWorkbookSheets('<x:workbook><x:sheets><x:sheet name="一" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>');
    assert.deepEqual(sheets, [{ name: '一', sheetId: '1', relId: 'rId1', state: '' }]);
  });

  it('places sparse cells and rows at their declared positions', () => {
    const xml =
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>' +
      '<row r="2"><c r="B2"><v>2</v></c></row>' +
      '</sheetData></worksheet>';
    assert.deepEqual(parseWorksheet(xml), [['1', '', '3'], ['', '2']]);
  });

  it('reads booleans, inline strings and formula results', () => {
    const xml =
      '<worksheet><sheetData><row r="1">' +
      '<c r="A1" t="b"><v>1</v></c>' +
      '<c r="B1" t="inlineStr"><is><t>直接</t></is></c>' +
      '<c r="C1" t="str"><f>CONCAT(1)</f><v>计算结果</v></c>' +
      '<c r="D1" t="e"><v>#REF!</v></c>' +
      '</row></sheetData></worksheet>';
    assert.deepEqual(parseWorksheet(xml), [['TRUE', '直接', '计算结果', '']]);
  });

  it('fills merged ranges from their master cell', () => {
    const xml =
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>登录模块</t></is></c></row>' +
      '<row r="2"><c r="B2"><v>1</v></c></row>' +
      '</sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>';
    assert.deepEqual(parseWorksheet(xml), [['登录模块'], ['登录模块', '1']]);
  });

  it('opens a workbook that breaks exceljs', () => {
    const result = readXlsxNative(strictWorkbook(), {});
    assert.deepEqual(result.sheets, ['用例']);
    assert.equal(result.sheet, '用例');
    assert.deepEqual(result.rows[0], ['用例ID', '', '用例标题']);
    assert.deepEqual(result.rows[2], ['登录 & 退出', '内联文本', '操作步骤']);
    // Merged C3:C4 fills the row below it.
    assert.equal(result.rows[3][2], '操作步骤');
  });

  it('honours an explicit sheet name and reports the available ones', () => {
    assert.throws(() => readXlsxNative(strictWorkbook(), { sheet: '不存在' }), /可用工作表：用例/);
  });

  it('explains what is missing when the archive holds no workbook', () => {
    const ods = buildZip({ 'content.xml': '<office:document/>' });
    assert.throws(() => readXlsxNative(ods, {}), /没有 xl\/workbook\.xml/);
  });

  it('reads the shipped template identically to the CSV one', async () => {
    const buffer = fs.readFileSync(path.join(process.cwd(), 'skill', 'assets', 'case-template.xlsx'));
    const native = readXlsxNative(buffer, {});
    const csv = parseCsv(fs.readFileSync(path.join(process.cwd(), 'skill', 'assets', 'case-template.csv'), 'utf8'));
    assert.deepEqual(native.rows[0], csv[0]);
    assert.equal(native.rows.length, csv.length);
  });
});

describe('readRows fallbacks', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-sheet-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the built-in reader when exceljs cannot open the file', async () => {
    const file = path.join(dir, 'strict.xlsx');
    fs.writeFileSync(file, strictWorkbook());
    const result = await readRows(file, { home: path.join(dir, 'no-toolchain') });
    assert.equal(result.strategy, 'native-xlsx');
    assert.equal(result.format, 'xlsx');
    assert.equal(result.rows[0][0], '用例ID');
    assert.ok(result.warnings.some((warning) => warning.includes('内置读取器')));
  });

  it('parses an HTML table that was saved with an .xlsx name', async () => {
    const file = path.join(dir, 'html.xlsx');
    fs.writeFileSync(
      file,
      '<html><body><table><tr><th>用例标题</th><th>操作步骤</th></tr><tr><td>登录</td><td>打开页面</td></tr></table></body></html>',
    );
    const result = await readRows(file, {});
    assert.equal(result.strategy, 'html-table');
    assert.deepEqual(result.rows[1], ['登录', '打开页面']);
    assert.ok(result.warnings.some((warning) => warning.includes('HTML')));
  });

  it('parses delimited text that was saved with an .xlsx name', async () => {
    const file = path.join(dir, 'text.xlsx');
    fs.writeFileSync(file, '用例标题,操作步骤\n登录,打开页面\n');
    const result = await readRows(file, {});
    assert.equal(result.strategy, 'delimited-text');
    assert.deepEqual(result.rows[0], ['用例标题', '操作步骤']);
  });

  it('reports a format compatibility problem, not a content problem', async () => {
    const file = path.join(dir, 'broken.xlsx');
    fs.writeFileSync(file, Buffer.from('PK\x03\x04 not really a zip'));
    await assert.rejects(
      () => readRows(file, {}),
      (error) => {
        assert.ok(error instanceof SpreadsheetFormatError);
        assert.equal(error.kind, 'format-incompatible');
        assert.match(error.message, /用例文件格式兼容问题/);
        assert.match(error.message, /而不是用例内容有误/);
        assert.ok(error.hint.includes('另存为 .csv'));
        assert.ok(error.attempts.length >= 1);
        return true;
      },
    );
  });

  it('still reads plain CSV and Markdown', async () => {
    const csv = path.join(dir, 'cases.csv');
    fs.writeFileSync(csv, '用例标题,操作步骤\n登录,打开页面\n');
    assert.equal((await readRows(csv, {})).strategy, 'delimited-text');

    const markdown = path.join(dir, 'cases.md');
    fs.writeFileSync(markdown, '| 用例标题 | 操作步骤 |\n| --- | --- |\n| 登录 | 打开页面 |\n');
    assert.equal((await readRows(markdown, {})).strategy, 'markdown-table');
  });
});

describe('HTML table reader', () => {
  it('expands colspan so later columns stay aligned', () => {
    const html = '<table><tr><td colspan="2">合并</td><td>c</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>';
    assert.deepEqual(readHtmlTable(html)[0], ['合并', '合并', 'c']);
  });

  it('turns <br> into a newline so multi-line steps survive', () => {
    assert.deepEqual(readHtmlTable('<table><tr><td>a<br>b</td></tr></table>'), [['a\nb']]);
  });

  it('picks the widest table when a page has layout tables', () => {
    const html =
      '<table><tr><td>nav</td></tr></table>' +
      '<table><tr><td>用例标题</td><td>操作步骤</td><td>预期结果</td></tr></table>';
    assert.equal(readHtmlTable(html)[0].length, 3);
  });

  it('explains an HTML file with no table', () => {
    assert.throws(() => readHtmlTable('<html><body>hi</body></html>'), /没有找到 <table>/);
  });
});

describe('csv writer', () => {
  it('quotes fields containing delimiters, quotes and newlines', () => {
    const text = stringifyCsv([['a,b', 'he said "hi"', 'x\ny']]);
    assert.ok(text.includes('"a,b"'));
    assert.ok(text.includes('"he said ""hi"""'));
    assert.ok(text.includes('"x\ny"'));
  });

  it('round-trips through the parser', () => {
    const rows = compactRows([
      ['用例ID', '用例标题', '操作步骤'],
      ['TC-001', '登录,退出', '打开页面\n点击登录'],
    ]);
    assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
  });
});
