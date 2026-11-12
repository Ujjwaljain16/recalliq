import type { Ms } from './ids.js';

export interface SearchRequest {
  query: string;
  /** 1..10 */
  numResults: number;
  includeDomains?: string[];
  startPublishedDate?: Ms;
  endPublishedDate?: Ms;
  category?: 'news';
  /** `live` asks the provider for a fresh crawl. */
  freshness: 'cached' | 'live';
  /** ≤ 5000 */
  liveTimeoutMs?: number;
  /** Pricing uses `text` so headings and tables survive for subject association. */
  contentMode: 'text' | 'highlights';
  /** Per-result excerpt budget, ≤ 6000. */
  contentChars: number;
}

/**
 * What a result's freshness rests on. Four distinct states:
 * - `confirmed_live`: the provider reported, for this result, that a live crawl succeeded (a per-result marker;
 *   neither an HTTP 200 nor a `maxAgeHours: 0` request can establish it);
 * - `requested_live`: a live crawl was requested and the content is sufficient, but nothing per result confirms it;
 * - `cached`: the request allowed cached content, or the provider marked the result cached;
 * - `unknown`: anything else, including a live request whose content is too short or too thin to trust.
 * Only `confirmed_live` has any effect on belief status, `displayedAt` or a detector verdict.
 */
export type CrawlBasis = 'confirmed_live' | 'requested_live' | 'cached' | 'unknown';

export interface SearchHit {
  url: string;
  title: string | null;
  text: string;
  /** Provider metadata; stored as snapshot.provider_*. A hint, never ground truth. */
  publishedAt: Ms | null;
  lastUpdatedAt: Ms | null;
  providerScore: number | null;
  /** True only if a live fetch was requested AND this result's crawl succeeded. */
  freshFetch: boolean;
  /** Absent on hits from older recordings or scripted sources; the store then derives it from `freshFetch`. */
  crawlBasis?: CrawlBasis;
  crawlStatus: 'ok' | 'failed' | 'unknown';
}

export interface SearchResponse {
  provider: string;
  hits: SearchHit[];
  droppedMalformed: number;
  latencyMs: number;
  costUsd: number | null;
  observedAt: Ms;
}

export type SearchErrorCode =
  'rate_limited' | 'quota_exhausted' | 'unavailable' | 'timeout' | 'cancelled' | 'bad_request';

export class SearchError extends Error {
  constructor(
    public readonly code: SearchErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Never caught by the retry policy: a replay miss must fail the run loudly. */
export class ReplayMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMissError';
  }
}

export interface SearchPort {
  readonly provider: string;
  search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}
