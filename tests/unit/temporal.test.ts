import { describe, expect, it } from 'vitest';
import type { DayInterval } from '../../src/shared/temporal.js';
import type { TemporalExpression, TemporalMention } from '../../src/shared/understanding.js';
import { DefaultTemporalResolver, InvalidTimezoneError } from '../../src/temporal/resolver.js';

const resolver = new DefaultTemporalResolver();
const HOUR = 3_600_000;

function mention(
  expr: TemporalExpression,
  role: TemporalMention['role'] = 'reference_conversation',
) {
  return { text: JSON.stringify(expr), expr, role } satisfies TemporalMention;
}

function resolveOne(expr: TemporalExpression, tz: string, now: number) {
  const out = resolver.resolve([mention(expr)], tz, now);
  expect(out).toHaveLength(1);
  return out[0]!;
}

function dates(c: DayInterval[]): string[] {
  return c.map((d) => d.localDate);
}

/** Independent check: the local calendar date of an instant, straight from Intl, not from the resolver. */
function localDateOf(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
  return parts; // en-CA is YYYY-MM-DD
}

/** 2026-11-11 is a Wednesday. 15:00 UTC is still the 11th in every zone used with it unless stated. */
const WED_NOV_11 = Date.UTC(2026, 10, 11, 15, 0, 0);

describe('T-TEMP-01: simple relative days', () => {
  it('today, yesterday and days_ago are local calendar days', () => {
    const today = resolveOne({ kind: 'today' }, 'UTC', WED_NOV_11);
    expect(today.status).toBe('resolved');
    expect(dates(today.candidates)).toEqual(['2026-11-11']);
    expect(today.candidates[0]).toEqual({
      startMs: Date.UTC(2026, 10, 11),
      endMs: Date.UTC(2026, 10, 12),
      localDate: '2026-11-11',
      tz: 'UTC',
    });
    expect(dates(resolveOne({ kind: 'yesterday' }, 'UTC', WED_NOV_11).candidates)).toEqual([
      '2026-11-10',
    ]);
    expect(dates(resolveOne({ kind: 'days_ago', n: 0 }, 'UTC', WED_NOV_11).candidates)).toEqual([
      '2026-11-11',
    ]);
    expect(dates(resolveOne({ kind: 'days_ago', n: 3 }, 'UTC', WED_NOV_11).candidates)).toEqual([
      '2026-11-08',
    ]);
  });

  it('returns one result per mention, in input order, and nothing for no mentions', () => {
    expect(resolver.resolve([], 'UTC', WED_NOV_11)).toEqual([]);
    const out = resolver.resolve(
      [mention({ kind: 'yesterday' }), mention({ kind: 'today' })],
      'UTC',
      WED_NOV_11,
    );
    expect(out.map((r) => r.candidates[0]?.localDate)).toEqual(['2026-11-10', '2026-11-11']);
  });
});

describe('T-TEMP-02: last <weekday> gives two candidates and is ambiguous', () => {
  it('on a Wednesday, last Tuesday is yesterday or the Tuesday before', () => {
    const r = resolveOne({ kind: 'weekday', weekday: 2, modifier: 'last' }, 'UTC', WED_NOV_11);
    expect(r.status).toBe('ambiguous');
    expect(dates(r.candidates)).toEqual(['2026-11-10', '2026-11-03']);
  });

  it('on the same weekday, last Wednesday is a week ago or two weeks ago, never today', () => {
    const r = resolveOne({ kind: 'weekday', weekday: 3, modifier: 'last' }, 'UTC', WED_NOV_11);
    expect(r.status).toBe('ambiguous');
    expect(dates(r.candidates)).toEqual(['2026-11-04', '2026-10-28']);
  });

  it('on a Monday, last Sunday is yesterday or the Sunday before', () => {
    const mon = Date.UTC(2026, 10, 9, 12);
    const r = resolveOne({ kind: 'weekday', weekday: 7, modifier: 'last' }, 'UTC', mon);
    expect(dates(r.candidates)).toEqual(['2026-11-08', '2026-11-01']);
  });
});

