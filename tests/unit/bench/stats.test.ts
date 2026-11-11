import { describe, expect, it } from 'vitest';
import { median, percentile, wilson } from '../../../scripts/bench/stats.js';

describe('Wilson score interval', () => {
  it('matches reference values', () => {
    // Reference values computed from the closed form with z = 1.959964.
    const half = wilson(5, 10);
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
    const zero = wilson(0, 10);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeCloseTo(0.2775, 4);
    const all = wilson(10, 10);
    expect(all.low).toBeCloseTo(0.7225, 4);
    expect(all.high).toBeCloseTo(1, 10);
    const big = wilson(81, 100);
    expect(big.low).toBeCloseTo(0.7222, 4);
    expect(big.high).toBeCloseTo(0.8749, 4);
  });

  it('is the whole unit interval without data and refuses impossible counts', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(() => wilson(11, 10)).toThrow(RangeError);
  });

  it('narrows as n grows at the same proportion', () => {
    const small = wilson(3, 10);
    const large = wilson(300, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
});

describe('median and percentile', () => {
  it('computes the median of odd and even counts and ignores non-finite values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([Number.NaN])).toBeNull();
  });

  it('uses the nearest rank', () => {
    const xs = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(percentile(xs, 0.9)).toBe(9);
    expect(percentile(xs, 1)).toBe(10);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});
