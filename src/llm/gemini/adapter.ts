import { LlmError } from '../../shared/llm.js';
import type {
  LlmPort,
  LlmRole,
  LlmUsage,
  StreamEvent,
  StreamRequest,
  StructuredRequest,
  StructuredResult,
} from '../../shared/llm.js';
import type { Clock } from '../../shared/infrastructure.js';
import { abortPromise, abortToError, realSleep, type Sleep } from '../abort.js';
import type { ClientLimiter } from '../limiter.js';
import { SseParser } from '../sse-parser.js';
import {
  ZERO_USAGE,
  addUsage,
  buildGeminiBody,
  errorFromChunk,
  errorFromHttp,
  geminiHeaders,
  geminiUrl,
  interpretResponse,
  parseChunk,
  toGeminiJsonSchema,
  type GeminiMessage,
  type GeminiRequest,
  type GeminiThinking,
} from './wire.js';

/** Plain, injected configuration. The API key is never logged and never appears in an error message. */
export interface GeminiAdapterConfig {
  apiKey: string;
  /** GEMINI_MODEL. No default: the owner chooses a model that is eligible for the free tier. */
  model: string;
  baseUrl?: string;
  /** Per attempt: for a stream, until the response headers arrive. */
  requestTimeoutMs: number;
  /** Retries of transient failures after the first attempt. 0 disables them. */
  maxRetries: number;
  /** Exponential backoff: min(maxDelayMs, baseDelayMs * 2^attempt) with full jitter. Defaults 1000 / 20000. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A required wait longer than this is not waited for: the error is thrown. Default 15000. */
  maxRetryWaitMs?: number;
  /** Extra attempts after an output that fails validation. Default 1. */
  maxRepairs?: number;
  temperature?: number;
  thinking?: GeminiThinking;
}

export interface LlmCallRecord {
  role: LlmRole;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  outcome: 'ok' | LlmError['code'];
  /** Provider requests made (retries and repairs included). */
  attempts: number;
}

export interface GeminiDeps {
  config: GeminiAdapterConfig;
  /** Node's global fetch in production; a fixture in tests. */
  fetch: typeof fetch;
  clock: Clock;
  /** Injectable for deterministic tests. */
  sleep?: Sleep;
  /** Uniform in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
  limiter?: ClientLimiter;
  onCall?: (r: LlmCallRecord) => void;
}

const MAX_ERROR_BODY_CHARS = 4000;

/** An LlmError that remembers whether waiting and retrying could help. Internal: callers see LlmError. */
class CallError extends LlmError {
  constructor(
    code: LlmError['code'],
    message: string,
    retryAfterMs: number | undefined,
    readonly transient: boolean,
  ) {
    super(code, message, retryAfterMs);
  }
}

function fail(e: { error: LlmError; transient: boolean }): CallError {
  return new CallError(e.error.code, e.error.message, e.error.retryAfterMs, e.transient);
}

/** A per-attempt scope: the caller's signal plus a timeout that stops counting once `settle()` is called. */
interface Attempt {
  signal: AbortSignal;
  settle(): void;
  dispose(): void;
  timedOut(): boolean;
}

function startAttempt(caller: AbortSignal, timeoutMs: number): Attempt {
  const controller = new AbortController();
  let timedOut = false;
  const onCaller = (): void => controller.abort(caller.reason);
  if (caller.aborted) controller.abort(caller.reason);
  else caller.addEventListener('abort', onCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('attempt timeout', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    settle: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      caller.removeEventListener('abort', onCaller);
    },
    timedOut: () => timedOut,
  };
}

/**
 * LlmPort over the Gemini Developer API (generateContent / streamGenerateContent) using Node's fetch. No SDK,
 * no tools, no search grounding. There is NO fallback to any other provider: failure throws LlmError.
 *
 * Retries: transient failures (429 rate limit, 5xx, an attempt timeout) are retried with exponential backoff and
 * jitter up to `maxRetries`, honouring a Retry-After / retryDelay hint, never waiting past the caller's signal
 * and never waiting longer than `maxRetryWaitMs`. A daily quota is not retried. The only other retry is the
 * bounded repair of an output that fails local zod validation. A stream is retried only before its first delta.
 * The wire format lives in ./wire.ts.
 */
export class GeminiLlm implements LlmPort {
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(private readonly deps: GeminiDeps) {
    this.sleep = deps.sleep ?? realSleep;
    this.random = deps.random ?? Math.random;
  }

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const { config, clock } = this.deps;
    const started = clock.now();
    const maxAttempts = 1 + Math.max(0, config.maxRepairs ?? 1);
    const jsonSchema = toGeminiJsonSchema(r.schema);
    let usage = ZERO_USAGE;
    let calls = 0;
    let model = config.model;
    let messages: GeminiMessage[] = r.messages.map((m) => ({ ...m }));
    let problem = 'no output';

