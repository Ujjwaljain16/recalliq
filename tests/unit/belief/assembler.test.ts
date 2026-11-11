import { describe, expect, it } from 'vitest';
import { assertAllowedCombination, FindingAssembler } from '../../../src/belief/assembler.js';
import { RuleChangeDetector } from '../../../src/belief/detector.js';
import type {
  Belief,
  Finding,
  FindingCurrentStatus,
  PriceVerdict,
  SourceSnapshot,
  VerifiedEvidence,
} from '../../../src/shared/index.js';
import { snapshot } from '../evidence/support.js';
import {
  baseline,
  DAY,
  ev,
  GB_URL,
  LIST_KEY,
  NOW,
  OK_COVERAGE,
  resolveAll,
  T0,
} from './support.js';

const entity = {
  id: 'ent_acme' as const,
  name: 'Acme CRM',
  aliases: ['Acme'],
  plans: ['pro'],
  officialDomains: ['acme.example'],
};

let n = 0;
const assembler = () =>
  new FindingAssembler({ detector: new RuleChangeDetector(), newFindingId: () => `fnd_${++n}` });

function snaps(...e: VerifiedEvidence[]): Map<SourceSnapshot['id'], SourceSnapshot> {
  return new Map(
    e.map((x) => [
      x.snapshotId,
      snapshot('x', { id: x.snapshotId, urlNorm: x.urlNorm, url: `https://${x.urlNorm}` }),
    ]),
  );
}

describe('allowed combinations of status and verdict (T-FND-01)', () => {
  const ok: Array<[FindingCurrentStatus, PriceVerdict | null, string | null]> = [
    ['confirmed', 'changed', null],
    ['confirmed', 'baseline_incorrect', null],
    ['confirmed', 'differs_timing_unknown', null],
    ['confirmed', 'unchanged_confirmed', null],
    ['confirmed', 'no_evidence_of_change', null],
    ['confirmed', 'contested', 'timing_conflict'],
    ['contested', 'contested', null],
    ['stale', 'no_evidence_of_change', null],
    ['stale', 'baseline_incorrect', 'unsupported_at_time'],
    ['unknown', 'no_evidence_of_change', null],
    ['unable_to_verify', 'unable_to_verify', 'deadline'],
    ['confirmed', null, null],
  ];
  it.each(ok)('allows %s with %s', (currentStatus, verdict, verdictReason) => {
    expect(() =>
      assertAllowedCombination({
        intent: 'pricing',
        currentStatus,
        verdict,
        verdictReason: verdictReason as never,
      }),
    ).not.toThrow();
  });

  const bad: Array<[FindingCurrentStatus, PriceVerdict]> = [
    ['contested', 'changed'],
    ['contested', 'unchanged_confirmed'],
    ['stale', 'changed'],
    ['stale', 'unchanged_confirmed'],
    ['unknown', 'differs_timing_unknown'],
    ['unable_to_verify', 'no_evidence_of_change'],
    ['confirmed', 'unable_to_verify'],
  ];
  it.each(bad)('rejects %s with %s', (currentStatus, verdict) => {
    expect(() =>
      assertAllowedCombination({ intent: 'pricing', currentStatus, verdict, verdictReason: null }),
    ).toThrow();
  });

  it('rejects a contested verdict on a confirmed belief without a timing conflict', () => {
    expect(() =>
      assertAllowedCombination({
        intent: 'pricing',
        currentStatus: 'confirmed',
        verdict: 'contested',
        verdictReason: null,
      }),
    ).toThrow('timing_conflict');
  });

  it('applies the release rules', () => {
    const f = (currentStatus: FindingCurrentStatus, verdict: Finding['verdict']) => () =>
      assertAllowedCombination({ intent: 'releases', currentStatus, verdict, verdictReason: null });
    expect(f('confirmed', 'releases_found')).not.toThrow();
    expect(f('unknown', 'none_found')).not.toThrow();
    expect(f('unable_to_verify', 'unable_to_verify')).not.toThrow();
    expect(f('unable_to_verify', 'none_found')).toThrow();
    expect(f('confirmed', 'unable_to_verify')).toThrow();
  });
});

