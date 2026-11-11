import { normalizeUrl } from '../../sources/url.js';
import type { SearchHit, SearchRequest } from '../../shared/search.js';
import { MAX_CONTENT_CHARS } from '../../search/exa-request.js';
import type { PageFile } from './gold.js';

/**
 * The one search request shape used to capture calibration pages: the product's pricing request (full text,
 * the 6000-character budget) restricted to one vendor domain. Pure.
 */
export function captureRequest(query: string, domain: string, numResults: number): SearchRequest {
  return {
    query,
    numResults,
    includeDomains: [domain],
    freshness: 'cached',
    contentMode: 'text',
    contentChars: MAX_CONTENT_CHARS,
  };
}

/** A captured page record for one search hit. The text is stored exactly as returned. */
export function pageFromHit(
  hit: SearchHit,
  meta: { provider: string; capturedAt: number; requestId?: string },
): PageFile {
  const page: PageFile = {
    url: hit.url,
    urlNorm: normalizeUrl(hit.url).urlNorm,
    capturedAt: new Date(meta.capturedAt).toISOString(),
    provider: meta.provider,
    title: hit.title,
    text: hit.text,
  };
  if (meta.requestId !== undefined) page.requestId = meta.requestId;
  return page;
}