describe('T-TEMP-03: every weekday x every modifier, over a full week of "today"', () => {
  const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
  const days = [0, 1, 2, 3, 4, 5, 6]; // Mon 2026-11-09 .. Sun 2026-11-15

  for (const todayOffset of days) {
    const now = Date.UTC(2026, 10, 9 + todayOffset, 12);
    const todayWeekday = todayOffset + 1;
    for (const weekday of weekdays) {
      it(`today is ISO weekday ${todayWeekday}; weekday ${weekday}: none, last, this`, () => {
        const ago = (todayWeekday - weekday + 7) % 7; // days back to the most recent occurrence, 0 = today
        const fmt = (back: number) => new Date(now - back * 24 * HOUR).toISOString().slice(0, 10);

        const none = resolveOne({ kind: 'weekday', weekday, modifier: 'none' }, 'UTC', now);
        if (ago === 0) {
          expect(none.status).toBe('ambiguous');
          expect(dates(none.candidates)).toEqual([fmt(0), fmt(7)]);
        } else {
          expect(none.status).toBe('resolved');
          expect(dates(none.candidates)).toEqual([fmt(ago)]);
        }

        const last = resolveOne({ kind: 'weekday', weekday, modifier: 'last' }, 'UTC', now);
        const prev = ago === 0 ? 7 : ago;
        expect(last.status).toBe('ambiguous');
        expect(dates(last.candidates)).toEqual([fmt(prev), fmt(prev + 7)]);

        // "this <weekday>" is the occurrence in the current Monday-to-Sunday week
        const thisWeek = resolveOne({ kind: 'weekday', weekday, modifier: 'this' }, 'UTC', now);
        const offsetInWeek = weekday - 1 - todayOffset; // negative = earlier this week
        const thisDate = new Date(now + offsetInWeek * 24 * HOUR).toISOString().slice(0, 10);
        if (offsetInWeek <= 0) {
          expect(thisWeek.status).toBe('resolved');
          expect(dates(thisWeek.candidates)).toEqual([thisDate]);
        } else {
          // in the future: ambiguous, so the agent asks. Both readings are offered.
          expect(thisWeek.status).toBe('ambiguous');
          expect(dates(thisWeek.candidates)).toEqual([thisDate, fmt(7 - offsetInWeek)]);
        }
      });
    }
  }
});

describe('T-TEMP-04: calendar dates', () => {
  it('a bare day and month is the most recent occurrence that is not in the future', () => {
    expect(
      dates(resolveOne({ kind: 'calendar_date', day: 3, month: 11 }, 'UTC', WED_NOV_11).candidates),
    ).toEqual(['2026-11-03']);
    // today counts
    expect(
      dates(
        resolveOne({ kind: 'calendar_date', day: 11, month: 11 }, 'UTC', WED_NOV_11).candidates,
      ),
    ).toEqual(['2026-11-11']);
    // tomorrow's date has not occurred this year yet, so it is last year's
    expect(
      dates(
        resolveOne({ kind: 'calendar_date', day: 12, month: 11 }, 'UTC', WED_NOV_11).candidates,
      ),
    ).toEqual(['2025-11-12']);
  });

  it('an explicit year is used as given, including a future date', () => {
    const r = resolveOne(
      { kind: 'calendar_date', day: 3, month: 11, year: 2027 },
      'UTC',
      WED_NOV_11,
    );
    expect(r.status).toBe('resolved');
    expect(dates(r.candidates)).toEqual(['2027-11-03']);
  });

  it('a date that does not exist is unresolved, not rolled over', () => {
    for (const expr of [
      { kind: 'calendar_date', day: 31, month: 2 },
      { kind: 'calendar_date', day: 29, month: 2, year: 2027 },
      { kind: 'calendar_date', day: 0, month: 5 },
      { kind: 'calendar_date', day: 5, month: 13 },
      { kind: 'calendar_date', day: 1.5, month: 5 },
    ] as const) {
      const r = resolveOne(expr, 'UTC', WED_NOV_11);
      expect(r.status, JSON.stringify(expr)).toBe('unresolved');
      expect(r.candidates).toEqual([]);
    }
  });

  it('29 February with no year is the most recent leap day', () => {
    const now = Date.UTC(2026, 2, 1, 12);
    expect(
      dates(resolveOne({ kind: 'calendar_date', day: 29, month: 2 }, 'UTC', now).candidates),
    ).toEqual(['2024-02-29']);
  });
});

