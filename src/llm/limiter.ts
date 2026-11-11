import type { Clock } from '../shared/infrastructure.js';
import { abortToError, type Sleep } from './abort.js';

export interface LimiterOptions {
  /** Requests in flight at once. */
  maxConcurrent: number;
  /** Minimum time between the starts of two requests. */
  minSpacingMs: number;
  /**
   * At most this many starts in any rolling 60 s window (absent: no window). This is how per-minute quotas are
   * stated, and unlike a fixed spacing it lets one turn's few calls start at once.
   */
  maxPerMinute?: number;
}

const WINDOW_MS = 60_000;

/**
 * Defaults sized for a free tier with about 15 requests a minute: up to 3 requests in flight and at most 15
 * starts in any minute, with no fixed gap, so a single turn rarely waits. (The earlier default, one request
 * every 4 s, added roughly 4 s to every model call of a turn.) They are defaults, not facts about any quota:
 * tune them from the real limits of the model in use.
 */
export const DEFAULT_LIMITER: LimiterOptions = {
  maxConcurrent: 3,
  minSpacingMs: 0,
  maxPerMinute: 15,
};

/**
 * Client-side limiter: at most `maxConcurrent` requests in flight, `minSpacingMs` between starts and at most
 * `maxPerMinute` starts in any rolling minute, FIFO.
 * Waiting is abortable and a request that was never started never consumes a slot. Time and sleeping are
 * injected, so tests are deterministic.
 */
export class ClientLimiter {
  private active = 0;
  private nextStart = Number.NEGATIVE_INFINITY;
  /** Start times inside the current rolling window, oldest first (reserved, so they may lie in the future). */
  private readonly starts: number[] = [];
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
      const now = this.deps.clock.now();
      let startAt = Math.max(now, this.nextStart);
      const max = this.opts.maxPerMinute;
      if (max !== undefined) {
        while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - WINDOW_MS)
          this.starts.shift();
        if (this.starts.length >= max) {
          startAt = Math.max(startAt, (this.starts[this.starts.length - max] ?? now) + WINDOW_MS);
        }
        this.starts.push(startAt);
      }
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
