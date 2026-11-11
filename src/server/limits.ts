import type { Clock } from '../shared/infrastructure.js';

/**
 * Request quotas of the HTTP layer. They bound what one browser (or one script holding a cookie) can make the
 * server spend on the owner's provider keys. All of them are in memory and per process, which is enough for a
 * single locally run server; time comes from the injected clock so tests are deterministic.
 */
export interface ServerLimits {
  /** Turns one user may have running at once, across all of their conversations. */
  maxRunningTurnsPerUser: number;
  /** Turn creation per user: a token bucket of `turnBurst` tokens refilled at `turnsPerMinute`. */
  turnsPerMinute: number;
  turnBurst: number;
  /** Anonymous users (sessions) one client address may create per hour; also the burst. */
  newSessionsPerHour: number;
  /** node:http settings: open sockets, and the time allowed to receive the headers and the whole request. */
  maxConnections: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxRunningTurnsPerUser: 2,
  turnsPerMinute: 10,
  turnBurst: 5,
  newSessionsPerHour: 20,
  maxConnections: 256,
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 30_000,
};

/** How long a client is told to wait when it already has the maximum number of turns running. */
export const RUNNING_TURNS_RETRY_AFTER_S = 5;

/** Tolerance for floating-point error in token arithmetic. */
const EPSILON = 1e-6;

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token buckets keyed by a string (a user id, a client address): `capacity` tokens, refilled continuously at
 * `perWindow` tokens every `windowMs`. Memory is bounded: past `maxKeys` the buckets that have refilled
 * completely are dropped (they behave exactly like a new bucket), then the least recently used.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly opts: { capacity: number; perWindow: number; windowMs: number },
    private readonly clock: Clock,
    private readonly maxKeys = 10_000,
  ) {
    if (opts.capacity < 1 || opts.perWindow <= 0 || opts.windowMs <= 0) {
      throw new RangeError('a token bucket needs a capacity of at least 1 and a positive rate');
    }
  }

  /** Takes one token for `key`. Returns 0 when it was taken, otherwise the milliseconds until one is available. */
  take(key: string): number {
    const now = this.clock.now();
    const tokens = this.level(key, now);
    this.buckets.delete(key); // re-inserted below, so iteration order is least recently used first
    if (tokens >= 1 - EPSILON) {
      this.buckets.set(key, { tokens: Math.max(0, tokens - 1), at: now });
      this.prune(now);
      return 0;
    }
    this.buckets.set(key, { tokens, at: now });
    // Computed from the window, not the per-ms rate, and with a tolerance, so float error never adds a second.
    const waitMs = ((1 - tokens) * this.opts.windowMs) / this.opts.perWindow;
    return Math.max(1, Math.ceil(waitMs - EPSILON));
  }

  private level(key: string, now: number): number {
    const b = this.buckets.get(key);
    if (!b) return this.opts.capacity;
    const refill = (Math.max(0, now - b.at) * this.opts.perWindow) / this.opts.windowMs;
    return Math.min(this.opts.capacity, b.tokens + refill);
  }

  private prune(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const key of [...this.buckets.keys()]) {
      if (this.level(key, now) >= this.opts.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

/** Counts the turns each key (a user id) has running. */
export class RunningCounter {
  private readonly running = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Starts one if the key is under the maximum; returns false otherwise. */
  tryStart(key: string): boolean {
    const n = this.running.get(key) ?? 0;
    if (n >= this.max) return false;
    this.running.set(key, n + 1);
    return true;
  }

  finish(key: string): void {
    const n = (this.running.get(key) ?? 0) - 1;
    if (n <= 0) this.running.delete(key);
    else this.running.set(key, n);
  }
}

/** Seconds for a Retry-After header, at least 1. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
