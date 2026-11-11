import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { extractedStatementSchema } from '../../evidence/prompts/extraction.js';
import { analysisModelSchema } from '../../llm/analysis/schema.js';
import { recordingFileSchema } from '../../search/recording.js';
import type { SearchHit } from '../../shared/search.js';

/**
 * The input of the replay component set: what the search provider and the model would have said. Hand
 * authored data is labelled synthetic; nothing here is a recording of a real provider unless `class` says so.
 * Only the two provider adapters read it: every other component of the application is the real one.
 */

/**
 * The stand-in for a provider's per-result crawl marker. A recorded or authored result is only a live (fresh)
 * fetch if it carries this marker saying so; without it the result's freshness is unknown. There is deliberately no
 * `freshFetch` flag and no default: a hit that claims freshness must say where the claim comes from, and a
 * fixture that omits the marker never becomes a confirmed live crawl.
 */
const providerMarker = z.strictObject({
  source: z.enum(['live', 'cached']),
  status: z.enum(['ok', 'failed']),
});

const searchHit = z.strictObject({
  url: z.string(),
  title: z.string().nullable().default(null),
  text: z.string(),
  publishedAt: z.number().nullable().default(null),
  lastUpdatedAt: z.number().nullable().default(null),
  providerScore: z.number().nullable().default(null),
  marker: providerMarker.optional(),
});

export type FixtureSearchHit = z.infer<typeof searchHit>;

/** The shared hit a fixture result stands for: confirmed only through the marker, unknown otherwise. */
export function toSearchHit(h: FixtureSearchHit): SearchHit {
  const confirmed = h.marker?.source === 'live' && h.marker.status === 'ok';
  return {
    url: h.url,
    title: h.title,
    text: h.text,
    publishedAt: h.publishedAt,
    lastUpdatedAt: h.lastUpdatedAt,
    providerScore: h.providerScore,
    freshFetch: confirmed,
    crawlStatus: h.marker?.status ?? 'unknown',
    crawlBasis: confirmed ? 'confirmed_live' : h.marker?.source === 'cached' ? 'cached' : 'unknown',
  };
}

const searchStep = z.union([
  z.object({
    error: z.enum([
      'rate_limited',
      'quota_exhausted',
      'unavailable',
      'timeout',
      'cancelled',
      'bad_request',
    ]),
  }),
  z.object({ hits: z.array(searchHit), observedAt: z.number().optional() }),
]);

/** Answers to one search query, consumed in order: the first call gets the first step, and so on. */
const searchEntry = z.object({ query: z.string().min(1), steps: z.array(searchStep).min(1) });

export const replayFixtureSchema = z.object({
  version: z.literal(1),
  class: z.enum(['synthetic', 'recorded']),
  label: z.string().min(1),
  /** Recorded exchanges keyed by request hash (see src/search/recording.ts), paths relative to this file. */
  searchRecordings: z.array(z.string()).default([]),
  search: z.array(searchEntry).default([]),
  llm: z
    .object({
      analysis: z
        .array(z.object({ whenMessageContains: z.string().min(1), reply: analysisModelSchema }))
        .default([]),
      /**
       * A statement the model "extracts": it applies to any batch that contains the named entity and a source
       * whose text contains `sourceContains`. The source and entity refs (S1, E1) are worked out from the prompt.
       */
      extraction: z
        .array(
          z.object({
            entity: z.string().min(1),
            sourceContains: z.string().min(1),
            statement: extractedStatementSchema.omit({ sourceId: true, entityId: true }),
          }),
        )
        .default([]),
      /** `{{M1}}` in a delta stands for the first recalled message id of the prompt, `{{M2}}` the second. */
      synthesis: z
        .array(
          z.object({
            whenMessageContains: z.string().optional(),
            whenDataContains: z.string().optional(),
            deltas: z.array(z.string()),
            failWith: z
              .enum(['rate_limited', 'unavailable', 'timeout', 'refused', 'invalid_output'])
              .optional(),
          }),
        )
        .default([]),
      judge: z.array(z.object({ whenContains: z.string(), reply: z.unknown() })).default([]),
    })
    .default({ analysis: [], extraction: [], synthesis: [], judge: [] }),
});

export type ReplayFixture = z.output<typeof replayFixtureSchema>;
export type ReplayFixtureInput = z.input<typeof replayFixtureSchema>;

export function parseReplayFixture(value: unknown): ReplayFixture {
  return replayFixtureSchema.parse(value);
}

export function loadReplayFixture(file: string): {
  fixture: ReplayFixture;
  recordings: Array<z.output<typeof recordingFileSchema>>;
} {
  const fixture = parseReplayFixture(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  const dir = path.dirname(file);
  const recordings = fixture.searchRecordings.map((p) =>
    recordingFileSchema.parse(JSON.parse(fs.readFileSync(path.resolve(dir, p), 'utf8')) as unknown),
  );
  return { fixture, recordings };
}
