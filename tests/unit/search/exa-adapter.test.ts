import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ExaSearchAdapter,
  normaliseExaResponse,
  truncateText,
} from '../../../src/search/exa-adapter.js';
import type { RecordedExchange } from '../../../src/search/recording.js';
import { SearchError, type SearchRequest } from '../../../src/shared/search.js';
import { FixedClock } from '../../../src/temporal/clock.js';

const fixture = (name: string): string =>
  fs.readFileSync(new URL(`../../fixtures/search/${name}`, import.meta.url), 'utf8');

const req: SearchRequest = {
  query: 'AcmeCRM pricing',
  numResults: 5,
  freshness: 'live',
  contentMode: 'text',
  contentChars: 6000,
};
const meta = { provider: 'exa', observedAt: 1000, latencyMs: 5 };

function adapter(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  record?: (e: RecordedExchange) => void,
) {
  return new ExaSearchAdapter({
    apiKey: 'test-key-123',
    fetch: fetchImpl,
    clock: new FixedClock(1000),
    ...(record ? { record } : {}),
  });
}
const ok =
  (body: string, init: ResponseInit = {}) =>
  () =>
    Promise.resolve(new Response(body, { status: 200, ...init }));
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(
      new Response('{"error":"ignored body with test-key-123"}', { status: code, headers }),
    );

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SearchError) return e.code;
    throw e;
  }
  return 'resolved';
}

describe('normaliseExaResponse (synthetic fixtures)', () => {
  it('normalises hits, preserving text exactly, with provider metadata', () => {
    const r = normaliseExaResponse(fixture('exa-pricing-text.json'), req, meta);
    expect(r.hits).toHaveLength(3);
    expect(r.droppedMalformed).toBe(0);
    expect(r.costUsd).toBe(0.007);
    const first = r.hits[0];
    expect(first?.title).toBe('[SYNTHETIC] AcmeCRM Pricing');
    expect(first?.publishedAt).toBe(Date.UTC(2026, 9, 1));
    expect(first?.lastUpdatedAt).toBeNull();
    // Structure intact: heading, table header, adjacent cells, currency symbol, label.
    expect(first?.text).toContain('## Plans (USD, billed annually)');
    expect(first?.text).toContain('| Plan | Price per user / month | Contacts |');
    expect(first?.text).toContain('| Pro | $90 | 10,000 |');
    expect(first?.text).toContain('(USD)');
  });

  it('sets freshFetch only for a live request with a successful crawl whose source is live', () => {
    const live = normaliseExaResponse(fixture('exa-pricing-text.json'), req, meta).hits;
    expect(live.map((h) => [h.crawlStatus, h.freshFetch])).toEqual([
      ['ok', true],
      ['ok', false], // success but source "cached"
      ['failed', false],
    ]);
    const cached = normaliseExaResponse(
      fixture('exa-pricing-text.json'),
      { ...req, freshness: 'cached' },
      meta,
    ).hits;
    expect(cached.every((h) => !h.freshFetch)).toBe(true);
  });

  it('without statuses: crawlStatus unknown, never a fresh fetch', () => {
    const body = JSON.parse(fixture('exa-pricing-text.json')) as Record<string, unknown>;
    delete body.statuses;
    const hits = normaliseExaResponse(JSON.stringify(body), req, meta).hits;
    expect(hits.every((h) => h.crawlStatus === 'unknown' && !h.freshFetch)).toBe(true);
  });

  it('drops and counts malformed items, keeps the good ones', () => {
    const r = normaliseExaResponse(fixture('exa-malformed-items.json'), req, meta);
    expect(r.hits.map((h) => h.url)).toEqual([
      'https://acmecrm.example/pricing',
      'https://acmecrm.example/bad-date',
    ]);
    expect(r.droppedMalformed).toBe(7);
    expect(r.hits[1]?.publishedAt).toBeNull();
  });

  it('returns an empty response for no results', () => {
    const r = normaliseExaResponse(fixture('exa-empty.json'), req, meta);
    expect(r.hits).toEqual([]);
    expect(r.droppedMalformed).toBe(0);
  });

  it('uses highlights in highlights mode and truncates to contentChars without splitting surrogates', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://a.example/x', highlights: ['one', 'two'] }],
    });
    expect(
      normaliseExaResponse(body, { ...req, contentMode: 'highlights' }, meta).hits[0]?.text,
    ).toBe('one\n\ntwo');
    expect(truncateText('ab\u{1F600}', 3)).toBe('ab');
    expect(truncateText('abc', 10)).toBe('abc');
    const huge = JSON.stringify({
      results: [{ url: 'https://a.example/x', text: 'x'.repeat(2_000_000) }],
    });
    expect(
      normaliseExaResponse(huge, { ...req, contentChars: 6000 }, meta).hits[0]?.text,
    ).toHaveLength(6000);
  });

  it.each([['not json'], ['[]'], ['{"results": "nope"}'], ['{}'], ['null']])(
    'rejects a malformed envelope %s as unavailable',
    (body) => {
      expect(() => normaliseExaResponse(body, req, meta)).toThrow(
        expect.objectContaining({ code: 'unavailable' }),
      );
    },
  );
});

