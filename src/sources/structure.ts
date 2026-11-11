export interface StructureHeading {
  level: number;
  text: string;
  /** 0-based line index. */
  line: number;
}

export interface StructureTable {
  /** 0-based line index of the header row. */
  startLine: number;
  headers: string[];
  rows: string[][];
}

export interface SourceStructure {
  headings: StructureHeading[];
  tables: StructureTable[];
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  if (line.trimStart().startsWith('|')) cells.shift();
  if (line.trimEnd().endsWith('|') && !line.trimEnd().endsWith('\\|')) cells.pop();
  return cells.map((c) => c.trim());
}

/**
 * Pure and read-only: reports the headings and Markdown tables found in `text`. It never rewrites, trims or
 * flattens the source; callers keep the original text for verbatim verification. Not a full Markdown parser:
 * ATX and setext headings and pipe tables only. Linear in the input size.
 */
export function parseSourceStructure(text: string): SourceStructure {
  const lines = text.split(/\r\n|\r|\n/);
  const headings: StructureHeading[] = [];
  const tables: StructureTable[] = [];
  let fenced = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const atx = ATX.exec(line);
    if (atx) {
      headings.push({ level: atx[1]?.length ?? 1, text: atx[2] ?? '', line: i });
      continue;
    }

    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && next.includes('-') && SEPARATOR.test(next)) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const r = lines[j] ?? '';
        if (r.trim() === '' || !r.includes('|')) break;
        rows.push(splitRow(r));
        j += 1;
      }
      tables.push({ startLine: i, headers, rows });
      i = j - 1;
      continue;
    }

    if (next !== undefined && line.trim() !== '' && !line.includes('|')) {
      const s = SETEXT.exec(next);
      if (s && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        headings.push({ level: s[1]?.startsWith('=') ? 1 : 2, text: line.trim(), line: i });
        i += 1;
      }
    }
  }
  return { headings, tables };
}
