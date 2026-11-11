import { describe, expect, it } from 'vitest';
import { contentAsOf } from '../../../src/belief/as-of.js';
import { ev, NOW } from './support.js';

describe('content as-of time of an observation', () => {
  it('T-ASOF-01: a live crawl is as of its retrieval time', () => {
    const e = ev({
      id: 'a',
      observedAt: NOW - 1000,
      fresh: true,
      crawl: 'ok',
      lastUpdated: NOW - 9999,
    });
    expect(contentAsOf(e)).toBe(NOW - 1000);
  });

  it('T-ASOF-02: a cached copy with a last-updated time is as of that (earlier) time', () => {
    const e = ev({ id: 'a', observedAt: NOW - 1000, fresh: false, lastUpdated: NOW - 5000 });
    expect(contentAsOf(e)).toBe(NOW - 5000);
  });

  it('T-ASOF-03: a cached copy without a last-updated time is unknown, even with a publication time', () => {
    expect(contentAsOf(ev({ id: 'a', fresh: false }))).toBeNull();
    expect(contentAsOf(ev({ id: 'b', fresh: false, published: NOW - 1 }))).toBeNull();
  });

  it('T-ASOF-04: a live flag with a failed crawl is not a live crawl', () => {
    const e = ev({ id: 'a', fresh: true, crawl: 'failed', lastUpdated: NOW - 7000 });
    expect(contentAsOf(e)).toBe(NOW - 7000);
    expect(contentAsOf(ev({ id: 'b', fresh: true, crawl: 'unknown' }))).toBeNull();
  });
});
