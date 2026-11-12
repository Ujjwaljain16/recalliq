import type { CrawlBasis, SearchRequest } from '../shared/search.js';
import { parseSourceStructure } from '../sources/structure.js';

/**
 * Content sufficiency for a live-crawl request.
 *
 * Why it exists: a live crawl that does not finish is not reported. The provider answers HTTP 200 with no error
 * and no marker, and the text is silently short (observed: 87, 131 and 186 characters for a 1,500-character
 * budget). Such a result is not a page as it stands now, so a request for a live crawl cannot be read as having
 * produced one. The rule below is deterministic and uses only the text and the requested budget.
 *
 * A text-mode result is sufficient when ALL of these hold:
 *  1. its trimmed length is at least `MIN_CONTENT_CHARS` (400), an absolute floor;
 *  2. its trimmed length is at least `min(ceil(0.5 * budget), MAX_REQUIRED_CHARS)`, where `budget` is the
 *     requested per-result character budget (the 1,500 cap keeps a 6,000 budget from rejecting a genuinely
 *     short page);
 *  3. it is structured, or long: it has at least one heading or table (`parseSourceStructure`), or its trimmed
 *     length is at least `LONG_BODY_CHARS` (1,200), enough to be a body of prose rather than a stub.
 *
 * Highlights-mode results are excerpts chosen by the provider, so their length says nothing about whether the
 * crawl finished: they are never sufficient. The rule can only make a result `unknown`; it never upgrades one.
 */
export const MIN_CONTENT_CHARS = 400;
export const BUDGET_FRACTION = 0.5;
export const MAX_REQUIRED_CHARS = 1500;
export const LONG_BODY_CHARS = 1200;

export function isSufficientContent(
  text: string,
  contentChars: number,
  contentMode: SearchRequest['contentMode'],
): boolean {
  if (contentMode !== 'text') return false;
  const len = text.trim().length;
  const required = Math.max(
    MIN_CONTENT_CHARS,
    Math.min(Math.ceil(BUDGET_FRACTION * contentChars), MAX_REQUIRED_CHARS),
  );
  if (len < required) return false;
  if (len >= LONG_BODY_CHARS) return true;
  const structure = parseSourceStructure(text);
  return structure.headings.length > 0 || structure.tables.length > 0;
}

export interface CrawlEvidence {
  freshness: SearchRequest['freshness'];
  contentMode: SearchRequest['contentMode'];
  contentChars: number;
  text: string;
  /** The provider's own per-result crawl marker, when it sent one. */
  marker: { crawlStatus: 'ok' | 'failed' | 'unknown'; source: string | undefined } | undefined;
}

/**
 * The single place that maps a result to a `CrawlBasis`. Order matters:
 *  1. a per-result marker reporting a successful live crawl, on a live request: `confirmed_live`;
 *  2. a failed crawl: `unknown`;
 *  3. a per-result marker saying the content was cached: `cached`;
 *  4. a live request: `requested_live` if the content is sufficient, otherwise `unknown`;
 *  5. a request that allowed cached content: `cached`.
 * A successful HTTP response and a `maxAgeHours: 0` request are never enough for step 1.
 */
export function classifyCrawlBasis(e: CrawlEvidence): CrawlBasis {
  const m = e.marker;
  if (e.freshness === 'live' && m?.crawlStatus === 'ok' && m.source === 'live') {
    return 'confirmed_live';
  }
  if (m?.crawlStatus === 'failed') return 'unknown';
  if (m?.source === 'cached') return 'cached';
  if (e.freshness === 'live') {
    return isSufficientContent(e.text, e.contentChars, e.contentMode)
      ? 'requested_live'
      : 'unknown';
  }
  return 'cached';
}
