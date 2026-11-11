import type { IanaTz, Ms } from '../shared/ids.js';
import type { DayInterval, ResolvedTemporal, TemporalResolver } from '../shared/temporal.js';
import type { TemporalMention } from '../shared/understanding.js';

/**
 * Turns structured date expressions (extracted by the model) into local calendar days (architecture §8,
 * ADR-07). All date arithmetic is deterministic code; the model never computes a date.
 *
 * Rules, each covered by T-TEMP-01..12:
 *  - A day is the half-open UTC interval [start, end) of one local calendar day, so a day can be 23, 24
 *    or 25 hours (or 23.5 / 24.5) long. Its start is the first instant that has that local date, which
 *    also handles zones that skip local midnight.
 *  - `today` and `yesterday` are relative to the local date of `now` in the given zone.
 *  - `last <weekday>` has two candidates, the most recent occurrence strictly before today and the one a
 *    week earlier, and is `ambiguous`: stored data decides which one the user meant.
 *  - A bare `<weekday>` is the most recent occurrence up to and including today; on that very weekday
 *    it is ambiguous between today and a week ago, because the spec does not say which is meant.
 *  - `this <weekday>` is the occurrence in the current Monday-to-Sunday week; when that is still in the
 *    future it is `ambiguous` (the agent asks), offered with the previous week's occurrence.
 *  - A bare `<day> <month>` is the most recent occurrence not in the future; an explicit year is used as
 *    given. A date that does not exist (31 February, a day a zone skipped) is `unresolved`, never rolled over.
 *  - `last_week` is the previous Monday-to-Sunday week: seven consecutive days, all `resolved` (a union).
 *  - `since` resolves its anchor and keeps the anchor's candidates and status; the open-ended range is
 *    the consumer's to build from the earliest candidate's `startMs`.
 *
 * Values come from model output, so every field is re-checked here; a bad value is `unresolved` with no
 * candidates. An unknown time zone or a non-finite clock is a caller bug and throws.
 */

export class InvalidTimezoneError extends Error {
  constructor(public readonly tz: string) {
    super(`unknown IANA time zone: ${JSON.stringify(tz)}`);
    this.name = 'InvalidTimezoneError';
  }
}

const MS_PER_DAY = 86_400_000;
const SCAN_STEP_MS = 15 * 60_000;
const MAX_DAYS_AGO = 36_500;
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;
const MAX_LOOKBACK_YEARS = 8;

/** A calendar date with no time zone attached. Compared through `epochDay` and `key`. */
interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: IanaTz): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
  } catch {
    throw new InvalidTimezoneError(tz);
  }
  if (tz.trim() === '') throw new InvalidTimezoneError(tz);
  formatters.set(tz, created);
  return created;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function epochDay(c: Civil): number {
  return Math.round(Date.UTC(c.year, c.month - 1, c.day) / MS_PER_DAY);
}

