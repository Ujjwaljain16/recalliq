import { describe, expect, it } from 'vitest';
import { buildExaBody } from '../../../src/search/exa-request.js';
import { SearchError, type SearchRequest } from '../../../src/shared/search.js';

const base: SearchRequest = {
  query: ' AcmeCRM pricing ',
  numResults: 5,
  freshness: 'cached',
  contentMode: 'text',
  contentChars: 6000,
};

describe('buildExaBody', () => {
  it('maps text mode, cached freshness and trims the query', () => {
    expect(buildExaBody(base)).toEqual({
      query: 'AcmeCRM pricing',
      numResults: 5,
      contents: { text: { maxCharacters: 6000 } },
    });
  });

  it('maps live freshness to maxAgeHours 0 with a bounded live-crawl timeout', () => {
    const b = buildExaBody({ ...base, freshness: 'live', liveTimeoutMs: 3000 });
    expect(b.contents).toEqual({
      text: { maxCharacters: 6000 },
      maxAgeHours: 0,
      livecrawlTimeout: 3000,
    });
  });

  it('maps highlights, domains, dates and category', () => {
    const b = buildExaBody({
      ...base,
      contentMode: 'highlights',
      contentChars: 500,
      includeDomains: ['acme.example'],
      startPublishedDate: Date.UTC(2026, 10, 3),
      category: 'news',
    });
    expect(b).toMatchObject({
      includeDomains: ['acme.example'],
      startPublishedDate: '2026-11-03T00:00:00.000Z',
      category: 'news',
      contents: { highlights: { maxCharacters: 500 } },
    });
  });

  it('never contains a credential field', () => {
    expect(JSON.stringify(buildExaBody(base)).toLowerCase()).not.toContain('key');
  });

  it.each([
    { query: '   ' },
    { numResults: 0 },
    { numResults: 11 },
    { contentChars: 6001 },
    { contentChars: 0 },
    { liveTimeoutMs: 5001 },
    { startPublishedDate: Number.NaN },
    { query: 'x'.repeat(2001) },
  ])('rejects out-of-contract request %j as bad_request', (patch) => {
    const run = () => buildExaBody({ ...base, ...patch });
    expect(run).toThrow(SearchError);
    expect(run).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });
});
