import { afterEach, describe, expect, it } from 'vitest';
import { BaselineLoader } from '../../../src/db/index.js';
import {
  DAY,
  eventsOfFinding,
  expectConsistent,
  expectVerdict,
  expectWording,
  o,
  oEff,
  Rig,
  TWO_DOMAINS,
  URL_NO_LOCALE,
  URL_OTHER_DOMAIN,
  URL_US,
  userIdOf,
  verdictEvents,
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

const NEUTRAL_AUDIT = ['Acme CRM now: [[F1]].'];

describe('HOLDOUT 9: locale', () => {
  it('HO-09a the same plan on the en-gb and en-us pages are two beliefs, never contested', async () => {
    const r = await start({ steps: [[o(90), o(100, { url: URL_US })]] });
    const turn = await r.research();
    expect(eventsOfFinding(turn).filter((f) => f.currentStatus === 'contested')).toEqual([]);
    const beliefs = r.t.app.db
      .prepare('SELECT belief_key, status FROM beliefs ORDER BY belief_key')
      .all() as Array<{ belief_key: string; status: string }>;
    expect(beliefs).toHaveLength(2);
    expect(beliefs.map((b) => b.status)).toEqual(['confirmed', 'confirmed']);
    expect(beliefs.some((b) => b.belief_key.includes('loc=en-GB'))).toBe(true);
    expect(beliefs.some((b) => b.belief_key.includes('loc=en-US'))).toBe(true);
  });

  it('HO-09b the other locale on the same page set never contests or changes the audited key', async () => {
    const r = await start({ steps: [[o(90)], [o(90), o(100, { url: URL_US })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-09b', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-09c an unknown locale never supports changed by re-observation bracketing', async () => {
    const r = await start({
      steps: [
        [o(90, { url: URL_NO_LOCALE })],
        [o(90, { url: URL_NO_LOCALE })],
        [o(100, { url: URL_NO_LOCALE })],
      ],
    });
    await r.research();
    const mid = await r.audit(9 * DAY);
    expect(mid.verdict).toBe('unchanged_confirmed');
    const last = await r.audit(10 * DAY);
    expectVerdict('HO-09c', last.verdict);
    expectWording(last.verdict, last.text);
    expectConsistent(r, last);
  });

  it('HO-09d an unknown locale never supports changed by an explicit effective date', async () => {
    const r = await start({
      steps: [
        [o(90, { url: URL_NO_LOCALE })],
        [oEff(100, '5 November 2026', { url: URL_NO_LOCALE })],
      ],
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-09d', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-09e a different price on another locale is no evidence about the audited key', async () => {
    const r = await start({ steps: [[o(90)], [o(100, { url: URL_US })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-09e', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});

describe('HOLDOUT 10: the acknowledgement boundary', () => {
  it('HO-10a a streamed but never acknowledged answer is not a baseline; the audit states no verdict about it', async () => {
    const r = await start({ steps: [[o(90)], [o(90)]] });
    const first = await r.research(false);
    expect(first.status).toBe('complete');
    expect(r.scalar('SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(0);
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-10a', a.verdict);
    expect(a.finding?.baseline).toBeUndefined();
    expect(verdictEvents(r, a.turn.turnId)).toEqual([]);
    expect(a.text).not.toMatch(/\bas of\b/);
    expect(a.text).not.toContain('the official page still showed the same price');
    expectWording(null, a.text);
    expectConsistent(r, a);
  });

  it('HO-10b a claim in a sentence that was never acknowledged is not a baseline', async () => {
    const r = await start({
      steps: [[o(90)], [o(90)]],
      researchSynth: ['I looked this up.', ' Acme CRM Pro is [[F1]].'],
      auditSynth: NEUTRAL_AUDIT,
    });
    const first = await r.research(0);
    expect(first.sentences).toHaveLength(2);
    expect(r.scalar('SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(0);
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-10b', a.verdict);
    expect(a.finding?.baseline).toBeUndefined();
    expectWording(null, a.text);
    expectConsistent(r, a);
  });

  it('HO-10c control: the same answer acknowledged late is a baseline', async () => {
    const r = await start({ steps: [[o(90)], [o(90)]] });
    await r.research(false);
    await r.ackFirstLate();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-10c', a.verdict);
    expect(a.finding?.baseline?.value.amount).toBe(90);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});

function recall(r: Rig, turnId: string): { eligible: number; reasons: string[][] } {
  const loader = new BaselineLoader(r.t.app.db);
  const user = userIdOf(r, turnId) as never;
  const eligible = loader.loadBaselines(user, turnId as never).length;
  const reasons = loader.recallUnverified(user, turnId as never).map((c) => [...c.reasons]);
  return { eligible, reasons };
}

describe('HOLDOUT 11: a claim about a contested or stale finding is not a baseline', () => {
  it('HO-11a an earlier answer about a contested finding is recalled as unverified, never audited', async () => {
    const r = await start({
      steps: [[o(90), o(100, { url: URL_OTHER_DOMAIN })], [o(90)]],
      registry: TWO_DOMAINS(),
      researchSynth: ['Acme CRM: [[F1]].'],
      auditSynth: NEUTRAL_AUDIT,
    });
    const first = await r.research();
    expect(eventsOfFinding(first)[0]?.currentStatus).toBe('contested');
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-11a', a.verdict);
    expect(a.finding?.baseline).toBeUndefined();
    const rec = recall(r, a.turn.turnId);
    expect(rec.eligible).toBe(0);
    expect(rec.reasons.flat()).toContain('finding_not_confirmed');
    expectWording(null, a.text);
    expectConsistent(r, a);
  });

  it('HO-11b an earlier answer about a stale finding is recalled as unverified, never audited', async () => {
    const r = await start({
      steps: [[o(90, { marker: 'none' })], [o(100)]],
      auditSynth: NEUTRAL_AUDIT,
    });
    const first = await r.research();
    expect(eventsOfFinding(first)[0]?.currentStatus).toBe('stale');
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-11b', a.verdict);
    expect(a.finding?.baseline).toBeUndefined();
    const rec = recall(r, a.turn.turnId);
    expect(rec.eligible).toBe(0);
    expect(rec.reasons.flat()).toContain('finding_not_confirmed');
    expectWording(null, a.text);
    expectConsistent(r, a);
  });

  it('HO-11c an earlier answer that said the price could not be checked is never audited', async () => {
    const r = await start({
      steps: ['unavailable', 'unavailable', [o(100)]],
      fallback: 'unavailable',
      researchSynth: ['Acme CRM: [[F1]].'],
      auditSynth: NEUTRAL_AUDIT,
    });
    const first = await r.research();
    expect(eventsOfFinding(first)[0]?.currentStatus).toBe('unable_to_verify');
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-11c', a.verdict);
    expect(a.finding?.baseline).toBeUndefined();
    expect(recall(r, a.turn.turnId).eligible).toBe(0);
    expectWording(null, a.text);
    expectConsistent(r, a);
  });
});
