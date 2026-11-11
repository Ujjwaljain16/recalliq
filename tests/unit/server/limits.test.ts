import { describe, expect, it } from 'vitest';
import { allowedHostnames, hostnameOf } from '../../../src/server/app.js';
import { retryAfterSeconds, RunningCounter, TokenBuckets } from '../../../src/server/limits.js';
import { FixedClock } from '../../../src/temporal/clock.js';

describe('token buckets', () => {
  it('allows the burst, then refuses with the wait until the next token, then recovers', () => {
    const clock = new FixedClock(0);
    const b = new TokenBuckets({ capacity: 5, perWindow: 10, windowMs: 60_000 }, clock);
    for (let i = 0; i < 5; i++) expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBe(6_000); // one token every 6 s
    clock.advance(5_999);
    expect(b.take('u1')).toBe(1);
    clock.advance(1);
    expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBeGreaterThan(0);
  });

  it('keeps each key separate', () => {
    const clock = new FixedClock(0);
    const b = new TokenBuckets({ capacity: 1, perWindow: 1, windowMs: 1_000 }, clock);
    expect(b.take('a')).toBe(0);
    expect(b.take('a')).toBeGreaterThan(0);
    expect(b.take('b')).toBe(0);
  });

  it('never refills past the capacity', () => {
    const clock = new FixedClock(0);
    const b = new TokenBuckets({ capacity: 2, perWindow: 1, windowMs: 1_000 }, clock);
    clock.advance(1_000_000);
    expect([b.take('a'), b.take('a')]).toEqual([0, 0]);
    expect(b.take('a')).toBe(1_000);
  });

  it('bounds its memory without forgetting a bucket that is still limiting', () => {
    const clock = new FixedClock(0);
    const b = new TokenBuckets({ capacity: 1, perWindow: 1, windowMs: 60_000 }, clock, 3);
    expect(b.take('limited')).toBe(0);
    for (let i = 0; i < 10; i++) {
      clock.advance(60_000); // every earlier bucket has refilled
      expect(b.take(`k${i}`)).toBe(0);
    }
    expect(b.take('k9')).toBeGreaterThan(0);
  });

  it('rejects a nonsensical configuration', () => {
    const clock = new FixedClock(0);
    expect(() => new TokenBuckets({ capacity: 0, perWindow: 1, windowMs: 1 }, clock)).toThrow();
    expect(() => new TokenBuckets({ capacity: 1, perWindow: 0, windowMs: 1 }, clock)).toThrow();
  });
});

describe('running counter', () => {
  it('caps each key and frees a slot when a run finishes', () => {
    const c = new RunningCounter(2);
    expect([c.tryStart('u'), c.tryStart('u'), c.tryStart('u')]).toEqual([true, true, false]);
    expect(c.tryStart('other')).toBe(true);
    c.finish('u');
    expect(c.tryStart('u')).toBe(true);
  });
});

describe('Retry-After', () => {
  it('rounds up to whole seconds, at least one', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(60_000)).toBe(60);
  });
});

describe('host names the server answers for', () => {
  it('parses Host header values, and refuses malformed ones', () => {
    expect(hostnameOf('localhost:3001')).toBe('localhost');
    expect(hostnameOf('LOCALHOST.')).toBe('localhost');
    expect(hostnameOf('[::1]:3001')).toBe('[::1]');
    expect(hostnameOf('evil.example:3001')).toBe('evil.example');
    for (const bad of [undefined, '', 'localhost@evil.example', 'localhost/x', 'a b']) {
      expect(hostnameOf(bad), String(bad)).toBeNull();
    }
  });

  it('accepts the loopback names, the configured HOST and the ALLOWED_ORIGIN host only', () => {
    const plain = allowedHostnames('127.0.0.1', undefined);
    expect([...plain].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
    expect(allowedHostnames('recalliq.internal', undefined).has('recalliq.internal')).toBe(true);
    expect(allowedHostnames('::1', undefined).has('[::1]')).toBe(true);
    expect(allowedHostnames('127.0.0.1', 'https://app.example:8443').has('app.example')).toBe(true);
    // a wildcard address is not a name any client uses
    expect(allowedHostnames('0.0.0.0', undefined).has('0.0.0.0')).toBe(false);
    expect(allowedHostnames('::', undefined).has('[::]')).toBe(false);
  });
});