describe('ExaSearchAdapter', () => {
  it('sends a POST with the key only in the x-api-key header', async () => {
    const fetchMock = vi.fn(ok(fixture('exa-empty.json')));
    const res = await adapter(fetchMock).search(req, new AbortController().signal);
    expect(res.provider).toBe('exa');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key-123');
    expect(init.body as string).not.toContain('test-key-123');
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: 'AcmeCRM pricing',
      contents: { maxAgeHours: 0 },
    });
  });

  it('refuses to construct without a key', () => {
    expect(
      () => new ExaSearchAdapter({ apiKey: '', fetch: ok(''), clock: new FixedClock(0) }),
    ).toThrow(SearchError);
  });

  it.each([
    [429, 'rate_limited'],
    [402, 'quota_exhausted'],
    [503, 'unavailable'],
    [500, 'unavailable'],
    [504, 'timeout'],
    [400, 'bad_request'],
    [401, 'bad_request'],
  ])('maps HTTP %i to %s without echoing the body or key', async (code, expected) => {
    const p = adapter(status(code)).search(req, new AbortController().signal);
    await expect(p).rejects.toThrow(expect.objectContaining({ code: expected }));
    await p.catch((e: Error) => expect(e.message).not.toContain('test-key-123'));
  });

  it('exposes Retry-After (seconds) on 429, capped at 60s', async () => {
    const p = adapter(status(429, { 'retry-after': '7' })).search(
      req,
      new AbortController().signal,
    );
    await expect(p).rejects.toThrow(expect.objectContaining({ retryAfterMs: 7000 }));
    const q = adapter(status(429, { 'retry-after': '99999' })).search(
      req,
      new AbortController().signal,
    );
    await expect(q).rejects.toThrow(expect.objectContaining({ retryAfterMs: 60000 }));
  });

  it('maps a network failure to unavailable', async () => {
    const f = () => Promise.reject(new TypeError('fetch failed: ECONNRESET'));
    expect(await codeOf(adapter(f).search(req, new AbortController().signal))).toBe('unavailable');
  });

  it('maps a timeout signal to timeout and a manual abort to cancelled', async () => {
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () =>
          rej(new Error('aborted', { cause: init.signal?.reason })),
        );
      });
    expect(await codeOf(adapter(hang).search(req, AbortSignal.timeout(10)))).toBe('timeout');
    const c = new AbortController();
    const p = adapter(hang).search(req, c.signal);
    c.abort(new Error('deadline'));
    expect(await codeOf(p)).toBe('cancelled');
    expect(await codeOf(adapter(hang).search(req, AbortSignal.abort()))).toBe('cancelled');
  });

  it('rejects a bad request before any network call', async () => {
    const fetchMock = vi.fn(ok('{}'));
    expect(
      await codeOf(
        adapter(fetchMock).search({ ...req, numResults: 99 }, new AbortController().signal),
      ),
    ).toBe('bad_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the raw provider body to the recorder, unmodified', async () => {
    const seen: RecordedExchange[] = [];
    await adapter(ok(fixture('exa-pricing-text.json')), (e) => seen.push(e)).search(
      req,
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.providerRaw).toEqual(JSON.parse(fixture('exa-pricing-text.json')));
    expect(JSON.stringify(seen[0])).not.toContain('test-key-123');
  });
});
