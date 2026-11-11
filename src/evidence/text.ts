/**
 * Text normalisation and positioning for T1/T2 (architecture R2).
 *
 * Normalisation is deliberately narrow: NFKC, invisible characters, quote and dash folding, whitespace
 * collapsing. It never removes digits, currency symbols, punctuation such as `%` or `/`, negation words or
 * units, so two texts that differ in any of those never compare equal.
 */

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \f\v\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .replace(/ ?\t ?/g, '\t')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export interface Flat {
  flat: string;
  /** flat index -> index in the source string */
  map: number[];
}

/** Collapses every whitespace run to one space, remembering where each character came from. */
export function flatten(s: string): Flat {
  let flat = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (/\s/.test(ch)) {
      if (!inSpace && flat.length > 0) {
        flat += ' ';
        map.push(i);
      }
      inSpace = true;
    } else {
      flat += ch;
      map.push(i);
      inSpace = false;
    }
  }
  if (flat.endsWith(' ')) {
    flat = flat.slice(0, -1);
    map.pop();
  }
  return { flat, map };
}

const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
const CURRENCY_SYMBOL = /[$€£¥₹]/u;

function isWord(c: string | undefined): boolean {
  return c !== undefined && c !== '' && WORD.test(c);
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c !== '' && DIGIT.test(c);
}

export interface Located {
  start: number;
  end: number;
}

/**
 * Finds `needle` in `haystack` (both already normalised) as a verbatim, boundary-respecting match.
 * A quote may not start or end inside a word or a number: "$90" is not found in "$900" or "US$90",
 * and "per user" is not found in "per users".
 */
export function locateVerbatim(haystack: string, needle: string): Located | null {
  const h = flatten(haystack);
  const n = flatten(needle).flat;
  if (n.length === 0) return null;
  let from = 0;
  for (;;) {
    const i = h.flat.indexOf(n, from);
    if (i < 0) return null;
    if (boundaryOk(h.flat, i, i + n.length)) {
      const start = h.map[i];
      const last = h.map[i + n.length - 1];
      if (start === undefined || last === undefined) return null;
      return { start, end: last + 1 };
    }
    from = i + 1;
  }
}

function boundaryOk(text: string, start: number, end: number): boolean {
  const first = text.charAt(start);
  const last = text.charAt(end - 1);
  const prev = start > 0 ? text.charAt(start - 1) : undefined;
  const next = end < text.length ? text.charAt(end) : undefined;
  if (isWord(first) || CURRENCY_SYMBOL.test(first)) {
    if (isWord(prev)) return false;
    if (isDigit(first) && (prev === ',' || prev === '.') && isDigit(text.charAt(start - 2)))
      return false;
  }
  if (isWord(last)) {
    if (isWord(next)) return false;
    if (isDigit(last) && (next === ',' || next === '.') && isDigit(text.charAt(end + 1)))
      return false;
  }
  return true;
}

/** Case-insensitive, word-bounded occurrences of `phrase` in `text`. */
export function findPhrase(text: string, phrase: string): Located[] {
  const p = normalizeText(phrase);
  if (p.length === 0) return [];
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  const out: Located[] = [];
  for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** Number of word tokens between two offsets (table separators and bare punctuation do not count). */
export function tokenDistance(text: string, from: number, to: number): number {
  if (to <= from) return 0;
  return (text.slice(from, to).match(/[\p{L}\p{N}$€£¥₹%][^\s|]*/gu) ?? []).length;
}

export interface Segment extends Located {
  text: string;
  isRow: boolean;
}

function isTableRow(line: string): boolean {
  return (line.match(/\|/g) ?? []).length >= 2 || line.includes('\t');
}

/**
 * Splits at newlines, bullets and sentence boundaries. A table row stays whole: the row is what relates
 * its cells (plan, price, unit) to each other, so cutting at cell separators would separate them.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) {
      if (isTableRow(line)) {
        out.push({ start: lineStart, end: lineStart + line.length, text: line, isRow: true });
      } else {
        const re = /\s+[•·▪◦]\s+|(?<=[.!?])\s+(?=[\p{Lu}$€£¥₹\d])/gu;
        let from = 0;
        for (const m of line.matchAll(re)) {
          if (m.index > from)
            out.push({
              start: lineStart + from,
              end: lineStart + m.index,
              text: line.slice(from, m.index),
              isRow: false,
            });
          from = m.index + m[0].length;
        }
        out.push({
          start: lineStart + from,
          end: lineStart + line.length,
          text: line.slice(from),
          isRow: false,
        });
      }
    }
    lineStart += line.length + 1;
  }
  return out;
}

export function segmentAt(segs: Segment[], index: number): Segment | null {
  return segs.find((s) => index >= s.start && index <= s.end) ?? null;
}

export function splitCells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r
    .replaceAll('\t', '|')
    .split('|')
    .map((c) => c.trim());
}
