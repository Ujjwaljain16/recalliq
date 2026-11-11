import type { Clock } from '../shared/infrastructure.js';
import { abortToError, type Sleep } from './abort.js';

export interface LimiterOptions {
  /** Requests in flight at once. */
  maxConcurrent: number;
  /** Minimum time between the starts of two requests. */
  minSpacingMs: number;
}

/**
 * Conservative defaults for a free tier whose per-minute limits are low: strictly one request at a time and
 * four seconds between starts (at most 15 a minute). They are defaults, not facts about any quota: tune them
 * from the real limits of the model in use.
 */
export const DEFAULT_LIMITER: LimiterOptions = { maxConcurrent: 1, minSpacingMs: 4000 };

/**
 * Client-side limiter: at most `maxConcurrent` requests in flight and `minSpacingMs` between starts, FIFO.
 * Waiting is abortable and a request that was never started never consumes a slot. Time and sleeping are
 * injected, so tests are deterministic.
 */
export class ClientLimiter {
  private active = 0;
  private nextStart = Number.NEGATIVE_INFINITY;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly opts: LimiterOptions,
    private readonly deps: { clock: Clock; sleep: Sleep },
  ) {
    if (opts.maxConcurrent < 1) throw new RangeError('maxConcurrent must be at least 1');
  }

  /** Resolves with a `release` function once the request may start. Always call release exactly once. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    await this.takeSlot(signal);
    try {
      const startAt = Math.max(this.deps.clock.now(), this.nextStart);
      this.nextStart = startAt + this.opts.minSpacingMs;
      const wait = startAt - this.deps.clock.now();
      if (wait > 0) await this.deps.sleep(wait, signal);
    } catch (e) {
      this.freeSlot();
      throw e;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.freeSlot();
    };
  }

  private takeSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortToError(signal));
    if (this.active < this.opts.maxConcurrent && this.waiters.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(abortToError(signal));
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private freeSlot(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
