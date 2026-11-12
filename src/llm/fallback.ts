import {
  LlmError,
  type LlmErrorCode,
  type LlmPort,
  type StreamEvent,
  type StreamRequest,
  type StructuredRequest,
  type StructuredResult,
} from '../shared/llm.js';

/** Failures where another model may still answer: the primary is overloaded, rate limited or too slow. */
const FALL_BACK_ON: ReadonlySet<LlmErrorCode> = new Set(['rate_limited', 'unavailable', 'timeout']);

/**
 * A structured call the primary model has not answered after `afterMs(role)` is also sent to the fallback model,
 * when `ready()` says the fallback has quota to spare; the first answer wins and the other call is cancelled.
 * Free-tier latency has a long tail (one extraction call in ten can take 15 s), and the slowest call of a turn
 * decides when the answer can be written. Null for a role means no hedge.
 */
export interface HedgePolicy {
  afterMs(role: string): number | null;
  ready(): boolean;
}

export interface FallbackNotice {
  role: string;
  code: LlmErrorCode;
  primary: string;
  fallback: string;
}

/**
 * Tries the primary model, and after a failure that another model could avoid (rate limited, unavailable,
 * timed out) asks the fallback model once with the same request and the same abort signal, so the turn's
 * deadline still bounds it. It is never silent: every switch is reported through `onFallback` (logged by the
 * application), and the result carries the model that actually answered. A stream switches only if the
 * primary failed before it produced any text, so an answer is never stitched from two models. Bad requests,
 * refusals, invalid output and cancellation are not retried on the fallback: they would fail there too, or the
 * caller gave up.
 */
export class FallbackLlm implements LlmPort {
  constructor(
    private readonly primary: LlmPort,
    private readonly fallback: LlmPort,
    private readonly names: { primary: string; fallback: string },
    private readonly onFallback: (n: FallbackNotice) => void,
    /**
     * True when the primary model would make this call wait (its own budget is used up). The call then goes to
     * the fallback model at once, which has its own quota, instead of waiting past the turn deadline.
     */
    private readonly divert: () => boolean = () => false,
    private readonly hedge: HedgePolicy | null = null,
  ) {}

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (this.divert() && !r.signal.aborted) {
      this.onFallback({
        role: r.role,
        code: 'rate_limited',
        primary: this.names.primary,
        fallback: this.names.fallback,
      });
      return this.fallback.structured(r);
    }
    const after = this.hedge?.afterMs(r.role) ?? null;
    if (after !== null) return this.hedged(r, after);
    try {
      return await this.primary.structured(r);
    } catch (e) {
      if (!this.shouldFallBack(e, r.signal)) throw e;
      this.notify(r.role, e as LlmError);
      return this.fallback.structured(r);
    }
  }

  /**
   * The primary call, plus the same request to the fallback model when the primary fails in a way another model
   * could avoid, or is still running after `afterMs`. The first success wins and the other call is aborted; when
   * both fail, the primary's error is the one reported.
   */
  private hedged<T>(r: StructuredRequest<T>, afterMs: number): Promise<StructuredResult<T>> {
    const pCut = new AbortController();
    const fCut = new AbortController();
    return new Promise((resolve, reject) => {
      let done = false;
      let running = 1;
      let fallbackStarted = false;
      let primaryError: unknown = null;
      let fallbackError: unknown = null;
      const finish = (): void => {
        done = true;
        clearTimeout(timer);
      };
      const settleFailure = (): void => {
        if (done || running > 0) return;
        finish();
        const error = primaryError ?? fallbackError;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const startFallback = (code: LlmErrorCode): void => {
        if (fallbackStarted || done || r.signal.aborted) return;
        fallbackStarted = true;
        running++;
        this.notify(r.role, new LlmError(code, 'fallback'));
        this.fallback.structured({ ...r, signal: AbortSignal.any([r.signal, fCut.signal]) }).then(
          (v) => {
            if (done) return;
            finish();
            pCut.abort();
            resolve(v);
          },
          (e: unknown) => {
            running--;
            fallbackError = e;
            settleFailure();
          },
        );
      };
      const timer = setTimeout(() => {
        if (this.hedge?.ready()) startFallback('timeout');
      }, afterMs);
      this.primary.structured({ ...r, signal: AbortSignal.any([r.signal, pCut.signal]) }).then(
        (v) => {
          if (done) return;
          finish();
          fCut.abort();
          resolve(v);
        },
        (e: unknown) => {
          running--;
          if (done) return;
          primaryError = e;
          if (this.shouldFallBack(e, r.signal)) startFallback((e as LlmError).code);
          settleFailure();
        },
      );
    });
  }

  async *stream(r: StreamRequest): AsyncIterable<StreamEvent> {
    let yielded = false;
    if (this.divert() && !r.signal.aborted) {
      this.onFallback({
        role: r.role,
        code: 'rate_limited',
        primary: this.names.primary,
        fallback: this.names.fallback,
      });
      yield* this.fallback.stream(r);
      return;
    }
    try {
      for await (const ev of this.primary.stream(r)) {
        if (ev.type === 'delta') yielded = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (yielded || !this.shouldFallBack(e, r.signal)) throw e;
      this.notify(r.role, e as LlmError);
    }
    yield* this.fallback.stream(r);
  }

  private shouldFallBack(e: unknown, signal: AbortSignal): boolean {
    return e instanceof LlmError && FALL_BACK_ON.has(e.code) && !signal.aborted;
  }

  private notify(role: string, e: LlmError): void {
    this.onFallback({
      role,
      code: e.code,
      primary: this.names.primary,
      fallback: this.names.fallback,
    });
  }
}