describe('T-TEMP-05: last_week and since', () => {
  it('last_week is the previous Monday-to-Sunday week, seven consecutive days', () => {
    const r = resolveOne({ kind: 'last_week' }, 'UTC', WED_NOV_11);
    expect(r.status).toBe('resolved');
    expect(dates(r.candidates)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('last_week on a Monday is the week that just ended', () => {
    const mon = Date.UTC(2026, 10, 9, 0, 30);
    expect(dates(resolveOne({ kind: 'last_week' }, 'UTC', mon).candidates)[0]).toBe('2026-11-02');
  });

  it('since resolves its anchor and keeps the anchor status, with the change_since role', () => {
    const r = resolver.resolve(
      [mention({ kind: 'since', anchor: { kind: 'days_ago', n: 7 } }, 'change_since')],
      'UTC',
      WED_NOV_11,
    )[0]!;
    expect(r.status).toBe('resolved');
    expect(dates(r.candidates)).toEqual(['2026-11-04']);
    expect(r.mention.role).toBe('change_since');

    const amb = resolveOne(
      { kind: 'since', anchor: { kind: 'weekday', weekday: 2, modifier: 'last' } },
      'UTC',
      WED_NOV_11,
    );
    expect(amb.status).toBe('ambiguous');
    expect(dates(amb.candidates)).toEqual(['2026-11-10', '2026-11-03']);
  });
});

describe('T-TEMP-06: untrusted values never throw and never invent a day', () => {
  it('rejects out-of-range or non-integer values as unresolved', () => {
    const bad = [
      { kind: 'days_ago', n: -1 },
      { kind: 'days_ago', n: 1.5 },
      { kind: 'days_ago', n: Number.NaN },
      { kind: 'days_ago', n: 1e9 },
      { kind: 'weekday', weekday: 0, modifier: 'last' },
      { kind: 'weekday', weekday: 8, modifier: 'none' },
      { kind: 'weekday', weekday: 2, modifier: 'next' },
      { kind: 'since', anchor: { kind: 'since', anchor: { kind: 'today' } } },
      { kind: 'tomorrow' },
    ] as unknown as TemporalExpression[];
    for (const expr of bad) {
      const r = resolveOne(expr, 'UTC', WED_NOV_11);
      expect(r.status, JSON.stringify(expr)).toBe('unresolved');
      expect(r.candidates).toEqual([]);
    }
  });

  it('an unknown timezone or a non-finite clock is an error, not a silent "no record"', () => {
    expect(() =>
      resolver.resolve([mention({ kind: 'today' })], 'Mars/Olympus', WED_NOV_11),
    ).toThrow(InvalidTimezoneError);
    expect(() => resolver.resolve([mention({ kind: 'today' })], '', WED_NOV_11)).toThrow(
      InvalidTimezoneError,
    );
    expect(() => resolver.resolve([mention({ kind: 'today' })], 'UTC', Number.NaN)).toThrow(
      RangeError,
    );
    // no mentions: still validated, so a bad zone is not hidden by an empty list
    expect(() => resolver.resolve([], 'Mars/Olympus', WED_NOV_11)).toThrow(InvalidTimezoneError);
  });

  it('is deterministic: the same input gives the same output', () => {
    const m = [mention({ kind: 'weekday', weekday: 2, modifier: 'last' })];
    expect(resolver.resolve(m, 'America/New_York', WED_NOV_11)).toEqual(
      resolver.resolve(m, 'America/New_York', WED_NOV_11),
    );
  });
});

describe('T-TEMP-07: local days are bounded by the local clock, per timezone', () => {
  it('the same instant is a different "today" in different zones', () => {
    const now = Date.UTC(2026, 10, 11, 23, 30); // Wed 23:30 UTC
    expect(dates(resolveOne({ kind: 'today' }, 'UTC', now).candidates)).toEqual(['2026-11-11']);
    expect(dates(resolveOne({ kind: 'today' }, 'Asia/Tokyo', now).candidates)).toEqual([
      '2026-11-12',
    ]);
    expect(dates(resolveOne({ kind: 'today' }, 'America/Los_Angeles', now).candidates)).toEqual([
      '2026-11-11',
    ]);
    expect(dates(resolveOne({ kind: 'yesterday' }, 'Asia/Tokyo', now).candidates)).toEqual([
      '2026-11-11',
    ]);
  });

  it('interval boundaries match the zone offset, including half-hour and 45-minute zones', () => {
    const cases: Array<[string, number]> = [
      ['UTC', 0],
      ['Asia/Kolkata', 5.5 * HOUR],
      ['Asia/Kathmandu', 5.75 * HOUR],
      ['America/New_York', -5 * HOUR], // EST in November
      ['Pacific/Kiritimati', 14 * HOUR],
      ['Pacific/Pago_Pago', -11 * HOUR],
    ];
    for (const [tz, offset] of cases) {
      const d = resolveOne({ kind: 'calendar_date', day: 3, month: 11, year: 2026 }, tz, WED_NOV_11)
        .candidates[0]!;
      expect(d.startMs, tz).toBe(Date.UTC(2026, 10, 3) - offset);
      expect(d.endMs, tz).toBe(Date.UTC(2026, 10, 4) - offset);
      expect(d.tz).toBe(tz);
    }
  });
});

describe('T-TEMP-08: daylight saving changes the length of a day, not its date', () => {
  it('America/New_York spring forward is a 23-hour day', () => {
    const d = resolveOne(
      { kind: 'calendar_date', day: 8, month: 3, year: 2026 },
      'America/New_York',
      WED_NOV_11,
    ).candidates[0]!;
    expect(d.startMs).toBe(Date.UTC(2026, 2, 8, 5));
    expect(d.endMs).toBe(Date.UTC(2026, 2, 9, 4));
    expect(d.endMs - d.startMs).toBe(23 * HOUR);
  });

  it('America/New_York fall back is a 25-hour day', () => {
    const d = resolveOne(
      { kind: 'calendar_date', day: 1, month: 11, year: 2026 },
      'America/New_York',
      WED_NOV_11,
    ).candidates[0]!;
    expect(d.startMs).toBe(Date.UTC(2026, 10, 1, 4));
    expect(d.endMs).toBe(Date.UTC(2026, 10, 2, 5));
    expect(d.endMs - d.startMs).toBe(25 * HOUR);
  });

  it('Europe/London, one hour off in summer, in both directions', () => {
    const start = resolveOne(
      { kind: 'calendar_date', day: 29, month: 3, year: 2026 },
      'Europe/London',
      WED_NOV_11,
    ).candidates[0]!;
    expect(start.endMs - start.startMs).toBe(23 * HOUR);
    const end = resolveOne(
      { kind: 'calendar_date', day: 25, month: 10, year: 2026 },
      'Europe/London',
      WED_NOV_11,
    ).candidates[0]!;
    expect(end.endMs - end.startMs).toBe(25 * HOUR);
  });

  it('Australia/Lord_Howe shifts by 30 minutes, so its days are 23.5 and 24.5 hours', () => {
    const forward = resolveOne(
      { kind: 'calendar_date', day: 4, month: 10, year: 2026 },
      'Australia/Lord_Howe',
      WED_NOV_11,
    ).candidates[0]!;
    expect(forward.endMs - forward.startMs).toBe(23.5 * HOUR);
    const back = resolveOne(
      { kind: 'calendar_date', day: 5, month: 4, year: 2026 },
      'Australia/Lord_Howe',
      WED_NOV_11,
    ).candidates[0]!;
    expect(back.endMs - back.startMs).toBe(24.5 * HOUR);
  });

  it('consecutive days tile the timeline with no gap and no overlap across a transition', () => {
    const r = resolveOne({ kind: 'last_week' }, 'America/New_York', Date.UTC(2026, 10, 4, 12));
    // the week of 26 Oct to 1 Nov contains the fall-back on Sunday 1 Nov
    expect(dates(r.candidates)[6]).toBe('2026-11-01');
    for (let i = 1; i < r.candidates.length; i += 1) {
      expect(r.candidates[i]!.startMs).toBe(r.candidates[i - 1]!.endMs);
    }
    const total = r.candidates[6]!.endMs - r.candidates[0]!.startMs;
    expect(total).toBe(7 * 24 * HOUR + HOUR);
  });

  it('a day whose midnight does not exist starts at the first instant of that date', () => {
    // Zones that skip local midnight (Beirut, Asuncion, ...). The dates are checked independently of
    // the resolver: the interval must begin at the first instant that has the target date.
    const checks: Array<[string, number, number, number]> = [
      ['Asia/Beirut', 2026, 3, 29],
      ['America/Havana', 2026, 3, 8],
      ['America/Asuncion', 2024, 10, 6],
    ];
    for (const [tz, y, m, d] of checks) {
      const r = resolveOne({ kind: 'calendar_date', day: d, month: m, year: y }, tz, WED_NOV_11);
      if (r.status !== 'resolved') continue; // tzdata without that rule: nothing to check
      const iv = r.candidates[0]!;
      const wanted = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      expect(localDateOf(iv.startMs, tz), `${tz} start`).toBe(wanted);
      expect(localDateOf(iv.startMs - 1, tz), `${tz} instant before start`).not.toBe(wanted);
      expect(localDateOf(iv.endMs - 1, tz), `${tz} last instant`).toBe(wanted);
      expect(localDateOf(iv.endMs, tz), `${tz} end`).not.toBe(wanted);
    }
  });
});

describe('T-TEMP-09: year and month boundaries', () => {
  it('yesterday on 1 January is 31 December of the previous year', () => {
    const now = Date.UTC(2027, 0, 1, 12);
    expect(dates(resolveOne({ kind: 'yesterday' }, 'UTC', now).candidates)).toEqual(['2026-12-31']);
  });

  it('a bare date after the new year looks back into the previous year', () => {
    const now = Date.UTC(2027, 0, 2, 12);
    expect(
      dates(resolveOne({ kind: 'calendar_date', day: 31, month: 12 }, 'UTC', now).candidates),
    ).toEqual(['2026-12-31']);
    expect(
      dates(resolveOne({ kind: 'calendar_date', day: 1, month: 1 }, 'UTC', now).candidates),
    ).toEqual(['2027-01-01']);
    expect(
      dates(resolveOne({ kind: 'calendar_date', day: 3, month: 1 }, 'UTC', now).candidates),
    ).toEqual(['2026-01-03']);
  });

  it('last_week spans the year end', () => {
    const now = Date.UTC(2027, 0, 6, 12); // Wednesday 6 Jan 2027
    const r = resolveOne({ kind: 'last_week' }, 'UTC', now);
    expect(dates(r.candidates)[0]).toBe('2026-12-28');
    expect(dates(r.candidates)[6]).toBe('2027-01-03');
  });

  it('last Tuesday across the year end has one candidate in each year', () => {
    const now = Date.UTC(2027, 0, 1, 12); // Friday
    const r = resolveOne({ kind: 'weekday', weekday: 2, modifier: 'last' }, 'UTC', now);
    expect(dates(r.candidates)).toEqual(['2026-12-29', '2026-12-22']);
  });

  it('days_ago crosses a leap day', () => {
    const now = Date.UTC(2028, 2, 1, 12);
    expect(dates(resolveOne({ kind: 'yesterday' }, 'UTC', now).candidates)).toEqual(['2028-02-29']);
    expect(dates(resolveOne({ kind: 'days_ago', n: 366 }, 'UTC', now).candidates)).toEqual([
      '2027-03-01',
    ]);
  });
});

describe('T-TEMP-10: the local date of "now" decides, not the UTC date', () => {
  it('a new local year can begin before or after the UTC year', () => {
    const now = Date.UTC(2026, 11, 31, 23, 0); // 31 Dec 23:00 UTC
    expect(dates(resolveOne({ kind: 'today' }, 'UTC', now).candidates)).toEqual(['2026-12-31']);
    expect(dates(resolveOne({ kind: 'today' }, 'Pacific/Auckland', now).candidates)).toEqual([
      '2027-01-01',
    ]);
    expect(dates(resolveOne({ kind: 'yesterday' }, 'Pacific/Auckland', now).candidates)).toEqual([
      '2026-12-31',
    ]);
    expect(
      dates(
        resolveOne({ kind: 'calendar_date', day: 1, month: 1 }, 'Pacific/Auckland', now).candidates,
      ),
    ).toEqual(['2027-01-01']);
  });

  it('weekday resolution uses the local weekday of "now"', () => {
    const now = Date.UTC(2026, 10, 11, 23, 30); // Wed UTC, Thursday 12 Nov in Tokyo
    const r = resolveOne({ kind: 'weekday', weekday: 4, modifier: 'last' }, 'Asia/Tokyo', now);
    expect(dates(r.candidates)).toEqual(['2026-11-05', '2026-10-29']); // today is Thursday there
  });
});

describe('T-TEMP-11: a day that does not exist in a zone', () => {
  it('Samoa skipped 30 December 2011: asking for it is unresolved, and its neighbours are intact', () => {
    const skipped = resolveOne(
      { kind: 'calendar_date', day: 30, month: 12, year: 2011 },
      'Pacific/Apia',
      WED_NOV_11,
    );
    if (localDateOf(Date.UTC(2011, 11, 30, 12), 'Pacific/Apia') === '2011-12-30') {
      // tzdata without the transition: nothing special to assert
      expect(skipped.status).toBe('resolved');
    } else {
      expect(skipped.status).toBe('unresolved');
      expect(skipped.candidates).toEqual([]);
      const next = resolveOne(
        { kind: 'calendar_date', day: 31, month: 12, year: 2011 },
        'Pacific/Apia',
        WED_NOV_11,
      );
      expect(next.status).toBe('resolved');
      expect(next.candidates[0]!.endMs - next.candidates[0]!.startMs).toBe(24 * HOUR);
    }
  });
});

describe('T-TEMP-12: the half-open interval contains exactly the local day', () => {
  it('for a spread of zones, the first and last millisecond are in the day and the neighbours are not', () => {
    const zones = [
      'UTC',
      'America/New_York',
      'America/Los_Angeles',
      'Europe/Berlin',
      'Asia/Kolkata',
      'Asia/Tokyo',
      'Australia/Sydney',
      'Pacific/Auckland',
      'Africa/Cairo',
      'America/Sao_Paulo',
    ];
    const probes = [
      { kind: 'calendar_date', day: 8, month: 3, year: 2026 },
      { kind: 'calendar_date', day: 1, month: 11, year: 2026 },
      { kind: 'calendar_date', day: 29, month: 3, year: 2026 },
      { kind: 'calendar_date', day: 4, month: 10, year: 2026 },
      { kind: 'calendar_date', day: 31, month: 12, year: 2026 },
    ] as const;
    for (const tz of zones) {
      for (const expr of probes) {
        const r = resolveOne(expr, tz, WED_NOV_11);
        expect(r.status, `${tz} ${JSON.stringify(expr)}`).toBe('resolved');
        const iv = r.candidates[0]!;
        const wanted = iv.localDate;
        expect(localDateOf(iv.startMs, tz), `${tz} start of ${wanted}`).toBe(wanted);
        expect(localDateOf(iv.startMs - 1, tz), `${tz} before ${wanted}`).not.toBe(wanted);
        expect(localDateOf(iv.endMs - 1, tz), `${tz} last ms of ${wanted}`).toBe(wanted);
        expect(localDateOf(iv.endMs, tz), `${tz} after ${wanted}`).not.toBe(wanted);
      }
    }
  });
});
