import { describe, expect, it } from 'vitest';
import { parseReplayFixture, toSearchHit } from '../../../src/app/live/fixture.js';

const base = { url: 'https://acme.example/pricing', text: '[SYNTHETIC] page' };
const withHit = (hit: Record<string, unknown>) =>
  parseReplayFixture({
    version: 1,
    class: 'synthetic',
    label: '[SYNTHETIC] provenance',
    search: [{ query: 'q', steps: [{ hits: [hit] }] }],
    llm: { analysis: [], extraction: [], synthesis: [], judge: [] },
  });

function hitOf(hit: Record<string, unknown>) {
  const f = withHit(hit);
  const step = f.search[0]?.steps[0];
  if (!step || !('hits' in step)) throw new Error('no hits');
  return toSearchHit(step.hits[0]!);
}

describe('replay fixtures confirm a live crawl only through an explicit provider marker', () => {
  it('a hit with no marker is freshness-unknown, never a confirmed live fetch (there is no default)', () => {
    expect(hitOf(base)).toMatchObject({
      freshFetch: false,
      crawlStatus: 'unknown',
      crawlBasis: 'unknown',
    });
  });

  it('only a marker that says a live crawl succeeded confirms it', () => {
    expect(hitOf({ ...base, marker: { source: 'live', status: 'ok' } })).toMatchObject({
      freshFetch: true,
      crawlStatus: 'ok',
      crawlBasis: 'confirmed_live',
    });
  });

  it.each([
    [{ source: 'cached', status: 'ok' }, 'cached', 'ok'],
    [{ source: 'live', status: 'failed' }, 'unknown', 'failed'],
    [{ source: 'cached', status: 'failed' }, 'cached', 'failed'],
  ] as const)('marker %j is not a confirmed live crawl', (marker, basis, status) => {
    expect(hitOf({ ...base, marker })).toMatchObject({
      freshFetch: false,
      crawlStatus: status,
      crawlBasis: basis,
    });
  });

  it('the old freshFetch and crawlStatus flags are refused, not silently ignored', () => {
    expect(() => withHit({ ...base, freshFetch: true })).toThrow();
    expect(() => withHit({ ...base, crawlStatus: 'ok' })).toThrow();
  });

  it('a malformed marker is refused', () => {
    expect(() => withHit({ ...base, marker: { source: 'live' } })).toThrow();
    expect(() => withHit({ ...base, marker: { source: 'fresh', status: 'ok' } })).toThrow();
  });
});
