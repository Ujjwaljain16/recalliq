import { describe, expect, it } from 'vitest';
import { LlmError, type Finding, type SearchOutcome } from '../../../src/shared/index.js';
import { FakeBudget } from '../../helpers/budget.js';
import { count } from '../../helpers/db.js';
import {
  DAY,
  NOW,
  ScriptedExecutor,
  ScriptedLlm,
  T0,
  makeService,
  makeWorld,
  outcome,
  pricingPage,
  priceStatement,
  request,
  spec,
  storeSnapshot,
  storedBaseline,
  type World,
} from './support.js';

/** The research service over a real database, a scripted executor and a fixture-driven fake LLM. */

function onePrice(w: World, amount: number, opts: { fresh?: boolean; effective?: string } = {}) {
  const text = pricingPage(amount, opts.effective ? `, ${opts.effective}` : '');
  const id = storeSnapshot(w.t.db, w.userId, {
    text,
    observedAt: NOW - 1000,
    fresh: opts.fresh ?? true,
  });
  const quote = `Acme Pro US$${amount} per user per month, billed annually${opts.effective ? `, ${opts.effective}` : ''}`;
  const st = priceStatement({ quote }, amount);
  if (opts.effective) st.effectiveFromText = opts.effective.replace('effective ', '');
  return { id, st };
}

const finding = (f: Finding[], i = 0): Finding => {
  const x = f[i];
  if (!x) throw new Error('no finding');
  return x;
};

describe('research lane: search to finding', () => {
  it('T-RS-01: a fresh official price becomes verified evidence, a confirmed belief and a cited finding', async () => {
    const w = makeWorld();
    const { id, st } = onePrice(w, 90);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const { req, events } = request(w);
    const set = await service.run(req);

    expect(set.findings).toHaveLength(1);
    const f = finding(set.findings);
    expect(f).toMatchObject({
      currentStatus: 'confirmed',
      verdict: null,
      entityName: 'Acme CRM',
      intent: 'pricing',
    });
    expect(f.current?.value).toMatchObject({
      amount: 90,
      currency: 'USD',
      billingPeriod: 'monthly_billed_annually',
    });
    expect(f.current?.citations).toEqual([id]);
    expect(f.current?.verifiedAt).toBe(NOW - 1000);
    expect(f.derived?.[0]).toMatchObject({ label: 'annualised', amount: 1080 });
    expect(set.sources[id]).toMatchObject({ tier: 'A1', domain: 'acme.example' });

    expect(count(w.t.db, 'evidence_statements', "verification_status = 'pass'")).toBe(1);
    expect(count(w.t.db, 'beliefs')).toBe(1);
    expect(count(w.t.db, 'belief_history', "reason = 'initial'")).toBe(1);
    expect(events.map((e) => e.event)).toEqual(['source', 'finding']);
  });

  it('T-RS-02: a model proposal that fails verification is stored as such and never reaches a belief', async () => {
    const w = makeWorld();
    const { id } = onePrice(w, 90);
    const forged = priceStatement(
      { quote: 'Acme Pro US$80 per user per month, billed annually' },
      80,
    );
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [forged] })),
    );
    const set = await service.run(request(w).req);
    expect(count(w.t.db, 'evidence_statements', "verification_status = 'fail'")).toBe(1);
    expect(count(w.t.db, 'beliefs')).toBe(0);
    expect(finding(set.findings)).toMatchObject({ currentStatus: 'unknown', beliefKey: null });
  });

  it('T-RS-03: a competitor price on a comparison page is not attributed to the entity', async () => {
    const w = makeWorld();
    const text =
      'Acme CRM is widely used.\nBeta Suite Pro US$5 per user per month, billed annually';
    const id = storeSnapshot(w.t.db, w.userId, {
      text,
      observedAt: NOW - 1000,
      url: 'https://blog.example/compare',
      urlNorm: 'blog.example/compare',
      domain: 'blog.example',
    });
    const st = priceStatement(
      { quote: 'Beta Suite Pro US$5 per user per month, billed annually' },
      5,
    );
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { entities: [w.acme, w.beta] }).req);
    expect(count(w.t.db, 'evidence_statements', "verification_status = 'pass'")).toBe(0);
    expect(set.findings.every((f) => f.current === undefined)).toBe(true);
  });

  it('T-RS-04: a release search produces a release finding with its citation', async () => {
    const w = makeWorld();
    const text = 'Acme CRM news\nAcme CRM launched Acme Insights on 8 November 2026';
    const id = storeSnapshot(w.t.db, w.userId, {
      text,
      observedAt: NOW - 1000,
      url: 'https://acme.example/blog/insights',
      urlNorm: 'acme.example/blog/insights',
    });
    const st = priceStatement({
      kind: 'release',
      plan: null,
      planNorm: null,
      value: null,
      releaseTitle: 'Acme Insights',
      releaseKind: 'launch',
      quote: 'Acme CRM launched Acme Insights on 8 November 2026',
      eventDateText: '8 November 2026',
    });
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { intents: ['releases'], since: NOW - 30 * DAY }).req);
    const f = finding(set.findings);
    expect(f).toMatchObject({
      intent: 'releases',
      verdict: 'releases_found',
      currentStatus: 'confirmed',
    });
    expect(f.releases?.[0]).toMatchObject({
      title: 'Acme Insights',
      kind: 'launch',
      eventDate: Date.UTC(2026, 10, 8),
    });
    expect(f.releases?.[0]?.citations).toEqual([id]);
  });
});

