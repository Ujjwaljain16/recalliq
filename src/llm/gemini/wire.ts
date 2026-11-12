/**
 * THE ONE MODULE THAT KNOWS THE GEMINI DEVELOPER API (generativelanguage.googleapis.com) WIRE FORMAT.
 * No Gemini type leaves this directory.
 *
 * VERIFIED against the public documentation on 2026-11-12 (aistudio.google.com/api-reference/generate-content,
 * /docs/structured-output, /docs/troubleshooting, /docs/api-errors), not against a live call (no key):
 *   - generateContent is POST /v1beta/models/{model}:generateContent and streamGenerateContent is
 *     POST /v1beta/models/{model}:streamGenerateContent;
 *   - request: contents[] (role user|model, parts[].text), systemInstruction (Content, text parts),
 *     generationConfig {maxOutputTokens, temperature, responseMimeType (text/plain|application/json),
 *     responseJsonSchema (the documented field; the page calls responseSchema internal), thinkingConfig
 *     {includeThoughts, thinkingBudget, thinkingLevel}};
 *   - response: candidates[].content.parts[].text, candidates[].finishReason (STOP, MAX_TOKENS, SAFETY,
 *     RECITATION, LANGUAGE, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII, MALFORMED_*, ...),
 *     promptFeedback.blockReason (no candidates when set), usageMetadata {promptTokenCount,
 *     cachedContentTokenCount, candidatesTokenCount, toolUsePromptTokenCount, thoughtsTokenCount,
 *     totalTokenCount}, modelVersion;
 *   - transient errors are 429, 408 and 5xx (retry with backoff and jitter); 400, 402, 403 are not retried;
 *     429 means a per-minute limit or an exhausted daily quota;
 *   - structured output supports type, enum, properties, required, items, anyOf, additionalProperties,
 *     minItems/maxItems, minimum/maximum, description, and nullability as anyOf with the null type.
 *
 * ASSUMED (documentation fetched did not show it; all isolated here, to be confirmed by the first live run):
 *   A1. The host is https://generativelanguage.googleapis.com and the API key goes in `x-goog-api-key`
 *       (the header is shown in the docs' curl examples for another endpoint of the same API).
 *   A2. `?alt=sse` on streamGenerateContent makes the body text/event-stream where each `data:` line is a
 *       complete GenerateContentResponse JSON object, the last carrying finishReason and usageMetadata; there
 *       is no `[DONE]` sentinel. Taken from the coordinator's brief and prior knowledge, not from the docs.
 *   A3. A non-2xx body is {error:{code, message, status, details?}} and a 429 may carry a details entry with
 *       `retryDelay` such as "30s" (google.rpc.RetryInfo). The errors page fetched documents only code/message.
 *   A4. thoughtsTokenCount is billed as output; it is folded into LlmUsage.outputTokens because LlmUsage has no
 *       field for it. promptTokenCount includes cached tokens, so inputTokens = prompt - cached.
 * Nothing here enables a tool (no googleSearch, no urlContext): our SearchPort is the only search capability.
 */
import { z } from 'zod';
import { LlmError, type LlmUsage } from '../../shared/llm.js';
import type { SseMessage } from '../sse-parser.js';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GeminiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeminiThinking {
  level?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  budget?: number;
}

export interface GeminiRequest {
  system: string;
  messages: GeminiMessage[];
  maxOutputTokens: number;
  temperature?: number;
  thinking?: GeminiThinking;
  /** JSON Schema already reduced to the supported subset. */
  jsonSchema?: Record<string, unknown>;
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
}

