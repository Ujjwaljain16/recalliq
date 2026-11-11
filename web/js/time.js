// Friendly dates and durations. Pure: every function takes the time zone (and "now" where it matters), so the
// rules can be tested without a browser.

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(ms, timeZone, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).formatToParts(ms)) {
    out[p.type] = p.value;
  }
  return out;
}

/** Days since the epoch of the calendar date `ms` falls on in `timeZone`. */
function dayNumber(ms, timeZone) {
  const p = parts(ms, timeZone, { year: 'numeric', month: 'numeric', day: 'numeric' });
  return Math.round(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS);
}

/** "15:46" in `timeZone`. */
export function clock(ms, timeZone) {
  const p = parts(ms, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** "9 Nov", or "9 Nov 2025" outside the current year. */
export function shortDate(ms, now, timeZone) {
  const p = parts(ms, timeZone, { day: 'numeric', month: 'short', year: 'numeric' });
  const thisYear = parts(now, timeZone, { year: 'numeric' }).year;
  return p.year === thisYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/** The sidebar stamp: "Today 15:46", "Yesterday", "Mon 9 Nov" or "9 Nov 2025". */
export function listStamp(ms, now, timeZone) {
  const days = dayNumber(now, timeZone) - dayNumber(ms, timeZone);
  if (days <= 0) return `Today ${clock(ms, timeZone)}`;
  if (days === 1) return 'Yesterday';
  const p = parts(ms, timeZone, { weekday: 'short', year: 'numeric' });
  const date = shortDate(ms, now, timeZone);
  return p.year === parts(now, timeZone, { year: 'numeric' }).year ? `${p.weekday} ${date}` : date;
}

/** "23 s", "1 min 5 s", "2 min". */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${min} min` : `${min} min ${rest} s`;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/;

/**
 * A stored local time ("2026-11-09 14:05", already in the person's zone) as words.
 * `long`: "Monday 9 November"; otherwise "Mon 9 Nov, 14:05". Anything unparseable is returned as given.
 */
export function localTimeLabel(localTime, { long = false } = {}) {
  const m = LOCAL_TIME.exec(localTime);
  if (!m) return localTime;
  const [, y, mo, d, h, mi] = m;
  const date = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const p = parts(date, 'UTC', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
  });
  return long ? `${p.weekday} ${p.day} ${p.month}` : `${p.weekday} ${p.day} ${p.month}, ${h}:${mi}`;
}