describe('audit lane: verdicts from stored baselines', () => {
  it('T-RS-10: a new price with nothing about timing is differs_timing_unknown', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    const { id, st } = onePrice(w, 100);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { baselines: [baseline] }).req);
    const f = finding(set.findings);
    expect(f).toMatchObject({
      verdict: 'differs_timing_unknown',
      currentStatus: 'confirmed',
      direction: 'up',
    });
    expect(f.baseline).toMatchObject({ presentedAt: T0, value: { amount: 90 } });
    expect(f.derived?.find((d) => d.label === 'difference')?.amount).toBe(10);
    expect(f.changeWindow).toBeUndefined();
  });

  it('T-RS-11: the old price seen again after the answer, then the new price, on one page is changed with a window', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    // an earlier turn re-observed the OLD price after the answer
    const oldSnap = storeSnapshot(w.t.db, w.userId, {
      text: pricingPage(90),
      observedAt: T0 + 2 * DAY,
    });
    const past = request(w, { now: T0 + 2 * DAY });
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [oldSnap])] }),
      new ScriptedLlm(() => ({ statements: [priceStatement()] })),
    );
    await service.run(past.req);
    // now the new price
    const { id, st } = onePrice(w, 100);
    const service2 = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service2.run(request(w, { baselines: [baseline] }).req);
    expect(finding(set.findings)).toMatchObject({
      verdict: 'changed',
      verdictReason: 'same_source_bracketing',
      changeWindow: { after: T0 + 2 * DAY, notAfter: NOW - 1000 },
    });
  });

  it('T-RS-12: an explicit effective date after the answer gives changed from that date', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    const { id, st } = onePrice(w, 100, { effective: 'effective 5 November 2026' });
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { baselines: [baseline] }).req);
    expect(finding(set.findings)).toMatchObject({
      verdict: 'changed',
      verdictReason: 'stated_effective_date',
      effectiveFrom: Date.UTC(2026, 10, 5),
    });
  });

  it('T-RS-13: the same price on a live official page after the answer is unchanged_confirmed', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    const { id, st } = onePrice(w, 90);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { baselines: [baseline] }).req);
    expect(finding(set.findings)).toMatchObject({
      verdict: 'unchanged_confirmed',
      currentStatus: 'confirmed',
    });
  });

  it('T-RS-14: a baseline whose source no longer supports it is baseline_incorrect', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    // the baseline's snapshot text is forged to say something else by replacing the stored evidence quote
    const tampered = {
      ...baseline,
      evidence: baseline.evidence.map((e) => ({
        ...e,
        quote: 'Acme Pro US$91 per user per month, billed annually',
      })),
    };
    const { id, st } = onePrice(w, 90);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { baselines: [tampered] }).req);
    expect(finding(set.findings)).toMatchObject({
      verdict: 'baseline_incorrect',
      verdictReason: 'unsupported_at_time',
    });
  });
});

