import { describe, expect, it } from 'vitest';
import { ClientLimiter } from '../../../src/llm/limiter.js';
import { abortToError, type Sleep } from '../../../src/llm/abort.js';
import { ManualClock } from './fetch-helpers.js';

function make(opts: { maxConcurrent: number; minSpacingMs: number }) {
  const clock = new ManualClock(0);
  const sleeps: number[] = [];
  const sleep: Sleep = (ms, signal) => {
    if (signal.aborted) return Promise.reject(abortToError(signal));
    sleeps.push(ms);
    clock.advance(ms);
    return Promise.resolve();
  };
  return { limiter: new ClientLimiter(opts, { clock, sleep }), clock, sleeps };
}

const live = new AbortController().signal;

describe('ClientLimiter', () => {
  it('spaces request starts by at least minSpacingMs', async () => {
    const { limiter, sleeps } = make({ maxConcurrent: 5, minSpacingMs: 1000 });
    (await limiter.acquire(live))();
    (await limiter.acquire(live))();
    (await limiter.acquire(live))();
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('never exceeds maxConcurrent and releases waiters in FIFO order', async () => {
    const { limiter } = make({ maxConcurrent: 1, minSpacingMs: 0 });
    const order: number[] = [];
    const release1 = await limiter.acquire(live);
    const p2 = limiter.acquire(live).then((r) => {
      order.push(2);
      return r;
    });
    const p3 = limiter.acquire(live).then((r) => {
      order.push(3);
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release1();
    (await p2)();
    (await p3)();
    expect(order).toEqual([2, 3]);
  });

  it('release is idempotent', async () => {
    const { limiter } = make({ maxConcurrent: 1, minSpacingMs: 0 });
    const r = await limiter.acquire(live);
    r();
    r();
    const second = await limiter.acquire(live);
    let third = false;
    void limiter.acquire(live).then(() => (third = true));
    await Promise.resolve();
    expect(third).toBe(false); // a double release must not free two slots
    second();
  });

  it('an aborted waiter leaves the queue and consumes no slot', async () => {
    const { limiter } = make({ maxConcurrent: 1, minSpacingMs: 0 });
    const holder = await limiter.acquire(live);
    const c = new AbortController();
    const waiting = limiter.acquire(c.signal);
    c.abort(new Error('deadline'));
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    holder();
    (await limiter.acquire(live))();
  });

  it('a pre-aborted signal is refused at once', async () => {
    const { limiter } = make({ maxConcurrent: 1, minSpacingMs: 0 });
    const c = new AbortController();
    c.abort(new Error('x'));
    await expect(limiter.acquire(c.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
