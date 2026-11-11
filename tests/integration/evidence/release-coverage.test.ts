import { describe, expect, it } from 'vitest';
import { LlmError, type SearchOutcome } from '../../../src/shared/index.js';
import {
  DAY,
  NOW,
  ScriptedExecutor,
  ScriptedLlm,
  makeService,
  makeWorld,
  outcome,
  pricingPage,
  request,
  spec,
  storeSnapshot,
  type World,
} from './support.js';

/**
 * The research service decides how much a release search covered. Only searches made for releases count as
 * release sources, so eleven pricing pages never support "no releases found". [SYNTHETIC]
 */

const releaseOutcome = (
  w: World,
  snapshotIds: SearchOutcome['snapshotIds'],
  over: Partial<SearchOutcome> = {},
): SearchOutcome => ({
  spec: { ...spec(w.acme.id), intent: 'releases' },
  status: 'ok',
  snapshotIds,
  ...over,
});

const news = (w: World, lastUpdated: number | null) =>
  storeSnapshot(w.t.db, w.userId, {
    text: 'Acme CRM news\nNothing new to announce this month.',
    observedAt: NOW - 1000,
    url: 'https://acme.example/blog',
    urlNorm: 'acme.example/blog',
    fresh: false,
    lastUpdated,
  });

const emptyLlm = () => new ScriptedLlm(() => ({ statements: [] }));

async function run(w: World, outcomes: SearchOutcome[], llm = emptyLlm()) {
  const service = makeService(w, new ScriptedExecutor({ 1: outcomes }), llm);
  const set = await service.run(request(w, { intents: ['releases'] }).req);
  const f = set.findings[0];
  if (!f) throw new Error('no finding');
  return f;
}

describe('release coverage in the research service', () => {
  it('T-RS-50: a release source dated inside the interval and nothing found is none_found, with the coverage numbers', async () => {
    const w = makeWorld();
    const id = news(w, NOW - 5 * DAY);
    const f = await run(w, [releaseOutcome(w, [id])]);
    expect(f).toMatchObject({ verdict: 'none_found', currentStatus: 'unknown' });
    expect(f.coverage).toMatchObject({
      searchesOk: 1,
      sourcesChecked: 1,
      newestDatedSource: NOW - 5 * DAY,
      releaseSources: 1,
      newestDatedReleaseSource: NOW - 5 * DAY,
    });
  });

  it('T-RS-51: only pricing pages were obtained: not none_found', async () => {
    const w = makeWorld();
    const pricing = storeSnapshot(w.t.db, w.userId, {
      text: pricingPage(90),
      observedAt: NOW - 1000,
      lastUpdated: NOW - DAY,
    });
    const f = await run(w, [outcome(w.acme.id, [pricing])]);
    expect(f).toMatchObject({
      verdict: 'unable_to_verify',
      currentStatus: 'unable_to_verify',
      verdictReason: 'insufficient_coverage',
    });
    expect(f.coverage).toMatchObject({ sourcesChecked: 1, releaseSources: 0 });
  });

  it('T-RS-52: release sources with no date, or dated before the interval, are not none_found', async () => {
    for (const lastUpdated of [null, NOW - 90 * DAY]) {
      const w = makeWorld();
      const f = await run(w, [releaseOutcome(w, [news(w, lastUpdated)])]);
      expect(f.verdict, String(lastUpdated)).toBe('unable_to_verify');
      expect(f.verdictReason).toBe('insufficient_coverage');
    }
  });

  it('T-RS-53: a failed search for the entity makes it unable_to_verify', async () => {
    const w = makeWorld();
    const id = news(w, NOW - 5 * DAY);
    const failed = releaseOutcome(w, [], { status: 'failed', errorCode: 'timeout' });
    const f = await run(w, [releaseOutcome(w, [id]), failed]);
    expect(f).toMatchObject({ verdict: 'unable_to_verify', verdictReason: 'search_timeout' });
    expect(f.coverage.searchesFailed).toBe(1);
  });

  it('T-RS-54: a failed extraction or a deadline makes it unable_to_verify', async () => {
    for (const [error, reason] of [
      [new LlmError('unavailable', 'down'), 'extraction_failed'],
      [new LlmError('cancelled', 'deadline'), 'deadline'],
    ] as const) {
      const w = makeWorld();
      const f = await run(
        w,
        [releaseOutcome(w, [news(w, NOW - 5 * DAY)])],
        new ScriptedLlm(() => error),
      );
      expect(f).toMatchObject({ verdict: 'unable_to_verify', verdictReason: reason });
    }
  });

  it('T-RS-55: a search that returned nothing is a successful search but no source: not none_found', async () => {
    const w = makeWorld();
    const f = await run(w, [releaseOutcome(w, [], { status: 'empty' })]);
    expect(f.verdict).toBe('unable_to_verify');
    expect(f.coverage).toMatchObject({ searchesOk: 1, releaseSources: 0 });
  });
});