describe('failures of the world become coverage, never silence', () => {
  const failedOutcome = (w: World, code: SearchOutcome['errorCode']): SearchOutcome =>
    outcome(w.acme.id, [], { status: 'failed', ...(code ? { errorCode: code } : {}) });

  it('T-RS-20: a failed search is unable_to_verify with its reason, and never "unchanged"', async () => {
    const w = makeWorld();
    const baseline = storedBaseline(w);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [failedOutcome(w, 'timeout')] }),
      new ScriptedLlm(() => ({ statements: [] })),
    );
    const set = await service.run(request(w, { baselines: [baseline] }).req);
    const f = finding(set.findings);
    expect(f).toMatchObject({
      currentStatus: 'unable_to_verify',
      verdict: 'unable_to_verify',
      verdictReason: 'search_timeout',
    });
    expect(f.coverage).toMatchObject({
      searchesFailed: 1,
      searchesOk: 0,
      failure: 'search_timeout',
    });
  });

  it('T-RS-21: provider error codes map to coverage reasons', async () => {
    const reasons: Array<[SearchOutcome['errorCode'], string]> = [
      ['quota_exhausted', 'quota_exhausted'],
      ['rate_limited', 'search_unavailable'],
      ['unavailable', 'search_unavailable'],
      ['deadline', 'deadline'],
    ];
    for (const [code, reason] of reasons) {
      const w = makeWorld();
      const service = makeService(
        w,
        new ScriptedExecutor({ 1: [failedOutcome(w, code)] }),
        new ScriptedLlm(() => ({ statements: [] })),
      );
      const set = await service.run(request(w).req);
      expect(finding(set.findings).verdictReason).toBe(reason);
    }
  });

  it('T-RS-22: a failed extraction is unable_to_verify, and a deadline during extraction is reported as deadline', async () => {
    for (const [error, reason] of [
      [new LlmError('unavailable', 'down'), 'extraction_failed'],
      [new LlmError('cancelled', 'deadline'), 'deadline'],
    ] as const) {
      const w = makeWorld();
      const { id } = onePrice(w, 90);
      const service = makeService(
        w,
        new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }),
        new ScriptedLlm(() => error),
      );
      const set = await service.run(request(w).req);
      expect(finding(set.findings)).toMatchObject({
        currentStatus: 'unable_to_verify',
        verdictReason: reason,
      });
      expect(finding(set.findings).coverage.extractionFailed).toBe(true);
    }
  });

  it("T-RS-23: one entity failing does not hide another entity's result", async () => {
    const w = makeWorld();
    const { id, st } = onePrice(w, 90);
    const betaFailed = outcome(w.beta.id, [], { status: 'failed', errorCode: 'timeout' });
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id]), betaFailed] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w, { entities: [w.acme, w.beta] }).req);
    const byName = Object.fromEntries(set.findings.map((f) => [f.entityName, f]));
    expect(byName['Acme CRM']?.currentStatus).toBe('confirmed');
    expect(byName['Beta Suite']?.currentStatus).toBe('unable_to_verify');
  });

  it('T-RS-24: a failed search does not discredit an entity that has a live official price', async () => {
    const w = makeWorld();
    const { id, st } = onePrice(w, 90);
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id]), failedOutcome(w, 'timeout')] }),
      new ScriptedLlm(() => ({ statements: [st] })),
    );
    const set = await service.run(request(w).req);
    const f = finding(set.findings);
    expect(f.currentStatus).toBe('confirmed');
    expect(f.coverage).toMatchObject({ searchesFailed: 1, searchesOk: 1, failure: null });
  });

  it('T-RS-25: the fallback round runs only for entities still lacking official evidence, and only if admitted', async () => {
    const w = makeWorld();
    const { id, st } = onePrice(w, 90);
    const exec = new ScriptedExecutor({
      1: [outcome(w.acme.id, [], { status: 'empty' })],
      2: [outcome(w.acme.id, [id])],
    });
    const service = makeService(w, exec, new ScriptedLlm(() => ({ statements: [st] })));
    const { req } = request(w, { plan: { fallback: [spec(w.acme.id, 2), spec(w.beta.id, 2)] } });
    const set = await service.run(req);
    expect(exec.rounds).toEqual([1, 2]);
    expect(exec.plans[1]?.fallback.map((s) => s.entityId)).toEqual([w.acme.id]);
    expect(finding(set.findings).currentStatus).toBe('confirmed');

    const w2 = makeWorld();
    const exec2 = new ScriptedExecutor({ 1: [outcome(w2.acme.id, [], { status: 'empty' })] });
    const tight = new FakeBudget(60_000, NOW, 120_000); // admit() is false
    const svc2 = makeService(w2, exec2, new ScriptedLlm(() => ({ statements: [] })));
    await svc2.run(request(w2, { plan: { fallback: [spec(w2.acme.id, 2)] }, budget: tight }).req);
    expect(exec2.rounds).toEqual([1]);
  });
});

