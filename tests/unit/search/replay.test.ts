import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReplaySearchAdapter } from '../../../src/search/replay.js';
import { requestKey } from '../../../src/search/request-key.js';
import { ReplayMissError, SearchError, type SearchRequest } from '../../../src/shared/search.js';

const json = fs.readFileSync(
  new URL('../../fixtures/search/replay-synthetic.json', import.meta.url),
  'utf8',
);
const recorded: SearchRequest = {
  query: 'AcmeCRM pricing',
  numResults: 5,
  includeDomains: ['acmecrm.example'],
  freshness: 'live',
  liveTimeoutMs: 5000,
  contentMode: 'text',
  contentChars: 6000,
};
const signal = new AbortController().signal;

describe('requestKey', () => {
  it('ignores key order and undefined fields, and distinguishes real differences', () => {
    const a = requestKey(recorded);
    const reordered = {
      contentChars: 6000,
      contentMode: 'text',
      query: 'AcmeCRM pricing',
      numResults: 5,
      includeDomains: ['acmecrm.example'],
      freshness: 'live',
      liveTimeoutMs: 5000,
      category: undefined,
    } as SearchRequest;
    expect(requestKey(reordered)).toBe(a);
    expect(requestKey({ ...recorded, numResults: 6 })).not.toBe(a);
    expect(requestKey({ ...recorded, includeDomains: [] })).not.toBe(a);
  });
});

describe('ReplaySearchAdapter', () => {
  it('replays a recorded response', async () => {
    const r = await ReplaySearchAdapter.fromJson(json).search(recorded, signal);
    expect(r.hits).toHaveLength(3);
    expect(r.provider).toBe('exa');
  });

  it('a miss throws ReplayMissError and never falls back', async () => {
    const adapter = ReplaySearchAdapter.fromJson(json);
    await expect(
      adapter.search({ ...recorded, query: 'something else' }, signal),
    ).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('returns copies, so callers cannot corrupt the recording', async () => {
    const adapter = ReplaySearchAdapter.fromJson(json);
    const a = await adapter.search(recorded, signal);
    a.hits.length = 0;
    expect((await adapter.search(recorded, signal)).hits).toHaveLength(3);
  });

  it('honours an already-aborted signal', async () => {
    await expect(
      ReplaySearchAdapter.fromJson(json).search(recorded, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(SearchError);
  });

  it('rejects an invalid recording file', () => {
    expect(() => ReplaySearchAdapter.fromJson('{"version":2}')).toThrow();
    expect(() => ReplaySearchAdapter.fromJson('nope')).toThrow();
  });

  it('is constructed without credentials or a fetch function', () => {
    expect(ReplaySearchAdapter.length).toBe(2);
    expect(Object.keys(new ReplaySearchAdapter('x', []))).not.toContain('apiKey');
  });
});
