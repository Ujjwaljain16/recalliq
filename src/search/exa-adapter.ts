import type { Clock } from '../shared/infrastructure.js';
import type { Ms } from '../shared/ids.js';
import {
  SearchError,
  type SearchErrorCode,
  type SearchHit,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../shared/search.js';
import { classifyCrawlBasis } from './crawl-basis.js';
import { buildExaBody, MAX_CONTENT_CHARS } from './exa-request.js';
import {
  exaEnvelopeSchema,
  exaResultSchema,
  exaStatusSchema,
  type ExaResult,
  type ExaStatus,
} from './exa-schema.js';
import type { RecordSink } from './recording.js';
import { requestKey } from './request-key.js';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ExaAdapterOptions {
  /** Injected from config (`secrets.exaApiKey`). Never logged, never part of an error message. */
  apiKey: string;
  fetch: FetchFn;
  clock: Clock;
  baseUrl?: string;
  /** When set, every successful exchange is handed over (with the provider's raw body) for recording. */
  record?: RecordSink;
}

const MAX_BODY_CHARS = 8_000_000;
const MAX_RETRY_AFTER_MS = 60_000;

export class ExaSearchAdapter implements SearchPort {
  readonly provider = 'exa';
  private readonly endpoint: string;

  constructor(private readonly opts: ExaAdapterOptions) {
    if (!opts.apiKey) throw new SearchError('bad_request', 'EXA_API_KEY is not configured');
    this.endpoint = `${(opts.baseUrl ?? 'https://api.exa.ai').replace(/\/+$/, '')}/search`;
  }

  async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    const body = buildExaBody(req);
    if (signal.aborted) throw abortError(signal);
    const started = this.opts.clock.now();

    let status: number;
    let retryAfter: string | null;
    let raw: string;
    try {
      const res = await this.opts.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': this.opts.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      raw = await res.text();
    } catch (e) {
      if (signal.aborted) throw abortError(signal);
      if (e instanceof SearchError) throw e;
      throw new SearchError('unavailable', 'Search provider unreachable');
    }
    if (signal.aborted) throw abortError(signal);

    if (status < 200 || status >= 300) throw httpError(status, retryAfter);

    const observedAt = this.opts.clock.now();
    const response = normaliseExaResponse(raw, req, {
      provider: this.provider,
      observedAt,
      latencyMs: Math.max(0, observedAt - started),
    });
    if (this.opts.record) {
      this.opts.record({
        key: requestKey(req),
        request: req,
        response,
        providerRaw: JSON.parse(raw) as unknown,
      });
    }
    return response;
  }
}

function abortError(signal: AbortSignal): SearchError {
  const reason: unknown = signal.reason;
  const name = reason instanceof Error ? reason.name : '';
  return name === 'TimeoutError'
    ? new SearchError('timeout', 'Search call timed out')
    : new SearchError('cancelled', 'Search call cancelled');
}

function parseRetryAfter(value: string | null): Ms | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  // HTTP-date form is not interpreted: the executor falls back to its own backoff.
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

function httpError(status: number, retryAfter: string | null): SearchError {
  // Response bodies are never echoed: they are untrusted and may reflect request content.
  const code: SearchErrorCode =
    status === 429
      ? 'rate_limited'
      : status === 402
        ? 'quota_exhausted'
        : status === 504 || status === 408
          ? 'timeout'
          : status >= 500
            ? 'unavailable'
            : 'bad_request';
  return new SearchError(
    code,
    `Search provider returned HTTP ${status}`,
    parseRetryAfter(retryAfter),
  );
}

/** Truncates to `max` UTF-16 units without splitting a surrogate pair. Does not otherwise touch the text. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Parses and normalises a raw Exa response body. Exported for tests. */
export function normaliseExaResponse(
  raw: string,
  req: SearchRequest,
  meta: { provider: string; observedAt: Ms; latencyMs: Ms },
): SearchResponse {
  if (raw.length > MAX_BODY_CHARS) {
    throw new SearchError('unavailable', 'Search response too large');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SearchError('unavailable', 'Search response is not JSON');
  }
  const env = exaEnvelopeSchema.safeParse(json);
  if (!env.success) throw new SearchError('unavailable', 'Search response has an unexpected shape');

  const statuses = new Map<string, ExaStatus>();
  for (const s of env.data.statuses ?? []) {
    const p = exaStatusSchema.safeParse(s);
    if (p.success) statuses.set(p.data.id, p.data);
  }

  const hits: SearchHit[] = [];
  let droppedMalformed = 0;
  for (const item of env.data.results) {
    const parsed = exaResultSchema.safeParse(item);
    const hit = parsed.success ? toHit(parsed.data, req, statuses) : null;
    if (hit) hits.push(hit);
    else droppedMalformed += 1;
  }
  return {
    provider: meta.provider,
    hits,
    droppedMalformed,
    latencyMs: meta.latencyMs,
    costUsd: env.data.costDollars?.total ?? null,
    observedAt: meta.observedAt,
  };
}

function crawlStatusOf(st: ExaStatus | undefined): SearchHit['crawlStatus'] {
  if (!st) return 'unknown';
  const s = st.status.toLowerCase();
  if (s === 'success') return 'ok';
  // Failure values are undocumented; any status naming an error or failure is treated as failed.
  if (s.includes('error') || s.includes('fail')) return 'failed';
  return 'unknown';
}

function toHit(
  r: ExaResult,
  req: SearchRequest,
  statuses: Map<string, ExaStatus>,
): SearchHit | null {
  if (!/^https?:\/\//i.test(r.url)) return null;
  const source =
    req.contentMode === 'highlights' ? (r.highlights ? r.highlights.join('\n\n') : r.text) : r.text;
  if (source === undefined || source.trim() === '') return null;
  const text = truncateText(source, Math.min(req.contentChars, MAX_CONTENT_CHARS));

  const st = (r.id !== undefined ? statuses.get(r.id) : undefined) ?? statuses.get(r.url);
  const crawlStatus = crawlStatusOf(st);
  const published = r.publishedDate ? Date.parse(r.publishedDate) : Number.NaN;
  // The basis is the only place a live request is interpreted. It never reads the HTTP status, and a
  // `maxAgeHours: 0` request alone cannot reach `confirmed_live`: that needs this result's own marker.
  const crawlBasis = classifyCrawlBasis({
    freshness: req.freshness,
    contentMode: req.contentMode,
    contentChars: Math.min(req.contentChars, MAX_CONTENT_CHARS),
    text,
    marker: st ? { crawlStatus, source: st.source } : undefined,
  });
  return {
    url: r.url,
    title: r.title ?? null,
    text,
    publishedAt: Number.isNaN(published) ? null : published,
    lastUpdatedAt: null,
    providerScore: r.score ?? null,
    // Equals `crawlBasis === 'confirmed_live'`: a live request AND a per-result marker reporting a successful
    // crawl whose source is "live". Exa search sends no such marker today, so this is false for real responses.
    freshFetch: crawlBasis === 'confirmed_live',
    crawlBasis,
    crawlStatus,
  };
}
