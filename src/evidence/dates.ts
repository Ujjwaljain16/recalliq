import type { Ms } from '../shared/ids.js';

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const MONTH_RE =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';

export interface ParsedDate {
  ms: Ms;
  precision: 'day' | 'month';
  /** The matched text. */
  text: string;
  index: number;
}

function utc(y: number, m: number, d: number): Ms | null {
  const t = Date.UTC(y, m, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m || back.getUTCDate() !== d)
    return null;
  return t;
}

/**
 * All unambiguous dates in `text`: ISO, "1 December 2026", "December 1, 2026", and month-only
 * "December 2026". Numeric day/month dates ("01/12/2026") are ambiguous and are never parsed.
 * Times are UTC midnight; a date without a year is not parsed.
 */
export function parseDates(text: string): ParsedDate[] {
  const found: ParsedDate[] = [];
  const push = (m: RegExpMatchArray, ms: Ms | null, precision: 'day' | 'month') => {
    if (ms !== null) found.push({ ms, precision, text: m[0], index: m.index ?? 0 });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    push(m, utc(Number(m[1]), Number(m[2]) - 1, Number(m[3])), 'day');
  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const m of text.matchAll(dmy)) {
    const mo = MONTHS[(m[2] ?? '').toLowerCase()];
    if (mo !== undefined) push(m, utc(Number(m[3]), mo, Number(m[1])), 'day');
  }
  const mdy = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(mdy)) {
    const mo = MONTHS[(m[1] ?? '').toLowerCase()];
    if (mo !== undefined) push(m, utc(Number(m[3]), mo, Number(m[2])), 'day');
  }
  const my = new RegExp(`\\b${MONTH_RE}\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(my)) {
    const mo = MONTHS[(m[1] ?? '').toLowerCase()];
    if (mo === undefined) continue;
    if (found.some((f) => m.index >= f.index && m.index < f.index + f.text.length)) continue;
    push(m, utc(Number(m[2]), mo, 1), 'month');
  }
  return found.sort((a, b) => a.index - b.index);
}

/** A cue that says the date is when something takes effect. "published", "updated" and "as of" are not cues. */
const EFFECTIVE_CUE =
  /(?:\beffective(?:\s+(?:from|on))?|\bstarting(?:\s+on)?|\bstarts?(?:\s+on)?|\bbeginning(?:\s+on)?|\bbegins?(?:\s+on)?|\btakes?\s+effect(?:\s+on)?|\bgoes\s+into\s+effect(?:\s+on)?|\bcomes\s+into\s+effect(?:\s+on)?|\bvalid\s+from|\bwill\s+(?:apply|change|increase|rise)\s+(?:on|from))[^0-9]{0,12}$/i;

const PUBLICATION_CUE =
  /(?:\bpublished|\bposted|\bupdated|\blast\s+updated|\bas\s+of|\bmodified)[^0-9]{0,12}$/i;

/** True when an effectiveness cue (and no publication cue) directly precedes the date at `index`. */
export function hasEffectiveCue(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 45), index);
  if (PUBLICATION_CUE.test(before)) return false;
  return EFFECTIVE_CUE.test(before);
}
