import { z } from 'zod';
import { SearchError, type SearchRequest } from '../shared/search.js';

export const MAX_CONTENT_CHARS = 6000;
export const MAX_LIVE_TIMEOUT_MS = 5000;

const requestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  numResults: z.number().int().min(1).max(10),
  includeDomains: z.array(z.string().min(1).max(253)).max(1200).optional(),
  startPublishedDate: z.number().int().optional(),
  endPublishedDate: z.number().int().optional(),
  category: z.literal('news').optional(),
  freshness: z.enum(['cached', 'live']),
  liveTimeoutMs: z.number().int().min(1).max(MAX_LIVE_TIMEOUT_MS).optional(),
  contentMode: z.enum(['text', 'highlights']),
  contentChars: z.number().int().min(1).max(MAX_CONTENT_CHARS),
});

/** Throws `SearchError('bad_request')` for a request outside the contract's bounds. */
export function validateSearchRequest(req: SearchRequest): void {
  const r = requestSchema.safeParse(req);
  if (!r.success) {
    throw new SearchError(
      'bad_request',
      `Invalid search request: ${r.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  for (const d of [req.startPublishedDate, req.endPublishedDate]) {
    if (d !== undefined && Number.isNaN(new Date(d).getTime())) {
      throw new SearchError('bad_request', 'Invalid published date bound');
    }
  }
}

/** Builds the Exa `POST /search` JSON body. Pure. Contains no credential. */
export function buildExaBody(req: SearchRequest): Record<string, unknown> {
  validateSearchRequest(req);
  const contents: Record<string, unknown> = {};
  if (req.contentMode === 'text') contents.text = { maxCharacters: req.contentChars };
  else contents.highlights = { maxCharacters: req.contentChars };
  if (req.freshness === 'live') {
    contents.maxAgeHours = 0;
    contents.livecrawlTimeout = req.liveTimeoutMs ?? MAX_LIVE_TIMEOUT_MS;
  }
  const body: Record<string, unknown> = {
    query: req.query.trim(),
    numResults: req.numResults,
    contents,
  };
  if (req.includeDomains && req.includeDomains.length > 0) body.includeDomains = req.includeDomains;
  if (req.startPublishedDate !== undefined) {
    body.startPublishedDate = new Date(req.startPublishedDate).toISOString();
  }
  if (req.endPublishedDate !== undefined) {
    body.endPublishedDate = new Date(req.endPublishedDate).toISOString();
  }
  if (req.category) body.category = req.category;
  return body;
}
