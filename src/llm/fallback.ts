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
    try {
      return await this.primary.structured(r);
    } catch (e) {
      if (!this.shouldFallBack(e, r.signal)) throw e;
      this.notify(r.role, e as LlmError);
      return this.fallback.structured(r);
    }
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
