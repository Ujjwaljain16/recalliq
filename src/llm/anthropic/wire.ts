/**
 * THE ONE MODULE THAT KNOWS THE ANTHROPIC MESSAGES API WIRE FORMAT.
 *
 * Verified against the public documentation on 2026-11-12 (platform.claude.com/docs: streaming, errors,
 * structured outputs, prompt caching), not against a live call (no API key was available):
 *   - POST {base}/v1/messages with headers x-api-key, anthropic-version, content-type: application/json;
 *   - body: model, max_tokens, messages, system (array of text blocks, cache_control {type:'ephemeral'}),
 *     stream, output_config.format {type:'json_schema', schema}, output_config.effort, thinking {type};
 *   - non-streaming response: content[] blocks, the JSON answer is in the `text` block; stop_reason; usage with
 *     input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens;
 *   - streaming events: message_start, content_block_start/delta/stop, message_delta (cumulative usage,
 *     stop_reason), message_stop, ping, error; deltas of type text_delta, thinking_delta, input_json_delta;
 *   - errors: JSON {type:'error', error:{type, message}} with HTTP 400/401/402/403/404/413/429/500/504/529;
 *   - the JSON Schema subset of structured outputs (numeric/string/array-size constraints are rejected).
 * Sonnet 5.5 rejects forced tool use, so structured output uses output_config.format, never tool_choice.
 * If any of this is wrong, it is wrong here only. No provider type leaves this module.
 */
import { z } from 'zod';
import { LlmError, type LlmUsage } from '../../shared/llm.js';
import type { SseMessage } from '../sse-parser.js';
import type { TierConfig } from '../config.js';

export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export interface WireMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface WireRequest {
  tier: TierConfig;
  system: string;
  messages: WireMessage[];
  maxTokens: number;
  stream: boolean;
  /** JSON Schema already reduced to the supported subset. */
  jsonSchema?: Record<string, unknown>;
}

export function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

export function messagesUrl(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
}

/**
 * The provider requires alternating roles starting with a user turn. Consecutive same-role turns are merged
 * and a leading assistant turn gets a neutral user turn in front of it, so no content is dropped.
 */
export function normalizeMessages(messages: readonly WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(conversation start)' });
  return out;
}

export function buildRequestBody(req: WireRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.tier.model,
    max_tokens: req.maxTokens,
    messages: normalizeMessages(req.messages),
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
  };
  if (req.stream) body.stream = true;
  if (req.tier.thinking) body.thinking = { type: req.tier.thinking };
  const outputConfig: Record<string, unknown> = {};
  if (req.tier.effort) outputConfig.effort = req.tier.effort;
  if (req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  return body;
}

const UNSUPPORTED_KEYS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'propertyNames',
  'unevaluatedProperties',
  'format',
]);

/** Keys whose value is a map from a name to a schema: the names are data, never keywords to filter. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);

/**
 * Reduces a JSON Schema to what structured outputs accept. Dropped constraints are still enforced locally:
 * the caller always validates the model output with the zod schema, which stays authoritative.
 */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { unrepresentable: 'any' });
  const reduced = reduce(raw);
  return typeof reduced === 'object' && reduced !== null && !Array.isArray(reduced)
    ? (reduced as Record<string, unknown>)
    : {};
}

function reduce(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(reduce);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === 'minItems' && value !== 0 && value !== 1) continue;
    if (key === 'additionalProperties' && value !== false) continue;
    out[key] = SCHEMA_MAPS.has(key) ? reduceMap(value) : reduce(value);
  }
  return out;
}

function reduceMap(map: unknown): unknown {
  if (typeof map !== 'object' || map === null) return map;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, reduce(v)]));
}

// ── responses ──

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
});
type WireUsage = z.infer<typeof usageSchema>;

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Only the fields a usage object actually carries (message_delta usage is cumulative and may be partial). */
export function partialUsage(u: WireUsage | undefined): Partial<LlmUsage> {
  const out: Partial<LlmUsage> = {};
  if (!u) return out;
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.cache_read_input_tokens != null) out.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) out.cacheWriteTokens = u.cache_creation_input_tokens;
  return out;
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const messageResponseSchema = z.object({
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
  usage: usageSchema.optional(),
});

