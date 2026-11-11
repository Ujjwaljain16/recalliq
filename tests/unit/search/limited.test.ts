import { describe, expect, it } from 'vitest';
import { loadAppEnv } from '../../../src/app/env.js';
import { liveSearchPort } from '../../../src/app/live.js';
import { realSleep } from '../../../src/llm/abort.js';
import { ClientLimiter } from '../../../src/llm/limiter.js';
import { LimitedSearchPort } from '../../../src/search/limited.js';
import {
  SearchError,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../../../src/shared/search.js';
import { FixedClock } from '../../../src/temporal/clock.js';

const req: SearchRequest = {
  query: 'Acme pricing',
  numResults: 5,
  freshness: 'live',
  contentMode: 'text',
  contentChars: 6000,
};

/** A search port whose calls stay open until released. */
function holdingPort(): { port: SearchPort; inFlight: () => number; releaseOne: () => void } {
  const open: Array<() => void> = [];
  const response = { provider: 'fake' } as unknown as SearchResponse;
  return {
    port: {
      provider: 'fake',
      search: () =>
        new Promise<SearchResponse>((resolve) => {
          open.push(() => resolve(response));
        }),
    },
    inFlight: () => open.length,
    releaseOne: () => open.shift()?.(),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the search limiter', () => {
  it('keeps at most maxConcurrent searches in flight, and starts the next when one ends', async () => {
    const h = holdingPort();
    const port = new LimitedSearchPort(
      h.port,
      new ClientLimiter(
        { maxConcurrent: 2, minSpacingMs: 0 },
        { clock: new FixedClock(0), sleep: realSleep },
      ),
    );
    const signal = new AbortController().signal;
    const runs = [1, 2, 3].map(() => port.search(req, signal));
    await settle();
    expect(h.inFlight()).toBe(2);
    h.releaseOne();
    await settle();
    expect(h.inFlight()).toBe(2);
    h.releaseOne();
    h.releaseOne();
    await Promise.all(runs);
    expect(port.provider).toBe('fake');
  });

  it('reports an abort while waiting for a slot as a search cancellation, without taking a slot', async () => {
    const h = holdingPort();
    const port = new LimitedSearchPort(
      h.port,
      new ClientLimiter(
        { maxConcurrent: 1, minSpacingMs: 0 },
        { clock: new FixedClock(0), sleep: realSleep },
      ),
    );
    const first = port.search(req, new AbortController().signal);
    const abort = new AbortController();
    const waiting = port.search(req, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(SearchError);
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    h.releaseOne();
    await first;
    await settle();
    expect(h.inFlight()).toBe(0);
  });

  it('the live set shares EXA_MAX_CONCURRENT slots across all of its searches', async () => {
    const env = loadAppEnv({ EXA_API_KEY: 'test-key', EXA_MAX_CONCURRENT: '2' });
    let inFlight = 0;
    let started = 0;
    const releases: Array<() => void> = [];
    const fakeFetch: typeof fetch = () => {
      inFlight++;
      started++;
      return new Promise<Response>((resolve) =>
        releases.push(() => {
          inFlight--;
          resolve(new Response('{"results":[]}', { status: 200 }));
        }),
      );
    };
    const port = liveSearchPort(env, fakeFetch, new FixedClock(0));
    const signal = new AbortController().signal;
    const runs = [1, 2, 3, 4].map(() => port.search(req, signal).catch(() => undefined));
    await settle();
    expect(inFlight).toBe(2);
    while (started < 4 || releases.length > 0) {
      releases.shift()?.();
      await settle();
      expect(inFlight).toBeLessThanOrEqual(2);
    }
    await Promise.all(runs);
    expect(started).toBe(4);
  });
});