export function geminiUrl(baseUrl: string | undefined, model: string, stream: boolean): string {
  const base = (baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const name = encodeURIComponent(model.replace(/^models\//, ''));
  return stream
    ? `${base}/v1beta/models/${name}:streamGenerateContent?alt=sse`
    : `${base}/v1beta/models/${name}:generateContent`;
}

/** Merges consecutive same-role turns and makes the conversation start with a user turn. */
export function toContents(
  messages: readonly GeminiMessage[],
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const out: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'model';
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const part = last.parts[0];
      if (part) part.text = `${part.text}\n\n${m.content}`;
    } else out.push({ role, parts: [{ text: m.content }] });
  }
  if (out[0]?.role === 'model')
    out.unshift({ role: 'user', parts: [{ text: '(conversation start)' }] });
  return out;
}

export function buildGeminiBody(req: GeminiRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens };
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = req.jsonSchema;
  }
  if (req.thinking) {
    const t: Record<string, unknown> = {};
    if (req.thinking.level) t.thinkingLevel = req.thinking.level;
    if (req.thinking.budget !== undefined) t.thinkingBudget = req.thinking.budget;
    generationConfig.thinkingConfig = t;
  }
  // Deliberately no `tools` field: no search grounding, no URL context, no function calling.
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toContents(req.messages),
    generationConfig,
  };
}

const UNSUPPORTED_KEYS = new Set([
  '$schema',
  'pattern',
  'minLength',
  'maxLength',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'propertyNames',
  'unevaluatedProperties',
  'uniqueItems',
  'default',
  // Documented as supported, but the real API rejected a schema containing them with HTTP 400
  // INVALID_ARGUMENT (observed 2026-11-12 with gemini-3.5-flash-lite). They are dropped here and enforced locally
  // by the zod schema every response is validated against.
  'maxItems',
  'minItems',
  'minimum',
  'maximum',
]);
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);
const SUPPORTED_FORMATS = new Set(['date-time', 'date', 'time']);

/**
 * Reduces zod's JSON Schema to the subset Gemini documents. Dropped constraints are still enforced locally:
 * every response is validated with the caller's zod schema.
 */
export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const reduced = reduce(z.toJSONSchema(schema, { unrepresentable: 'any' }));
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
    if (key === 'format' && !(typeof value === 'string' && SUPPORTED_FORMATS.has(value))) continue;
    if (key === 'additionalProperties' && typeof value !== 'boolean') continue;
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
  promptTokenCount: z.number().optional(),
  cachedContentTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  toolUsePromptTokenCount: z.number().optional(),
  thoughtsTokenCount: z.number().optional(),
});

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({ text: z.string().optional(), thought: z.boolean().optional() }).loose(),
              )
              .optional(),
          })
          .loose()
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: usageSchema.optional(),
  modelVersion: z.string().optional(),
});

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function toUsage(u: z.infer<typeof usageSchema> | undefined): LlmUsage {
  if (!u) return ZERO_USAGE;
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached) + (u.toolUsePromptTokenCount ?? 0),
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const REFUSAL_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

/** What one GenerateContentResponse (a full reply, or one stream chunk) says. */
export interface Interpreted {
  /** Non-thought text of the first candidate. */
  text: string;
  /** Set when this response carries a finish reason. */
  finish: 'stop' | 'max_tokens' | null;
  usage: LlmUsage | null;
  model: string | null;
}

/**
 * Interprets a parsed response body. Throws LlmError('refused') for a blocked prompt or a safety-type finish
 * and LlmError('invalid_output') for any other abnormal finish. MAX_TOKENS is reported, not thrown, because
 * the callers treat it differently (a structured call fails at once, a stream delivers its text first).
 * A body with neither candidates nor a block is `invalid_output` only for a full reply: `requireCandidate`.
 */