describe('our own failures propagate', () => {
  it('T-RS-30: a database rejection (an ownership trigger) is not converted into coverage', async () => {
    const w = makeWorld();
    const bob = w.t.users.create();
    const bobSnap = storeSnapshot(w.t.db, bob, { text: pricingPage(90), observedAt: NOW - 1000 });
    // a buggy snapshot reader that ignores the user scope returns another user's snapshot
    const leaky = { getMany: (_u: string, ids: string[]) => w.reader.getMany(bob, ids as never) };
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [bobSnap])] }),
      new ScriptedLlm(() => ({ statements: [priceStatement()] })),
      leaky,
    );
    await expect(service.run(request(w).req)).rejects.toThrow('evidence snapshot owner mismatch');
    expect(count(w.t.db, 'evidence_statements')).toBe(0);
  });

  it('T-RS-31: an unexpected error from the executor or the model client propagates', async () => {
    const w = makeWorld();
    const boom = makeService(
      w,
      new ScriptedExecutor({ 1: new TypeError('executor bug') }),
      new ScriptedLlm(() => ({ statements: [] })),
    );
    await expect(boom.run(request(w).req)).rejects.toThrow('executor bug');
    const { id } = onePrice(w, 90);
    const llmBug = {
      structured: () => Promise.reject(new TypeError('client bug')),
      stream: () => {
        throw new Error('unused');
      },
    };
    const svc = makeService(w, new ScriptedExecutor({ 1: [outcome(w.acme.id, [id])] }), llmBug);
    await expect(svc.run(request(w).req)).rejects.toThrow('client bug');
  });
});

describe('isolation between users', () => {
  it("T-RS-40: another user's snapshots and beliefs are never read", async () => {
    const w = makeWorld();
    const bob = w.t.users.create();
    const { turnId } = { turnId: null };
    void turnId;
    const bobSnap = storeSnapshot(w.t.db, bob, { text: pricingPage(5), observedAt: NOW - 1000 });
    const { id, st } = onePrice(w, 90);
    // the executor (wrongly) returns Bob's snapshot id too: the user-scoped reader drops it
    const service = makeService(
      w,
      new ScriptedExecutor({ 1: [outcome(w.acme.id, [id, bobSnap])] }),
      new ScriptedLlm((m) => {
        expect(m).not.toContain('US$5 ');
        return { statements: [st] };
      }),
    );
    const set = await service.run(request(w).req);
    expect(finding(set.findings).current?.value?.amount).toBe(90);
    expect(count(w.t.db, 'beliefs', 'user_id = ?', bob)).toBe(0);
  });
});
