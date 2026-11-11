import { createHash } from 'node:crypto';
import { LlmError } from '../shared/llm.js';
import type {
  LlmPort,
  LlmUsage,
  StreamEvent,
  StreamRequest,
  StructuredRequest,
  StructuredResult,
} from '../shared/llm.js';

/** A replay miss: the request was never recorded. Never answered by a live call. */
export class ReplayMissError extends LlmError {
  constructor(public readonly key: string) {
    super('bad_request', `no recorded LLM response for request ${key}`);
    this.name = 'ReplayMissError';
  }
}

export type RecordedEntry =
  | { kind: 'structured'; value: unknown; usage: LlmUsage; model: string }
  | { kind: 'stream'; deltas: string[]; usage: LlmUsage; model: string };

/** Key to recorded entry. Plain JSON: it can be written to and read from a fixture file. */
export type ReplayStore = Record<string, RecordedEntry>;

/**
 * The request key: a hash of everything that determines the reply (role, system prompt, messages, schema
 * name, token limit), and nothing else (never the signal or any credential).
 */
export function requestKey(
  kind: 'structured' | 'stream',
  r: {
    role: string;
    system: string;
    messages: ReadonlyArray<{ role: string; content: string }>;
    maxTokens: number;
    schemaName?: string;
  },
): string {
  const canonical = JSON.stringify([
    kind,
    r.role,
    r.system,
    r.messages.map((m) => [m.role, m.content]),
    r.maxTokens,
    r.schemaName ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Replays recorded responses. Constructed WITHOUT credentials, a fetch or any live adapter, so it cannot fall
 * back to a live call: a miss throws ReplayMissError. Structured values are re-validated with the request's
 * schema, like the live adapters do.
 */
export class ReplayLlm implements LlmPort {
  constructor(private readonly store: Readonly<ReplayStore>) {}

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (r.signal.aborted) return Promise.reject(new LlmError('cancelled', 'aborted'));
    const key = requestKey('structured', r);
    const entry = this.store[key];
    if (entry?.kind !== 'structured') return Promise.reject(new ReplayMissError(key));
    const parsed = r.schema.safeParse(entry.value);
    if (!parsed.success) {
      return Promise.reject(new LlmError('invalid_output', 'recorded value fails the schema'));
    }
    return Promise.resolve({ value: parsed.data, usage: entry.usage, model: entry.model, latencyMs: 0 });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator keeps the port's shape
  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const key = requestKey('stream', r);
    const entry = this.store[key];
    if (entry?.kind !== 'stream') throw new ReplayMissError(key);
    for (const text of entry.deltas) {
      if (r.signal.aborted) throw new LlmError('cancelled', 'aborted');
      yield { type: 'delta', text };
    }
    yield { type: 'done', usage: entry.usage, model: entry.model, ttftMs: 0, latencyMs: 0 };
  }
}

/**
 * Wraps a real port and records every successful reply into `store`, so a controlled live session can be
 * turned into a replay fixture. It only observes: errors pass through untouched.
 */
export class RecordingLlm implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    readonly store: ReplayStore,
  ) {}

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const result = await this.inner.structured(r);
    this.store[requestKey('structured', r)] = {
      kind: 'structured',
      value: result.value,
      usage: result.usage,
      model: result.model,
    };
    return result;
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const deltas: string[] = [];
    for await (const ev of this.inner.stream(r)) {
      if (ev.type === 'delta') deltas.push(ev.text);
      else
        this.store[requestKey('stream', r)] = {
          kind: 'stream',
          deltas,
          usage: ev.usage,
          model: ev.model,
        };
      yield ev;
    }
  }
}