export function interpretResponse(body: unknown, requireCandidate: boolean): Interpreted {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new LlmError('unavailable', 'provider returned an unrecognised response');
  const r = parsed.data;
  const block = r.promptFeedback?.blockReason;
  if (block && block !== 'BLOCK_REASON_UNSPECIFIED') {
    throw new LlmError('refused', `the prompt was blocked (${block})`);
  }
  const usage = r.usageMetadata ? toUsage(r.usageMetadata) : null;
  const candidate = r.candidates?.[0];
  if (!candidate) {
    if (requireCandidate) throw new LlmError('invalid_output', 'the response had no candidate');
    return { text: '', finish: null, usage, model: r.modelVersion ?? null };
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? '')
    .join('');
  const reason = candidate.finishReason;
  let finish: Interpreted['finish'] = null;
  if (reason === 'STOP') finish = 'stop';
  else if (reason === 'MAX_TOKENS') finish = 'max_tokens';
  else if (reason && reason !== 'FINISH_REASON_UNSPECIFIED') {
    if (REFUSAL_FINISH.has(reason)) throw new LlmError('refused', `the model stopped (${reason})`);
    throw new LlmError('invalid_output', `the model stopped abnormally (${reason})`);
  }
  return { text, finish, usage, model: r.modelVersion ?? null };
}

// ── errors ──

const errorBodySchema = z.object({
  error: z
    .object({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
      status: z.string().optional(),
      details: z.array(z.object({ retryDelay: z.string().optional() }).loose()).optional(),
    })
    .loose(),
});

/** "30s", "0.5s" or "1.2s" (a protobuf Duration) to milliseconds. */
export function parseDuration(s: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(s ?? '');
  return m?.[1] === undefined ? undefined : Math.round(Number(m[1]) * 1000);
}

/** Retry-After in seconds (the only form handled); anything else is undefined. */
export function parseRetryAfterHeader(h: string | null): number | undefined {
  if (h === null) return undefined;
  const s = Number(h.trim());
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

/**
 * A daily quota will not come back within a turn, so waiting for it is pointless. The documented 429 codes
 * are rate_limit_exceeded / too_many_requests (wait) and quota_exceeded (daily: stop).
 */
export function looksLikeDailyQuota(message: string, status: string | undefined): boolean {
  return /per ?day|daily|quota_exceeded/i.test(message) || /quota_exceeded/i.test(status ?? '');
}

export interface GeminiHttpError {
  error: LlmError;
  /** True when waiting and trying again could help (transient). */
  transient: boolean;
}

export function errorFromHttp(
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
): GeminiHttpError {
  let message = `provider returned HTTP ${status}`;
  let statusText: string | undefined;
  let hint = parseRetryAfterHeader(retryAfterHeader);
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      const e = parsed.data.error;
      statusText = e.status;
      if (e.message) message = `${message}: ${e.message}`;
      hint ??= parseDuration(e.details?.find((d) => d.retryDelay)?.retryDelay);
    }
  } catch {
    // Not JSON: the status alone decides.
  }
  if (status === 429 || statusText === 'RESOURCE_EXHAUSTED') {
    const daily = looksLikeDailyQuota(message, statusText);
    return { error: new LlmError('rate_limited', message, hint), transient: !daily };
  }
  if (status === 408 || status === 504 || statusText === 'DEADLINE_EXCEEDED') {
    return { error: new LlmError('timeout', message), transient: true };
  }
  if (status >= 500) return { error: new LlmError('unavailable', message), transient: true };
  if (status === 401 || status === 402 || status === 403) {
    return {
      error: new LlmError('unavailable', `${message} (provider access problem)`),
      transient: false,
    };
  }
  return { error: new LlmError('bad_request', message), transient: false };
}

/** An error object delivered inside a stream chunk, or null when the chunk is not one. */
export function errorFromChunk(json: unknown): GeminiHttpError | null {
  const parsed = errorBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const code = Number(parsed.data.error.code);
  return errorFromHttp(Number.isFinite(code) ? code : 500, JSON.stringify(json), null);
}

/** One SSE message to a parsed chunk (throws unavailable on malformed JSON). */
export function parseChunk(m: SseMessage): unknown {
  try {
    return JSON.parse(m.data);
  } catch {
    throw new LlmError('unavailable', 'malformed provider stream chunk');
  }
}
