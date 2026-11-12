import { describe, expect, it } from 'vitest';
import {
  BUDGET_FRACTION,
  classifyCrawlBasis,
  isSufficientContent,
  LONG_BODY_CHARS,
  MAX_REQUIRED_CHARS,
  MIN_CONTENT_CHARS,
} from '../../../src/search/crawl-basis.js';
import { normaliseExaResponse } from '../../../src/search/exa-adapter.js';
import { buildExaBody } from '../../../src/search/exa-request.js';
import type { CrawlBasis, SearchRequest } from '../../../src/shared/search.js';

/** [SYNTHETIC] Exa-shaped responses: the only per-result crawl marker is the optional `statuses[]`. */
const meta = { provider: 'exa', observedAt: 1000, latencyMs: 5 };
const live: SearchRequest = {
  query: 'AcmeCRM pricing',
  numResults: 3,
  freshness: 'live',
  liveTimeoutMs: 1,
  contentMode: 'text',
  contentChars: 1500,
};
const cachedReq: SearchRequest = { ...live, freshness: 'cached' };

const URL1 = 'https://acmecrm.example/pricing';
const heading = '## Plans\n\n';
/** A structured page of exactly `n` characters (heading then prose). */
const page = (n: number): string => heading + 'x'.repeat(Math.max(0, n - heading.length));
/** An unstructured body of exactly `n` characters. */
const prose = (n: number): string => 'word '.repeat(Math.ceil(n / 5)).slice(0, n - 1) + '.';

function body(text: string, statuses?: unknown[]): string {
  return JSON.stringify({
    requestId: 'r',
    results: [{ id: URL1, url: URL1, title: 'T', text }],
    ...(statuses ? { statuses } : {}),
  });
}
function basisOf(req: SearchRequest, text: string, statuses?: unknown[]): CrawlBasis | undefined {
  return normaliseExaResponse(body(text, statuses), req, meta).hits[0]?.crawlBasis;
}

describe('content sufficiency rule', () => {
  it('rejects the three probed lengths (87, 131, 186 characters) for a 1500 budget', () => {
    for (const n of [87, 131, 186]) {
      expect(isSufficientContent(page(n), 1500, 'text'), String(n)).toBe(false);
    }
  });

  it('boundary: the required length for a 1500 budget is 750 characters, inclusive', () => {
    const required = Math.ceil(BUDGET_FRACTION * 1500);
    expect(required).toBe(750);
    expect(isSufficientContent(page(required - 1), 1500, 'text')).toBe(false);
    expect(isSufficientContent(page(required), 1500, 'text')).toBe(true);
  });

  it('boundary: the absolute floor of 400 characters applies to a small budget', () => {
    expect(isSufficientContent(page(MIN_CONTENT_CHARS - 1), 200, 'text')).toBe(false);
    expect(isSufficientContent(page(MIN_CONTENT_CHARS), 200, 'text')).toBe(true);
  });

  it('boundary: the ratio is capped, so a 6000 budget requires 1500 characters, not 3000', () => {
    expect(isSufficientContent(page(MAX_REQUIRED_CHARS - 1), 6000, 'text')).toBe(false);
    expect(isSufficientContent(page(MAX_REQUIRED_CHARS), 6000, 'text')).toBe(true);
  });

  it('unstructured prose is sufficient only from 1200 characters (and above the length floor)', () => {
    expect(isSufficientContent(prose(LONG_BODY_CHARS - 1), 1500, 'text')).toBe(false);
    expect(isSufficientContent(prose(LONG_BODY_CHARS), 1500, 'text')).toBe(true);
  });

  it('a table counts as structure as well as a heading', () => {
    const table = '| Plan | Price |\n|---|---|\n| Pro | $9 |\n' + prose(800);
    expect(isSufficientContent(table, 1500, 'text')).toBe(true);
  });

  it('measures the trimmed text, so padding cannot satisfy it', () => {
    expect(isSufficientContent(page(100) + ' '.repeat(2000), 1500, 'text')).toBe(false);
  });

  it('is never satisfied by highlights, whose length says nothing about the crawl', () => {
    expect(isSufficientContent(page(5000), 1500, 'highlights')).toBe(false);
  });
});

