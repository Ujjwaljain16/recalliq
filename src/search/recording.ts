import { z } from 'zod';
import type { SearchRequest, SearchResponse } from '../shared/search.js';

/**
 * One recorded request/response pair. `providerRaw` keeps the provider's own body (parsed JSON, unmodified) so
 * provider fields the contract has no place for (for example per-result `statuses[].source`) are not lost.
 * Recordings never contain credentials: the request is the provider-independent `SearchRequest`.
 */
export interface RecordedExchange {
  key: string;
  request: SearchRequest;
  response: SearchResponse;
  providerRaw?: unknown;
}

const hitSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string(),
  publishedAt: z.number().nullable(),
  lastUpdatedAt: z.number().nullable(),
  providerScore: z.number().nullable(),
  freshFetch: z.boolean(),
  crawlBasis: z.enum(['confirmed_live', 'requested_live', 'cached', 'unknown']).optional(),
  crawlStatus: z.enum(['ok', 'failed', 'unknown']),
});

const recordedExchangeBase = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  request: z.looseObject({}),
  response: z.object({
    provider: z.string(),
    hits: z.array(hitSchema),
    droppedMalformed: z.number().int().min(0),
    latencyMs: z.number(),
    costUsd: z.number().nullable(),
    observedAt: z.number(),
  }),
  providerRaw: z.unknown().optional(),
});

/**
 * A recorded hit may claim a confirmed live crawl (freshFetch true) only if the exchange keeps the provider's own
 * body, which is where the per-result marker is. A claim with nothing to trace it to is refused, so a recording
 * can never turn an unknown freshness into a confirmed one.
 */
export const recordedExchangeSchema = recordedExchangeBase.refine(
  (x) => x.providerRaw !== undefined || x.response.hits.every((h) => !h.freshFetch),
  {
    message:
      'a hit with freshFetch true needs the provider body (providerRaw) that carries its marker',
  },
);

/** A recording file. `class` says whether it is real provider output or hand-authored. */
export const recordingFileSchema = z.object({
  version: z.literal(1),
  class: z.enum(['real', 'synthetic']),
  label: z.string().min(1),
  exchanges: z.array(recordedExchangeSchema),
});
export type RecordingFile = z.infer<typeof recordingFileSchema>;

export type RecordSink = (exchange: RecordedExchange) => void;