    const record = (outcome: LlmCallRecord['outcome']): void =>
      this.deps.onCall?.({
        role: r.role,
        model,
        usage,
        latencyMs: clock.now() - started,
        outcome,
        attempts: calls,
      });

    try {
      for (let repair = 0; repair < maxAttempts; repair++) {
        if (r.signal.aborted) throw abortToError(r.signal);
        const reply = await this.withRetries(r.signal, () => {
          calls++;
          return this.generateOnce(
            {
              system: r.system,
              messages,
              maxOutputTokens: r.maxTokens,
              temperature: config.temperature,
              thinking: config.thinking,
              jsonSchema,
            },
            r.signal,
          );
        });
        usage = addUsage(usage, reply.usage);
        model = reply.model ?? model;
        if (reply.finish === 'max_tokens') {
          throw new LlmError(
            'invalid_output',
            `structured output for "${r.schemaName}" was cut off at maxOutputTokens`,
          );
        }
        const checked = validate(reply.text, r.schema);
        if (checked.ok) {
          record('ok');
          return { value: checked.value, usage, model, latencyMs: clock.now() - started };
        }
        problem = checked.problem;
        messages = [
          ...r.messages.map((m) => ({ ...m })),
          { role: 'assistant', content: reply.text.slice(0, 8000) || '(empty)' },
          {
            role: 'user',
            content: `That output was not valid for "${r.schemaName}": ${problem}. Reply again with only the corrected JSON.`,
          },
        ];
      }
      throw new LlmError(
        'invalid_output',
        `structured output for "${r.schemaName}" stayed invalid after ${maxAttempts} attempt(s): ${problem}`,
      );
    } catch (e) {
      const err = this.toLlmError(e, r.signal);
      record(err.code);
      throw err;
    }
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const { config, clock } = this.deps;
    const started = clock.now();
    let usage = ZERO_USAGE;
    let model = config.model;
    let firstDeltaAt: number | null = null;
    let yielded = false;
    let calls = 0;
    const record = (outcome: LlmCallRecord['outcome']): void =>
      this.deps.onCall?.({
        role: r.role,
        model,
        usage,
        latencyMs: clock.now() - started,
        outcome,
        attempts: calls,
      });

    try {
      for (let attempt = 0; ; attempt++) {
        calls++;
        try {
          for await (const ev of this.streamOnce(
            {
              system: r.system,
              messages: r.messages,
              maxOutputTokens: r.maxTokens,
              temperature: config.temperature,
              thinking: config.thinking,
            },
            r.signal,
          )) {
            if (ev.kind === 'text') {
              firstDeltaAt ??= clock.now();
              yielded = true;
              yield { type: 'delta', text: ev.text };
            } else {
              usage = addUsage(usage, ev.usage);
              model = ev.model ?? model;
            }
          }
          break;
        } catch (e) {
          // A stream is retried only while nothing has been delivered: replaying would duplicate text.
          const err = this.toLlmError(e, r.signal);
          const transient = e instanceof CallError && e.transient;
          if (yielded || !transient || attempt >= config.maxRetries) throw err;
          await this.backoff(attempt, err, r.signal);
        }
      }
      const now = clock.now();
      record('ok');
      yield {
        type: 'done',
        usage,
        model,
        ttftMs: (firstDeltaAt ?? now) - started,
        latencyMs: now - started,
      };
    } catch (e) {
      const err = this.toLlmError(e, r.signal);
      record(err.code);
      throw err;
    }
  }

