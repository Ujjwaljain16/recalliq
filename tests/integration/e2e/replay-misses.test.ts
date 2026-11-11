import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../src/temporal/clock.js';
import {
  FixtureLlm,
  FixtureMissError,
  FixtureSearchPort,
  MissLog,
} from '../../../src/app/live/replay-providers.js';
import { parseReplayFixture } from '../../../src/app/live/fixture.js';
import { ReplayMissError } from '../../../src/shared/search.js';
import { ask, scalar, startE2e, TUE, type E2eApp } from './harness.js';
import { extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

const Q = 'What does Acme CRM cost?';

let t: E2eApp | undefined;
const outbound: string[] = [];
const realFetch = globalThis.fetch;

/**
 * Any request that leaves the machine is recorded and refused. Requests to the test server itself (127.0.0.1)
 * are the test's own client and pass through.
 */
beforeEach(() => {
  outbound.length = 0;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    outbound.push(url);
    return Promise.reject(new Error(`network call attempted: ${url}`));
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t?.stop();
  t = undefined;
});

const complete = {
  analysis: [researchOf(Q, ['Acme CRM'])],
  extraction: [extractionOf('Acme CRM', 90)],
  search: [priceSearch('Acme CRM', 90)],
  synthesis: [say(Q, 'Acme CRM Pro is [[F1]].')],
};

async function misses(parts: Parameters<typeof fixture>[0]): Promise<string> {
  t = await startE2e({ fixture: fixture(parts) });
  const user = t.client();
  const res = await user.request(
    'POST',
    `/api/conversations/${await user.newConversation()}/turns`,
    {
      text: Q,
      idempotencyKey: 'miss',
    },
  );
  const raw = await res.text();
  // loud: an error event, no answer, the turn is not complete, nothing was claimed
  expect(raw).toContain('event: error');
  expect(raw).not.toContain('answer.delta');
  expect(raw).not.toContain('answer.completed');
  expect(scalar(t.app, "SELECT count(*) FROM turns WHERE status = 'complete'")).toBe(0);
  expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(0);
  return raw;
}

describe('T-E2E a replay fixture miss fails loudly and never reaches the network', () => {
  it('a message the analysis fixture does not cover stops the turn', async () => {
    await misses({ ...complete, analysis: [] });
    expect(outbound).toEqual([]);
  });

  it('a search the fixture does not cover stops the turn', async () => {
    await misses({ ...complete, search: [] });
    expect(outbound).toEqual([]);
  });

  it('a search recorded for fewer calls than made stops the turn', async () => {
    // the second attempt of a failing search has nothing recorded
    await misses({ ...complete, search: [priceSearch('Acme CRM', 'unavailable')] });
    expect(outbound).toEqual([]);
  });

  it('an answer the synthesis fixture does not cover stops the turn', async () => {
    await misses({ ...complete, synthesis: [] });
    expect(outbound).toEqual([]);
  });

  it('a complete fixture works and still makes no outbound request', async () => {
    t = await startE2e({ fixture: fixture(complete) });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.status).toBe('complete');
    expect(outbound).toEqual([]);
  });
});

describe('replay providers in isolation', () => {
  it('hold no fetch: a miss is recorded and thrown, with the global fetch never called', async () => {
    const calls = vi.fn();
    vi.stubGlobal('fetch', calls);
    const log = new MissLog();
    const parsed = parseReplayFixture(fixture({}));
    const search = new FixtureSearchPort({
      entries: parsed.search,
      clock: new FixedClock(TUE),
      log,
    });
    const signal = new AbortController().signal;
    await expect(
      search.search(
        {
          query: 'unknown',
          numResults: 1,
          freshness: 'cached',
          contentMode: 'text',
          contentChars: 10,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(ReplayMissError);

    const llm = new FixtureLlm(parsed.llm, log);
    await expect(
      (async () => {
        for await (const e of llm.stream({
          role: 'synthesis',
          system: 's',
          messages: [{ role: 'user', content: 'x' }],
          maxTokens: 10,
          signal,
        })) {
          void e;
        }
      })(),
    ).rejects.toBeInstanceOf(FixtureMissError);
    expect(log.count).toBe(2);
    expect(calls).not.toHaveBeenCalled();
  });
});