describe('Exa adapter: crawl basis for each of the four states', () => {
  const marker = (source: string, status = 'success') => [{ id: URL1, status, source }];

  it('full-length content with a live request and no marker is requested_live, not confirmed', () => {
    const r = normaliseExaResponse(body(page(1500)), live, meta);
    expect(r.hits[0]).toMatchObject({ crawlBasis: 'requested_live', freshFetch: false });
  });

  it('the probed short results (186, 131, 87 characters, HTTP 200, no marker) are unknown', () => {
    for (const n of [186, 131, 87]) {
      expect(basisOf(live, page(n)), String(n)).toBe('unknown');
    }
  });

  it('a cache-only request is cached, however long the content', () => {
    expect(basisOf(cachedReq, page(1500))).toBe('cached');
    expect(basisOf(cachedReq, page(87))).toBe('cached');
  });

  it('a per-result marker reporting a successful live crawl is confirmed_live and sets freshFetch', () => {
    const r = normaliseExaResponse(body(page(300), marker('live')), live, meta);
    expect(r.hits[0]).toMatchObject({ crawlBasis: 'confirmed_live', freshFetch: true });
  });

  it('the marker alone is not enough without a live request', () => {
    expect(basisOf(cachedReq, page(1500), marker('live'))).toBe('cached');
  });

  it('a per-result cached marker is cached even when a live crawl was requested', () => {
    expect(basisOf(live, page(1500), marker('cached'))).toBe('cached');
  });

  it('a failed crawl marker is unknown, whatever the content', () => {
    expect(basisOf(live, page(1500), marker('live', 'error'))).toBe('unknown');
  });

  it('highlights-mode results of a live request are unknown', () => {
    const json = JSON.stringify({
      results: [{ id: URL1, url: URL1, highlights: [page(1500)] }],
    });
    const r = normaliseExaResponse(json, { ...live, contentMode: 'highlights' }, meta);
    expect(r.hits[0]).toMatchObject({ crawlBasis: 'unknown', freshFetch: false });
  });

  it('maxAgeHours: 0 is sent for a live request, and that request alone never yields confirmed_live', () => {
    expect((buildExaBody(live).contents as Record<string, unknown>).maxAgeHours).toBe(0);
    for (const text of [page(87), page(1500), prose(6000)]) {
      expect(basisOf(live, text)).not.toBe('confirmed_live');
    }
  });

  it('a real-shaped response (HTTP 200, no statuses) never produces confirmed_live or freshFetch', () => {
    for (const req of [live, cachedReq]) {
      const hit = normaliseExaResponse(body(page(1500)), req, meta).hits[0];
      expect(hit?.freshFetch).toBe(false);
      expect(hit?.crawlBasis).not.toBe('confirmed_live');
    }
  });

  it('freshFetch is exactly (crawlBasis === confirmed_live) across every case above', () => {
    const cases: Array<[SearchRequest, string, unknown[] | undefined]> = [
      [live, page(1500), undefined],
      [live, page(87), undefined],
      [cachedReq, page(1500), undefined],
      [live, page(300), marker('live')],
      [live, page(1500), marker('cached')],
      [live, page(1500), marker('live', 'error')],
    ];
    for (const [req, text, st] of cases) {
      const hit = normaliseExaResponse(body(text, st), req, meta).hits[0];
      expect(hit?.freshFetch).toBe(hit?.crawlBasis === 'confirmed_live');
    }
  });
});

describe('classifyCrawlBasis', () => {
  it('a marker with no source on a live request falls through to the content rule', () => {
    const base = {
      freshness: 'live' as const,
      contentMode: 'text' as const,
      contentChars: 1500,
      marker: { crawlStatus: 'unknown' as const, source: undefined },
    };
    expect(classifyCrawlBasis({ ...base, text: page(1500) })).toBe('requested_live');
    expect(classifyCrawlBasis({ ...base, text: page(100) })).toBe('unknown');
  });
});