  /** Runs `fn`, retrying transient failures per the policy. */
  private async withRetries<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const err = this.toLlmError(e, signal);
        const transient = e instanceof CallError && e.transient;
        if (!transient || attempt >= this.deps.config.maxRetries) throw err;
        await this.backoff(attempt, err, signal);
      }
    }
  }

  /** Waits before a retry, or throws `err` when waiting is pointless (too long, or the caller gave up). */
  private async backoff(attempt: number, err: LlmError, signal: AbortSignal): Promise<void> {
    const { baseDelayMs = 1000, maxDelayMs = 20000, maxRetryWaitMs = 15000 } = this.deps.config;
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const delay = Math.max(Math.floor(this.random() * cap), err.retryAfterMs ?? 0);
    if (delay > maxRetryWaitMs) throw err;
    await this.sleep(delay, signal);
  }

  private async post(
    req: GeminiRequest,
    stream: boolean,
    attempt: Attempt,
    aborted: { promise: Promise<never> },
  ): Promise<Response> {
    const { config } = this.deps;
    const response = await Promise.race([
      this.deps.fetch(geminiUrl(config.baseUrl, config.model, stream), {
        method: 'POST',
        headers: geminiHeaders(config.apiKey),
        body: JSON.stringify(buildGeminiBody(req)),
        signal: attempt.signal,
      }),
      aborted.promise,
    ]);
    if (!response.ok) {
      let text = '';
      try {
        text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch {
        // the status still classifies the error
      }
      throw fail(errorFromHttp(response.status, text, response.headers.get('retry-after')));
    }
    return response;
  }

  /** One non-streaming request, under the limiter and the per-attempt timeout. */
  private async generateOnce(
    req: GeminiRequest,
    caller: AbortSignal,
  ): Promise<{ text: string; finish: 'stop' | 'max_tokens' | null; usage: LlmUsage; model: string | null }> {
    const release = await this.deps.limiter?.acquire(caller);
    const attempt = startAttempt(caller, this.deps.config.requestTimeoutMs);
    const aborted = abortPromise(attempt.signal);
    try {
      const response = await this.post(req, false, attempt, aborted);
      let body: unknown;
      try {
        body = await Promise.race([response.json(), aborted.promise]);
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw new CallError('unavailable', 'provider response body was not valid JSON', undefined, true);
      }
      const r = interpretResponse(body, true);
      return { text: r.text, finish: r.finish, usage: r.usage ?? ZERO_USAGE, model: r.model };
    } catch (e) {
      throw this.attemptError(e, attempt, caller);
    } finally {
      aborted.dispose();
      attempt.dispose();
      release?.();
    }
  }

  private async *streamOnce(
    req: GeminiRequest,
    caller: AbortSignal,
  ): AsyncGenerator<
    { kind: 'text'; text: string } | { kind: 'meta'; usage: LlmUsage; model: string | null },
    void,
    undefined
  > {
    const release = await this.deps.limiter?.acquire(caller);
    const attempt = startAttempt(caller, this.deps.config.requestTimeoutMs);
    // Once the headers are in, only the caller's signal (the turn budget) bounds the rest of the stream.
    const aborted = abortPromise(caller);
    const connect = abortPromise(attempt.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await this.post(req, true, attempt, connect);
      attempt.settle();
      if (!response.body) throw new CallError('unavailable', 'provider sent no response body', undefined, true);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let usage: LlmUsage | null = null;
      let model: string | null = null;
      let finish: 'stop' | 'max_tokens' | null = null;
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted.promise]);
        if (chunk.done) break;
        for (const message of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          const json = parseChunk(message);
          const embedded = errorFromChunk(json);
          if (embedded) throw fail(embedded);
          const r = interpretResponse(json, false);
          if (r.text) yield { kind: 'text', text: r.text };
          if (r.usage) usage = r.usage;
          model = r.model ?? model;
          if (r.finish) finish = r.finish;
        }
      }
      for (const message of parser.end()) {
        const r = interpretResponse(parseChunk(message), false);
        if (r.text) yield { kind: 'text', text: r.text };
        if (r.finish) finish = r.finish;
      }
      if (finish === null) {
        throw new CallError('unavailable', 'provider stream ended without a finish reason', undefined, true);
      }
      if (finish === 'max_tokens') {
        throw new LlmError('invalid_output', 'the answer was cut off at maxOutputTokens');
      }
      yield { kind: 'meta', usage: usage ?? ZERO_USAGE, model };
    } catch (e) {
      throw this.attemptError(e, attempt, caller);
    } finally {
      aborted.dispose();
      connect.dispose();
      attempt.dispose();
      release?.();
      if (reader) reader.cancel().catch(() => undefined);
    }
  }

  /** Classifies a failure of one attempt: caller abort, our own timeout (transient), or the error itself. */
  private attemptError(e: unknown, attempt: Attempt, caller: AbortSignal): Error {
    if (caller.aborted) return abortToError(caller);
    if (attempt.timedOut()) {
      return new CallError('timeout', 'the request timed out', undefined, true);
    }
    if (e instanceof LlmError) return e;
    // Network failure, DNS, TLS, a body that died mid-read: transient. The message is not echoed (URLs).
    return new CallError('unavailable', 'could not reach the provider', undefined, true);
  }

  private toLlmError(e: unknown, signal: AbortSignal): LlmError {
    if (signal.aborted) return abortToError(signal);
    if (e instanceof CallError) return new LlmError(e.code, e.message, e.retryAfterMs);
    if (e instanceof LlmError) return e;
    return new LlmError('unavailable', 'could not reach the provider');
  }
}

type Validated<T> = { ok: true; value: T } | { ok: false; problem: string };

function validate<T>(text: string, schema: StructuredRequest<T>['schema']): Validated<T> {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return { ok: false, problem: 'it was not parseable JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problems = parsed.error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, problem: problems };
}
