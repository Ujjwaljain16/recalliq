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
import { DEFAULT_ROLE_TIER, type AnthropicAdapterConfig, type TierConfig } from '../config.js';
import { SseParser } from '../sse-parser.js';
import {
  ZERO_USAGE,
  addUsage,
  buildRequestBody,
  errorFromHttp,
  messagesUrl,
  parseMessageResponse,
  parseStreamEvent,
  requestHeaders,
  toProviderJsonSchema,
  type ParsedMessage,
  type WireMessage,
} from './wire.js';

/** One provider call, successful or not. Emitted for usage accounting; contains no content. */
export interface LlmCallRecord {
  role: LlmRole;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  outcome: 'ok' | LlmError['code'];
  /** Provider calls made for this request (1 plus repairs). */
  attempts: number;
}

export interface AnthropicDeps {
  config: AnthropicAdapterConfig;
  /** Node's global fetch in production; a fixture in tests. */
  fetch: typeof fetch;
  clock: Clock;
  onCall?: (r: LlmCallRecord) => void;
}

const MAX_ERROR_BODY_CHARS = 4000;

/** The reason a signal aborted, as a typed error: a timeout is not a cancellation. */
export function abortToError(signal: AbortSignal): LlmError {
  const reason: unknown = signal.reason;
  const name = reason instanceof Error ? reason.name : '';
  return name === 'TimeoutError'
    ? new LlmError('timeout', 'the call exceeded its time allowance')
    : new LlmError('cancelled', 'the call was cancelled');
}

/**
 * LlmPort over the Anthropic Messages API using Node's fetch. No SDK. Retries of transport or provider
 * failures are NOT done here (the turn policy owns them); the only retry is the bounded repair of an output
 * that fails local validation. The wire format lives in ./wire.ts.
 */
export class AnthropicLlm implements LlmPort {
  constructor(private readonly deps: AnthropicDeps) {}

  private tierFor(role: LlmRole): TierConfig {
    const tier = this.deps.config.roleTier?.[role] ?? DEFAULT_ROLE_TIER[role];
    return this.deps.config.tiers[tier];
  }

  private headers(): Record<string, string> {
    return requestHeaders(this.deps.config.apiKey);
  }

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const tier = this.tierFor(r.role);
    const started = this.deps.clock.now();
    const maxAttempts = 1 + Math.max(0, this.deps.config.maxRepairs ?? 1);
    const jsonSchema = toProviderJsonSchema(r.schema);
    let usage = ZERO_USAGE;
    let attempts = 0;
    let messages: WireMessage[] = r.messages.map((m) => ({ ...m }));
    let lastProblem = 'no output';

    const record = (outcome: LlmCallRecord['outcome']): void =>
      this.deps.onCall?.({
        role: r.role,
        model: tier.model,
        usage,
        latencyMs: this.deps.clock.now() - started,
        outcome,
        attempts,
      });

    try {
      while (attempts < maxAttempts) {
        if (r.signal.aborted) throw abortToError(r.signal);
        attempts++;
        const message = await this.postJson(
          {
            tier,
            system: r.system,
            messages,
            maxTokens: r.maxTokens,
            stream: false,
            jsonSchema,
          },
          r.signal,
        );
        usage = addUsage(usage, message.usage);
        if (message.stopReason === 'refusal') throw new LlmError('refused', 'the model refused');

        const checked = validateOutput(message.text, r.schema);
        if (checked.ok) {
          record('ok');
          return {
            value: checked.value,
            usage,
            model: message.model ?? tier.model,
            latencyMs: this.deps.clock.now() - started,
          };
        }
        lastProblem =
          message.stopReason === 'max_tokens'
            ? 'output was cut off at the token limit'
            : checked.problem;
        // Repair: show the model its own output and what is wrong with it (never the user's data again).
        messages = [
          ...r.messages.map((m) => ({ ...m })),
          { role: 'assistant', content: message.text.slice(0, 8000) || '(empty)' },
          {
            role: 'user',
            content: `That output was not valid for "${r.schemaName}": ${lastProblem}. Reply again with only the corrected JSON object.`,
          },
        ];
      }
      throw new LlmError(
        'invalid_output',
        `structured output for "${r.schemaName}" stayed invalid after ${attempts} attempt(s): ${lastProblem}`,
      );
    } catch (e) {
      const err = this.toLlmError(e, r.signal);
      record(err.code);
      throw err;
    }
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const tier = this.tierFor(r.role);
    const started = this.deps.clock.now();
    let usage = ZERO_USAGE;
    let model = tier.model;
    let firstDeltaAt: number | null = null;
    const record = (outcome: LlmCallRecord['outcome']): void =>
      this.deps.onCall?.({
        role: r.role,
        model,
        usage,
        latencyMs: this.deps.clock.now() - started,
        outcome,
        attempts: 1,
      });

