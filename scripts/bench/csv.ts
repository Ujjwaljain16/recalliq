/**
 * A small RFC 4180 CSV reader: quoted fields may contain commas, doubled quotes and line breaks. Both `\n`
 * and `\r\n` end a record. Returns every record as an array of raw strings; callers validate the shape.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = input.length;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r' && input[i + 1] === '\n') {
      endRow();
      i += 2;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Turns records into objects keyed by the header row found at `headerIndex`. Rows before the header are
 * skipped; fully blank rows are skipped; a row with a different field count is an error naming its line.
 */
export function recordsWithHeader(
  rows: string[][],
  headerIndex: number,
): Array<Record<string, string>> {
  const header = rows[headerIndex];
  if (header === undefined) throw new Error(`CSV has no header at record ${headerIndex}`);
  const out: Array<Record<string, string>> = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((f) => f.trim() === '')) continue;
    if (row.length !== header.length) {
      throw new Error(`CSV record ${r} has ${row.length} fields, the header has ${header.length}`);
    }
    const obj: Record<string, string> = {};
    header.forEach((name, k) => {
      obj[name] = row[k] ?? '';
    });
    out.push(obj);
  }
  return out;
}
