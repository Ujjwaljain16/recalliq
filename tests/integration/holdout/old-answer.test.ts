import { afterEach, describe, expect, it } from 'vitest';
import {
  DAY,
  expectConsistent,
  expectVerdict,
  expectWording,
  o,
  oEff,
  Rig,
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

describe('HOLDOUT 1: the old answer was correct and the world did not change', () => {
  it('HO-01a unchanged_confirmed only with a fresh official observation after the answer', async () => {
    const r = await start({ steps: [[o(90)], [o(90)]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-01a', a.verdict);
    expect(a.finding?.baseline?.value.amount).toBe(90);
    expect(a.finding?.current?.value?.amount).toBe(90);
    expect(a.text).toContain('the official page still showed the same price');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-01b the same history on an unregistered domain is only no_evidence_of_change', async () => {
    const r = await start({ steps: [[o(90)], [o(90)]], registry: 'none' });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-01b', a.verdict);
    expect(a.text).toContain('no sign of a change');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-01c a re-observation with no provider marker is only no_evidence_of_change', async () => {
    const r = await start({ steps: [[o(90)], [o(90, { marker: 'none' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-01c', a.verdict);
    expect(a.finding?.coverage.freshOfficialFetched).toBe(false);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-01d a re-observation from a cached result is only no_evidence_of_change', async () => {
    const r = await start({ steps: [[o(90)], [o(90, { marker: 'cached' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-01d', a.verdict);
    expect(a.finding?.coverage.freshOfficialFetched).toBe(false);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});

describe('HOLDOUT 2: the old answer was wrong when it was given', () => {
  it('HO-02a baseline_incorrect when the page says the other price was already effective at the answer', async () => {
    const r = await start({ steps: [[o(90)], [oEff(100, '1 November 2026')]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-02a', a.verdict);
    expect(a.finding?.verdictReason).toBe('other_value_in_effect_at_T0');
    expect(a.text).toContain('my earlier answer was already out of date');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-02b the same different price without any date is differs_timing_unknown', async () => {
    const r = await start({ steps: [[o(90)], [o(100)]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-02b', a.verdict);
    expect(a.text).toContain("I can't tell whether it changed after my answer");
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-02c a tier C page cannot retract a tier C baseline', async () => {
    const r = await start({
      steps: [[o(90)], [oEff(100, '1 November 2026')]],
      registry: 'none',
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-02c', a.verdict);
    expect(a.finding?.verdictReason).toBe('low_authority_source');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});
