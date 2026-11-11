/**
 * THE ONE PLACE that encodes our assumptions about the Exa `POST /search` response shape.
 *
 * Source: the public Exa API reference (docs.exa.ai/reference/search and the contents-retrieval guide), read on
 * 2026-11-12. It documents `requestId?`, `results[]` (required), `costDollars?.total`, `searchTime?`, and per result
 * `title`, `url`, `id?`, `publishedDate?`, `text?`, `highlights?`. NOT verified against a live response (no key):
 *  - `statuses[]` (`{id, status, source}`) is documented for the `/contents` endpoint; whether `/search` returns it
 *    is UNVERIFIED. It is optional here; without it a hit's crawl status is `unknown` and `freshFetch` is false.
 *    Documented example values: `status: "success"`, `source: "cached"`. Failure values and any other `source`
 *    value are NOT documented. The raw `source` and `status` strings are kept.
 *  - `score` is not in the reference; accepted if present, otherwise null.
 *  - No per-result crawl or capture date is documented, so `lastUpdatedAt` is always null.
 * Unknown extra fields are tolerated (loose objects) and kept in recordings. If a live recording disagrees, change
 * only this file.
 */
import { z } from 'zod';

export const exaResultSchema = z.looseObject({
  id: z.string().optional(),
  url: z.string().min(1),
  title: z.string().nullish(),
  publishedDate: z.string().nullish(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  score: z.number().nullish(),
});
export type ExaResult = z.infer<typeof exaResultSchema>;

export const exaStatusSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  /** Documented example: "cached". Other values undocumented. */
  source: z.string().optional(),
});
export type ExaStatus = z.infer<typeof exaStatusSchema>;

/** `results` items are validated one by one later, so a single bad item cannot discard the response. */
export const exaEnvelopeSchema = z.looseObject({
  requestId: z.string().optional(),
  results: z.array(z.unknown()),
  costDollars: z.looseObject({ total: z.number().nullish() }).nullish(),
  searchTime: z.number().nullish(),
  statuses: z.array(z.unknown()).nullish(),
});
export type ExaEnvelope = z.infer<typeof exaEnvelopeSchema>;
