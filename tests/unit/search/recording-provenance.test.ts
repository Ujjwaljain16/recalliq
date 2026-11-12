import { describe, expect, it } from 'vitest';
import { recordingFileSchema } from '../../../src/search/recording.js';

const hit = (freshFetch: boolean) => ({
  url: 'https://acme.example/pricing',
  title: null,
  text: '[SYNTHETIC] page',
  publishedAt: null,
  lastUpdatedAt: null,
  providerScore: null,
  freshFetch,
  crawlStatus: freshFetch ? 'ok' : 'unknown',
});

const file = (freshFetch: boolean, providerRaw?: unknown) => ({
  version: 1,
  class: 'synthetic',
  label: '[SYNTHETIC] provenance',
  exchanges: [
    {
      key: 'a'.repeat(64),
      request: {},
      response: {
        provider: 'exa',
        hits: [hit(freshFetch)],
        droppedMalformed: 0,
        latencyMs: 1,
        costUsd: null,
        observedAt: 1,
      },
      ...(providerRaw === undefined ? {} : { providerRaw }),
    },
  ],
});

describe('a recording cannot turn unknown freshness into a confirmed live crawl', () => {
  it('a hit claiming freshFetch true with no provider body to trace it to is refused', () => {
    expect(recordingFileSchema.safeParse(file(true)).success).toBe(false);
  });

  it('the same claim is accepted when the provider body that carries the marker is kept', () => {
    const raw = {
      results: [{ url: 'https://acme.example/pricing' }],
      statuses: [{ source: 'live', status: 'success' }],
    };
    expect(recordingFileSchema.safeParse(file(true, raw)).success).toBe(true);
  });

  it('a hit that makes no freshness claim needs no provider body', () => {
    expect(recordingFileSchema.safeParse(file(false)).success).toBe(true);
  });
});
