import { LlmError } from '../shared/llm.js';
import type {
  LlmPort,
  LlmUsage,
  StreamEvent,
  StreamRequest,
  StructuredRequest,
  StructuredResult,
} from '../shared/llm.js';

const NO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** What a scripted stream does after (or instead of) its deltas. */
export interface StreamScript {
  deltas: string[];
  /** After the deltas: throw this instead of finishing. */
  failWith?: LlmError;
  /** After the deltas: wait until the request signal aborts, then throw the abort error. */
  hangUntilAbort?: boolean;
  /** Called before each delta is yielded (index), e.g. to spend FakeBudget time or abort. */
  beforeDelta?: (i: number) => void;
}

/**
 * A deterministic LlmPort for tests of everything that consumes the port. `structured` replies come from a
 * queue of raw values (validated with the request's own schema, like the real adapter) or errors; `stream`
 * replays scripts. Requests are recorded for assertions. Not a mock of the provider: see the adapter tests.
 */
export class FakeLlm implements LlmPort {
  readonly structuredCalls: Array<StructuredRequest<unknown>> = [];
  readonly streamCalls: StreamRequest[] = [];
  private readonly structuredQueue: Array<unknown | Error> = [];
  private readonly streamQueue: StreamScript[] = [];

  queueStructured(...replies: Array<unknown | Error>): this {
    this.structuredQueue.push(...replies);
    return this;
  }

  queueStream(...scripts: StreamScript[]): this {
    this.streamQueue.push(...scripts);
    return this;
  }

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.structuredCalls.push(r as StructuredRequest<unknown>);
    if (r.signal.aborted) return Promise.reject(new LlmError('cancelled', 'aborted'));
    if (this.structuredQueue.length === 0) {
      return Promise.reject(new LlmError('unavailable', 'FakeLlm: no structured reply queued'));
    }
    const next = this.structuredQueue.shift();
    if (next instanceof Error) return Promise.reject(next);
    const parsed = r.schema.safeParse(next);
    if (!parsed.success) {
      return Promise.reject(new LlmError('invalid_output', 'FakeLlm: reply failed the schema'));
    }
    return Promise.resolve({ value: parsed.data, usage: NO_USAGE, model: 'fake', latencyMs: 0 });
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.streamCalls.push(r);
    const script = this.streamQueue.shift();
    if (!script) throw new LlmError('unavailable', 'FakeLlm: no stream queued');
    let i = 0;
    for (const text of script.deltas) {
      script.beforeDelta?.(i++);
      if (r.signal.aborted) throw new LlmError('cancelled', 'aborted');
      yield { type: 'delta', text };
    }
    if (script.failWith) throw script.failWith;
    if (script.hangUntilAbort) {
      await new Promise<void>((resolve) => {
        if (r.signal.aborted) resolve();
        else r.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new LlmError('cancelled', 'aborted');
    }
    yield { type: 'done', usage: NO_USAGE, model: 'fake', ttftMs: 0, latencyMs: 0 };
  }
}
