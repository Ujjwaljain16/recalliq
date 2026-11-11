import { describe, expect, it } from 'vitest';
import { clock, duration, listStamp, localTimeLabel, shortDate } from '../../../web/js/time.js';

// Thursday 12 November 2026, 15:46 in London (UTC in November).
const now = Date.UTC(2026, 10, 12, 15, 46);
const at = (d: number, h = 9, mi = 0, y = 2026, mo = 10) => Date.UTC(y, mo, d, h, mi);

describe('time formatting', () => {
  it('stamps conversations relative to today in the given zone', () => {
    expect(listStamp(at(12, 15, 46), now, 'Europe/London')).toBe('Today 15:46');
    expect(listStamp(at(11, 23, 59), now, 'Europe/London')).toBe('Yesterday');
    expect(listStamp(at(9), now, 'Europe/London')).toBe('Mon 9 Nov');
    expect(listStamp(at(9, 9, 0, 2025), now, 'Europe/London')).toBe('9 Nov 2025');
  });

  it('uses the calendar day of the zone, not of UTC', () => {
    // now is already 00:46 on 13 Nov in Tokyo: 14:00 UTC on 12 Nov was yesterday there
    expect(listStamp(at(12, 14, 0), now, 'Europe/London')).toBe('Today 14:00');
    expect(listStamp(at(12, 14, 0), now, 'Asia/Tokyo')).toBe('Yesterday');
    expect(listStamp(at(12, 15, 30), now, 'Asia/Tokyo')).toBe('Today 00:30');
    expect(clock(at(12, 15, 46), 'America/New_York')).toBe('10:46');
  });

  it('writes short dates with the year only when it differs', () => {
    expect(shortDate(at(3), now, 'UTC')).toBe('3 Nov');
    expect(shortDate(at(3, 9, 0, 2025), now, 'UTC')).toBe('3 Nov 2025');
  });

  it('writes durations in seconds and minutes', () => {
    expect(duration(400)).toBe('0 s');
    expect(duration(23_400)).toBe('23 s');
    expect(duration(65_000)).toBe('1 min 5 s');
    expect(duration(120_000)).toBe('2 min');
  });

  it('turns a stored local time into words', () => {
    expect(localTimeLabel('2026-11-09 14:05', { long: true })).toBe('Monday 9 November');
    expect(localTimeLabel('2026-11-09 14:05')).toBe('Mon 9 Nov, 14:05');
    expect(localTimeLabel('yesterday')).toBe('yesterday');
  });
});