describe('finding assembly', () => {
  const inputFor = (
    evidence: VerifiedEvidence[],
    beliefs: Belief[],
    extra: Partial<Parameters<FindingAssembler['assemble']>[0]['entities'][number]> = {},
  ) => ({
    turnId: 'trn_1' as const,
    createdAt: NOW,
    snapshots: snaps(...evidence),
    entities: [
      {
        entity,
        intents: ['pricing' as const],
        coverage: OK_COVERAGE,
        beliefs,
        evidenceByKey: new Map([[LIST_KEY, evidence]]),
        releaseEvidence: [],
        baselines: [],
        releaseSince: T0,
        ...extra,
      },
    ],
  });

  it('T-FND-02: a research price finding has no verdict, cites its sources, and offers derived arithmetic', () => {
    const e = ev({ id: 'a', observedAt: NOW - DAY });
    const set = assembler().assemble(inputFor([e], [resolveAll([e]).belief]));
    const f = set.findings[0];
    expect(f).toMatchObject({
      ord: 1,
      verdict: null,
      currentStatus: 'confirmed',
      beliefKey: LIST_KEY,
    });
    expect(f?.current?.citations).toEqual([e.snapshotId]);
    expect(f?.derived?.[0]).toMatchObject({
      label: 'annualised',
      amount: 1080,
      formula: '90 x 12',
    });
    expect(set.sources[e.snapshotId]).toMatchObject({
      tier: 'A1',
      domain: 'acme.example',
      url: `https://${GB_URL}`,
    });
  });

  it('T-FND-03: an entity with no belief gets one unknown finding, or unable_to_verify on a coverage failure', () => {
    const none = assembler().assemble(inputFor([], []));
    expect(none.findings).toHaveLength(1);
    expect(none.findings[0]).toMatchObject({
      currentStatus: 'unknown',
      beliefKey: null,
      verdict: null,
    });
    const failed = assembler().assemble(
      inputFor([], [], { coverage: { ...OK_COVERAGE, failure: 'quota_exhausted' } }),
    );
    expect(failed.findings[0]).toMatchObject({
      currentStatus: 'unable_to_verify',
      verdictReason: 'quota_exhausted',
    });
  });

  it('T-FND-04: a coverage failure hides a belief rather than presenting it as current', () => {
    const e = ev({ id: 'a', observedAt: NOW - DAY });
    const set = assembler().assemble(
      inputFor([e], [resolveAll([e]).belief], {
        coverage: { ...OK_COVERAGE, extractionFailed: true },
      }),
    );
    expect(set.findings[0]).toMatchObject({
      currentStatus: 'unable_to_verify',
      verdictReason: 'extraction_failed',
    });
    expect(set.findings[0]?.current).toBeUndefined();
  });

  it('T-FND-05: planned beliefs are not findings of their own; a contested belief shows both values', () => {
    const a = ev({
      id: 'a',
      amount: 100,
      observedAt: NOW - 3 * DAY,
      urlNorm: 'acme.example/en-gb/plans',
    });
    const b = ev({ id: 'b', amount: 110, observedAt: NOW - 2 * DAY });
    const contested = resolveAll([a, b]).belief;
    const planned = ev({ id: 'p', amount: 120, modality: 'planned', effectiveFrom: NOW + DAY });
    const plannedBelief = resolveAll([planned], planned.beliefKey ?? '').belief;
    const set = assembler().assemble(inputFor([a, b, planned], [contested, plannedBelief]));
    expect(set.findings).toHaveLength(1);
    expect(set.findings[0]?.currentStatus).toBe('contested');
    expect(set.findings[0]?.current?.contested?.map((g) => g.value.amount).sort()).toEqual([
      100, 110,
    ]);
  });

  it('T-FND-06: an audit finding carries the baseline, the detector verdict and a difference', () => {
    const b = baseline();
    const nu = ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY });
    const all = [...b.evidence, nu];
    const set = assembler().assemble(inputFor(all, [resolveAll(all).belief], { baselines: [b] }));
    const f = set.findings[0];
    expect(f).toMatchObject({
      verdict: 'differs_timing_unknown',
      direction: 'up',
      currentStatus: 'confirmed',
    });
    expect(f?.baseline).toMatchObject({
      presentedAt: T0,
      assertionId: 'asr_1',
      value: { amount: 90 },
    });
    expect(f?.derived?.find((d) => d.label === 'difference')).toMatchObject({
      amount: 10,
      formula: '100 - 90',
    });
    expect(f?.baseline?.citations).toEqual([b.evidence[0]?.snapshotId]);
  });

  it('T-FND-07: a comparable listing under another key is noted as listed_differently', () => {
    const b = baseline();
    const annual = ev({
      id: 'ann',
      amount: 900,
      value: { billingPeriod: 'unspecified' },
      observedAt: NOW - DAY,
    });
    expect(annual.beliefKey).not.toBe(LIST_KEY);
    const annualBelief = resolveAll([annual], annual.beliefKey ?? '').belief;
    const set = assembler().assemble(
      inputFor([annual], [annualBelief], { baselines: [{ ...b, presentedAt: NOW - 50 * DAY }] }),
    );
    expect(set.findings[0]).toMatchObject({
      verdict: 'no_evidence_of_change',
      verdictReason: 'listed_differently',
    });
  });

  it('T-FND-08: release findings list items, flag an announcement made before the answer, and cite sources', () => {
    const r = (id: string, over: Partial<VerifiedEvidence>): VerifiedEvidence => ({
      ...ev({ id }),
      kind: 'release',
      beliefKey: null,
      fields: {
        plan: null,
        planNorm: null,
        attribute: 'release',
        value: null,
        conditions: null,
        releaseTitle: `Title ${id}`,
        releaseKind: 'launch',
      },
      ...over,
    });
    const early = r('early', {
      providerPublishedAt: T0 - DAY,
      eventDate: T0 + DAY,
      significance: 'major',
    });
    const plain = r('plain', { eventDate: T0 + 2 * DAY });
    const set = assembler().assemble(
      inputFor([], [], { intents: ['releases'], releaseEvidence: [plain, early] }),
    );
    const f = set.findings[0];
    expect(f).toMatchObject({
      intent: 'releases',
      verdict: 'releases_found',
      currentStatus: 'confirmed',
    });
    expect(f?.releases?.map((x) => [x.title, x.announcedBeforeBaseline, x.significance])).toEqual([
      ['Title early', true, 'major'],
      ['Title plain', false, null],
    ]);
    const none = assembler().assemble(inputFor([], [], { intents: ['releases'] }));
    expect(none.findings[0]).toMatchObject({ verdict: 'none_found', currentStatus: 'unknown' });
    const unable = assembler().assemble(
      inputFor([], [], {
        intents: ['releases'],
        coverage: { ...OK_COVERAGE, failure: 'deadline' },
      }),
    );
    expect(unable.findings[0]).toMatchObject({
      verdict: 'unable_to_verify',
      currentStatus: 'unable_to_verify',
      verdictReason: 'deadline',
    });
  });

  it('T-FND-09: findings are numbered in order and ids come from the injected factory', () => {
    const e = ev({ id: 'a', observedAt: NOW - DAY });
    const set = assembler().assemble(
      inputFor([e], [resolveAll([e]).belief], { intents: ['pricing', 'releases'] }),
    );
    expect(set.findings.map((f) => f.ord)).toEqual([1, 2]);
    expect(set.findings.map((f) => f.intent)).toEqual(['pricing', 'releases']);
    expect(set.findings[0]?.id).toMatch(/^fnd_/);
  });
});