    const aborted = abortPromise(r.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      if (r.signal.aborted) throw abortToError(r.signal);
      const response = await Promise.race([
        this.deps.fetch(messagesUrl(this.deps.config.baseUrl), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(
            buildRequestBody({
              tier,
              system: r.system,
              messages: r.messages,
              maxTokens: r.maxTokens,
              stream: true,
            }),
          ),
          signal: r.signal,
        }),
        aborted.promise,
      ]);
      if (!response.ok) throw await this.httpError(response);
      if (!response.body) throw new LlmError('unavailable', 'provider sent no response body');

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let stopReason: string | null = null;
      let stopped = false;

      while (!stopped) {
        const chunk = await Promise.race([reader.read(), aborted.promise]);
        if (chunk.done) break;
        for (const message of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          const ev = parseStreamEvent(message);
          if (ev.type === 'start') {
            usage = { ...usage, ...ev.usage };
            model = ev.model ?? model;
          } else if (ev.type === 'text') {
            firstDeltaAt ??= this.deps.clock.now();
            yield { type: 'delta', text: ev.text };
          } else if (ev.type === 'finish') {
            stopReason = ev.stopReason;
            usage = { ...usage, ...ev.usage };
          } else if (ev.type === 'stop') {
            stopped = true;
            break;
          }
        }
      }
      if (!stopped) {
        throw new LlmError('unavailable', 'provider stream ended before message_stop');
      }
      if (stopReason === 'refusal') throw new LlmError('refused', 'the model refused');
      if (stopReason === 'max_tokens') {
        throw new LlmError('invalid_output', 'the answer was cut off at the token limit');
      }
      const now = this.deps.clock.now();
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
    } finally {
      aborted.dispose();
      if (reader) reader.cancel().catch(() => undefined);
    }
  }

  private async postJson(
    req: Parameters<typeof buildRequestBody>[0],
    signal: AbortSignal,
  ): Promise<ParsedMessage> {
    const aborted = abortPromise(signal);
    try {
      const response = await Promise.race([
        this.deps.fetch(messagesUrl(this.deps.config.baseUrl), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(buildRequestBody(req)),
          signal,
        }),
        aborted.promise,
      ]);
      if (!response.ok) throw await this.httpError(response);
      let body: unknown;
      try {
        body = await Promise.race([response.json(), aborted.promise]);
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (signal.aborted) throw abortToError(signal);
        throw new LlmError('unavailable', 'provider response body was not valid JSON');
      }
      return parseMessageResponse(body);
    } finally {
      aborted.dispose();
    }
  }

  private async httpError(response: Response): Promise<LlmError> {
    let text = '';
    try {
      text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    } catch {
      // The status code still classifies the error.
    }
    return errorFromHttp(response.status, text, response.headers.get('retry-after'));
  }

  /** Normalises anything thrown while calling the provider into a typed LlmError. */
  private toLlmError(e: unknown, signal: AbortSignal): LlmError {
    if (e instanceof LlmError) return e;
    if (signal.aborted) return abortToError(signal);
    // Network failure, DNS, TLS, a body that died mid-read. The message is not echoed: it can carry URLs.
    return new LlmError('unavailable', 'could not reach the provider');
  }
}

type Validated<T> = { ok: true; value: T } | { ok: false; problem: string };

/** JSON-parses (tolerating a code fence) and validates with the caller's zod schema. */
function validateOutput<T>(text: string, schema: StructuredRequest<T>['schema']): Validated<T> {
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

/** A promise that rejects when `signal` aborts, so a fetch or reader that ignores the signal cannot hang us. */
function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortToError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => undefined); // never an unhandled rejection when nobody is racing it any more
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}
