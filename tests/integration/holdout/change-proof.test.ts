import { afterEach, describe, expect, it } from 'vitest';
import {
  crawlBases,
  DAY,
  expectConsistent,
  expectVerdict,
  expectWording,
  HOUR,
  o,
  oEff,
  Rig,
  TUE,
  URL_OTHER_PATH,
  type RigOptions,
} from './rig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

async function start(o: RigOptions): Promise<Rig> {
  rig = await Rig.start(o);
  return rig;
}

describe('HOLDOUT 3: the world changed, with proof', () => {
  it('HO-03a changed with the exact window between the old-value and the new-value observation', async () => {
    const r = await start({ steps: [[o(90)], [o(90)], [o(100)]] });
    await r.research();
    const mid = await r.audit(9 * DAY);
    expect(mid.verdict).toBe('unchanged_confirmed');
    const last = await r.audit(10 * DAY + 2 * HOUR);
    expectVerdict('HO-03a', last.verdict);
    expect(last.finding?.verdictReason).toBe('same_source_bracketing');
    expect(last.finding?.changeWindow).toEqual({
      after: TUE + 9 * DAY,
      notAfter: TUE + 19 * DAY + 2 * HOUR,
    });
    expect(last.finding?.direction).toBe('up');
    expect(last.text).toContain('changed between');
    expectWording(last.verdict, last.text, 'up');
    expectConsistent(r, last);
  });

  it('HO-03b changed from an explicit effective date after the answer, official page, known locale', async () => {
    const r = await start({ steps: [[o(90)], [oEff(100, '5 November 2026')]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-03b', a.verdict);
    expect(a.finding?.verdictReason).toBe('stated_effective_date');
    expect(a.finding?.effectiveFrom).toBe(Date.UTC(2026, 10, 5));
    expect(a.text).toMatch(/changed from .*5.*Nov/);
    expectWording(a.verdict, a.text, 'up');
    expectConsistent(r, a);
  });

  it('HO-03c the explicit effective date does not count on an unregistered domain', async () => {
    const r = await start({
      steps: [[o(90)], [oEff(100, '5 November 2026')]],
      registry: 'none',
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-03c', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-03d re-observation bracketing on tier C pages alone is not proof of a change', async () => {
    const r = await start({ steps: [[o(90)], [o(90)], [o(100)]], registry: 'none' });
    await r.research();
    const mid = await r.audit(9 * DAY);
    expect(mid.verdict).toBe('no_evidence_of_change');
    const last = await r.audit(10 * DAY + 2 * HOUR);
    expectVerdict('HO-03d', last.verdict);
    expect(last.finding?.verdictReason).toBe('low_authority_source');
    expectWording(last.verdict, last.text);
    expectConsistent(r, last);
  });
});

describe('HOLDOUT 4: the price changed but its timing is unknown', () => {
  it('HO-04a one live observation of a lower price is differs_timing_unknown, with no cut or drop wording', async () => {
    const r = await start({ steps: [[o(90)], [o(70)]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-04a', a.verdict);
    expect(a.finding?.current?.value?.amount).toBe(70);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-04b a cached result with a provider last-updated time is differs_timing_unknown', async () => {
    const r = await start({
      steps: [[o(90)], [o(100, { marker: 'cached', lastUpdatedAt: TUE + 7 * DAY + HOUR })]],
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-04b', a.verdict);
    expect(crawlBases(r)[0]).toBe('cached');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-04c an unmarked, undated result with the new value never becomes the current price', async () => {
    const r = await start({ steps: [[o(90)], [o(100, { marker: 'none' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-04c', a.verdict);
    expect(crawlBases(r)[0]).toBe('unknown');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-04d a cached, undated result with the new value never becomes the current price', async () => {
    const r = await start({ steps: [[o(90)], [o(100, { marker: 'cached' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-04d', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});

describe('HOLDOUT 5: the original source disappeared', () => {
  it('HO-05a a provider outage on every attempt is unable_to_verify', async () => {
    const r = await start({
      steps: [[o(90)], 'unavailable', 'unavailable'],
      fallback: 'unavailable',
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-05a', a.verdict);
    expect(a.text).toContain("couldn't be checked this time");
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-05b a "not found" page with no price is never unchanged_confirmed or changed', async () => {
    const r = await start({
      steps: [[o(90)], [{ body: '[SYNTHETIC] Page not found. The page you asked for is gone.' }]],
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-05b', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-05c an empty result set is never unchanged_confirmed or changed', async () => {
    const r = await start({ steps: [[o(90)], []] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-05c', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-05d another url showing a different price is not a re-observation of the old source', async () => {
    const r = await start({ steps: [[o(90)], [o(100, { url: URL_OTHER_PATH })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-05d', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});