export interface ParsedMessage {
  text: string;
  stopReason: string | null;
  model: string | null;
  usage: LlmUsage;
}

/** Parses a non-streaming response body. Throws LlmError('unavailable') when it is not a message. */
export function parseMessageResponse(body: unknown): ParsedMessage {
  const parsed = messageResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new LlmError('unavailable', 'provider returned a response that is not a message');
  }
  const text = parsed.data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return {
    text,
    stopReason: parsed.data.stop_reason ?? null,
    model: parsed.data.model ?? null,
    usage: { ...ZERO_USAGE, ...partialUsage(parsed.data.usage) },
  };
}

const errorBodySchema = z.object({
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose(),
});

/** Maps a provider error type (HTTP body or in-stream) and optional status to a typed LlmError. */
export function errorFromType(
  type: string | undefined,
  status: number | undefined,
  message: string,
  retryAfterMs?: number,
): LlmError {
  if (type === 'rate_limit_error' || status === 429)
    return new LlmError('rate_limited', message, retryAfterMs);
  if (type === 'timeout_error' || status === 408 || status === 504)
    return new LlmError('timeout', message);
  if (
    type === 'overloaded_error' ||
    type === 'api_error' ||
    (status !== undefined && status >= 500)
  )
    return new LlmError('unavailable', message);
  if (
    type === 'authentication_error' ||
    type === 'permission_error' ||
    type === 'billing_error' ||
    status === 401 ||
    status === 402 ||
    status === 403
  )
    return new LlmError('unavailable', `${message} (provider access problem)`);
  return new LlmError('bad_request', message);
}

/** Seconds (the form the provider sends) to milliseconds; an HTTP-date or garbage gives undefined. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const s = Number(header.trim());
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

/** Builds the error for a non-2xx response. `bodyText` is read by the caller, at most a bounded prefix. */
export function errorFromHttp(
  status: number,
  bodyText: string,
  retryAfter: string | null,
): LlmError {
  let type: string | undefined;
  let message = `provider returned HTTP ${status}`;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      type = parsed.data.error.type;
      if (parsed.data.error.message) message = `${message}: ${parsed.data.error.message}`;
    }
  } catch {
    // Not JSON (a proxy page, for example): the status alone decides.
  }
  return errorFromType(type, status, message, parseRetryAfter(retryAfter));
}

// ── stream events ──

export type ProviderStreamEvent =
  | { type: 'start'; model: string | null; usage: Partial<LlmUsage> }
  | { type: 'text'; text: string }
  | { type: 'finish'; stopReason: string | null; usage: Partial<LlmUsage> }
  | { type: 'stop' }
  | { type: 'ignored' };

const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({ model: z.string().optional(), usage: usageSchema.optional() }).loose(),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    delta: z.object({ type: z.string(), text: z.string().optional() }).loose(),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullable().optional() }).loose(),
    usage: usageSchema.optional(),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({
    type: z.literal('error'),
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose(),
  }),
]);

/**
 * Interprets one SSE message. Throws LlmError for an in-stream `error` event and for malformed JSON in an
 * event. Unknown event types (the provider may add new ones) and `ping` are `ignored`.
 */
export function parseStreamEvent(m: SseMessage): ProviderStreamEvent {
  if (m.event === 'ping') return { type: 'ignored' };
  let json: unknown;
  try {
    json = JSON.parse(m.data);
  } catch {
    throw new LlmError('unavailable', `malformed provider stream event "${m.event}"`);
  }
  const parsed = streamEventSchema.safeParse(json);
  if (!parsed.success) return { type: 'ignored' };
  const e = parsed.data;
  switch (e.type) {
    case 'message_start':
      return {
        type: 'start',
        model: e.message.model ?? null,
        usage: partialUsage(e.message.usage),
      };
    case 'content_block_delta':
      return e.delta.type === 'text_delta' && e.delta.text
        ? { type: 'text', text: e.delta.text }
        : { type: 'ignored' };
    case 'message_delta':
      return {
        type: 'finish',
        stopReason: e.delta.stop_reason ?? null,
        usage: partialUsage(e.usage),
      };
    case 'message_stop':
      return { type: 'stop' };
    case 'error':
      throw errorFromType(e.error.type, undefined, e.error.message ?? 'provider stream error');
  }
}
