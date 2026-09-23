/**
 * Minimal RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled from a dependency so that CSV parsing is
 * fully covered by this repo's own tests and has no transitive install cost.
 */

/**
 * Guess the delimiter from the first non-empty line.
 * @param {string} text
 * @returns {string}
 */
export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    // Count only delimiters outside quotes.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Render a matrix back to CSV.
 *
 * Used to hand back a readable copy of a spreadsheet that only the fallback
 * reader could open, so the user can inspect — and re-use — what the skill saw.
 *
 * @param {string[][]} rows
 * @param {{delimiter?: string}} [options]
 * @returns {string}
 */
export function stringifyCsv(rows, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const escape = (value) => {
    const text = String(value ?? '');
    return /["\r\n]|^\s|\s$/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  // A BOM keeps Excel from mangling the Chinese headers on re-import.
  return `\uFEFF${rows.map((row) => row.map(escape).join(delimiter)).join('\r\n')}\r\n`;
}

/**
 * Parse CSV text into a matrix of strings.
 * @param {string} text
 * @param {{delimiter?: string}} [options]
 * @returns {string[][]}
 */
export function parseCsv(text, options = {}) {
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = options.delimiter ?? detectDelimiter(source);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < source.length) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      if (source[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // Flush whatever is left, unless the file ended on a clean newline.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}