function fromEpochDay(days: number): Civil {
  const d = new Date(days * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addDays(c: Civil, n: number): Civil {
  return fromEpochDay(epochDay(c) + n);
}

/** ISO weekday: Monday 1 .. Sunday 7. Epoch day 0 (1970-01-01) was a Thursday. */
function isoWeekday(c: Civil): number {
  return ((((epochDay(c) + 3) % 7) + 7) % 7) + 1;
}

function key(c: Civil): number {
  return c.year * 10_000 + c.month * 100 + c.day;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (![year, month, day].every(isInt)) return false;
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const back = fromEpochDay(epochDay({ year, month, day }));
  return back.year === year && back.month === month && back.day === day;
}

function localCivil(ms: Ms, tz: IanaTz): Civil {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatterFor(tz).formatToParts(ms)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

/**
 * The first instant whose local date is on or after `c`. Scans in 15-minute steps (every real offset and
 * transition is a whole number of minutes), then bisects the last step to the millisecond.
 */
function firstInstantOnOrAfter(c: Civil, tz: IanaTz): Ms {
  const target = key(c);
  const guess = Date.UTC(c.year, c.month - 1, c.day);
  let lo = guess - 16 * 3_600_000; // earlier than local midnight in every zone (max offset is +14 h)
  while (key(localCivil(lo, tz)) >= target) lo -= SCAN_STEP_MS;
  const limit = guess + 14 * 3_600_000; // later than local midnight in every zone (min offset is -12 h)
  let hi = lo + SCAN_STEP_MS;
  while (key(localCivil(hi, tz)) < target) {
    lo = hi;
    hi += SCAN_STEP_MS;
    if (hi > limit)
      throw new RangeError(`no local midnight found near ${c.year}-${c.month}-${c.day}`);
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (key(localCivil(mid, tz)) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function dayInterval(c: Civil, tz: IanaTz): DayInterval | null {
  const startMs = firstInstantOnOrAfter(c, tz);
  if (key(localCivil(startMs, tz)) !== key(c)) return null; // the zone skipped this whole date
  const endMs = firstInstantOnOrAfter(addDays(c, 1), tz);
  return { startMs, endMs, localDate: `${pad(c.year, 4)}-${pad(c.month, 2)}-${pad(c.day, 2)}`, tz };
}

interface Plan {
  readonly status: ResolvedTemporal['status'];
  readonly days: Civil[];
}

const UNRESOLVED: Plan = { status: 'unresolved', days: [] };

function plan(expr: unknown, today: Civil, allowSince: boolean): Plan {
  if (typeof expr !== 'object' || expr === null) return UNRESOLVED;
  const e = expr as Record<string, unknown>;
  const todayIso = isoWeekday(today);

  switch (e['kind']) {
    case 'today':
      return { status: 'resolved', days: [today] };
    case 'yesterday':
      return { status: 'resolved', days: [addDays(today, -1)] };
    case 'days_ago': {
      const n = e['n'];
      if (!isInt(n) || n < 0 || n > MAX_DAYS_AGO) return UNRESOLVED;
      return { status: 'resolved', days: [addDays(today, -n)] };
    }
    case 'weekday': {
      const w = e['weekday'];
      if (!isInt(w) || w < 1 || w > 7) return UNRESOLVED;
      const ago = (todayIso - w + 7) % 7; // days back to the most recent occurrence; 0 means today
      switch (e['modifier']) {
        case 'none':
          return ago === 0
            ? { status: 'ambiguous', days: [today, addDays(today, -7)] }
            : { status: 'resolved', days: [addDays(today, -ago)] };
        case 'last': {
          const back = ago === 0 ? 7 : ago;
          return { status: 'ambiguous', days: [addDays(today, -back), addDays(today, -back - 7)] };
        }
        case 'this': {
          const occurrence = addDays(today, w - todayIso);
          return w <= todayIso
            ? { status: 'resolved', days: [occurrence] }
            : { status: 'ambiguous', days: [occurrence, addDays(occurrence, -7)] };
        }
        default:
          return UNRESOLVED;
      }
    }
    case 'calendar_date': {
      const { day, month } = e as { day?: unknown; month?: unknown };
      if (!isInt(day) || !isInt(month)) return UNRESOLVED;
      const year = e['year'];
      if (year !== undefined) {
        return isRealDate(year as number, month, day)
          ? { status: 'resolved', days: [{ year: year as number, month, day }] }
          : UNRESOLVED;
      }
      for (let y = today.year; y >= today.year - MAX_LOOKBACK_YEARS; y -= 1) {
        if (isRealDate(y, month, day) && key({ year: y, month, day }) <= key(today)) {
          return { status: 'resolved', days: [{ year: y, month, day }] };
        }
      }
      return UNRESOLVED;
    }
    case 'last_week': {
      const thisMonday = addDays(today, 1 - todayIso);
      const days = Array.from({ length: 7 }, (_, i) => addDays(thisMonday, i - 7));
      return { status: 'resolved', days };
    }
    case 'since':
      return allowSince ? plan(e['anchor'], today, false) : UNRESOLVED;
    default:
      return UNRESOLVED;
  }
}

export class DefaultTemporalResolver implements TemporalResolver {
  resolve(mentions: TemporalMention[], tz: IanaTz, now: Ms): ResolvedTemporal[] {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new RangeError('now must be a finite number of epoch milliseconds');
    }
    formatterFor(tz); // validates the zone even when there is nothing to resolve
    const today = localCivil(now, tz);

    return mentions.map((mention) => {
      const p = plan(mention.expr, today, true);
      const candidates: DayInterval[] = [];
      for (const day of p.days) {
        const interval = dayInterval(day, tz);
        if (interval) candidates.push(interval);
      }
      if (candidates.length === 0) return { mention, candidates: [], status: 'unresolved' };
      return { mention, candidates, status: p.status };
    });
  }
}
