import { describe, expect, it } from 'vitest';
import { FindingAssembler } from '../../../src/belief/assembler.js';
import { RuleChangeDetector } from '../../../src/belief/detector.js';
import { findingSchema } from '../../../src/db/schemas.js';
import type { VerifiedEvidence } from '../../../src/shared/index.js';
import { snapshot } from '../evidence/support.js';
import { DAY, ev, LIST_KEY, NOW, OK_COVERAGE, resolveAll, usd } from './support.js';

/**
 * Conflicting evidence for one belief key is contested, never a silent pick. Plans that a vendor lists at several
 * subscription tiers with different prices (the shape of a product catalog) are the motivating case. All data is
 * [SYNTHETIC].
 */

const PRO = 'Access the features available in Professional subscriptions';
const STARTER = 'Access the features available in Starter subscriptions';
const ENTERPRISE = 'Access the features available in Enterprise subscriptions';
/** A catalog row with no usable date: freshness is unconfirmed, so nothing is "current". */
const untimed = (
  id: string,
  amount: number,
  over: Parameters<typeof ev>[0] extends infer O ? Partial<O> : never = {},
) => ev({ id, amount, tier: 'A2', fresh: false, lastUpdated: null, published: null, ...over });

const catalog = () => [
  untimed('c20', 20, { conditions: STARTER }),
  untimed('c50', 50, { conditions: PRO }),
  untimed('c75', 75, { conditions: ENTERPRISE }),
];

describe('conflicting values at the top tier', () => {
  it('T-BEL-70: three untimed values for one plan are contested, each with its evidence and conditions', () => {
    const e = catalog();
    const { belief, transition } = resolveAll(e);
    expect(belief.status).toBe('contested');
    expect(belief.value).toBeNull();
    expect(belief.contestedValues).toEqual([
      { value: usd(20), evidenceIds: ['ev_c20'], conditions: [STARTER] },
      { value: usd(50), evidenceIds: ['ev_c50'], conditions: [PRO] },
      { value: usd(75), evidenceIds: ['ev_c75'], conditions: [ENTERPRISE] },
    ]);
    expect(belief.winningEvidence.sort()).toEqual(['ev_c20', 'ev_c50', 'ev_c75']);
    expect(belief.displayedAt).toBeNull();
    expect(transition?.reason).toBe('initial');
  });

  it('T-BEL-71: the outcome does not depend on the order the evidence arrives in', () => {
    const e = catalog();
    expect(resolveAll([...e].reverse()).belief).toEqual(resolveAll(e).belief);
  });

  it('T-BEL-72: the same value stated twice is not a conflict', () => {
    const { belief } = resolveAll([untimed('a', 20), untimed('b', 20, { conditions: PRO })]);
    expect(belief.status).toBe('stale');
    expect(belief.value?.amount).toBe(20);
    expect(belief.contestedValues).toBeUndefined();
  });

  it('T-BEL-73: a strictly later displayedAt of the same tier supersedes an earlier one, as before', () => {
    const old = ev({ id: 'old', amount: 20, tier: 'A2', observedAt: NOW - 60 * DAY });
    const later = ev({ id: 'late', amount: 50, tier: 'A2', observedAt: NOW - 45 * DAY });
    const { belief } = resolveAll([old, later]);
    expect(belief.status).toBe('stale');
    expect(belief.value?.amount).toBe(50);
    expect(belief.winningEvidence).toEqual(['ev_late']);
  });

  it('T-BEL-74: two values with the same displayedAt are tied, hence contested', () => {
    const a = ev({ id: 'a', amount: 20, tier: 'A2', observedAt: NOW - 60 * DAY });
    const b = ev({ id: 'b', amount: 50, tier: 'A2', observedAt: NOW - 60 * DAY });
    expect(resolveAll([a, b]).belief.status).toBe('contested');
  });

  it('T-BEL-75: a timed statement beats untimed ones of the same tier, as before', () => {
    const dated = ev({ id: 'dated', amount: 50, tier: 'A2', observedAt: NOW - 60 * DAY });
    const { belief } = resolveAll([dated, ...catalog()]);
    expect(belief.status).toBe('stale');
    expect(belief.value?.amount).toBe(50);
  });

  it('T-BEL-76: a higher tier wins over a conflicting lower tier, as before', () => {
    const a1 = untimed('top', 20, { tier: 'A1' });
    const { belief } = resolveAll([a1, untimed('x', 50), untimed('y', 75)]);
    expect(belief.status).toBe('stale');
    expect(belief.value?.amount).toBe(20);
    expect(belief.winningEvidence).toEqual(['ev_top']);
  });

  it('T-BEL-77: a conflict among lower-tier statements is hidden by a single higher-tier value', () => {
    const top = untimed('top', 20, { tier: 'A1' });
    const low = [untimed('b1', 50, { tier: 'B' }), untimed('b2', 75, { tier: 'B' })];
    const { belief } = resolveAll([top, ...low]);
    expect(belief.status).not.toBe('contested');
    expect(belief.value?.amount).toBe(20);
  });

  it('T-BEL-78: two top-tier conflicting values are contested even when lower tiers agree with one of them', () => {
    const { belief } = resolveAll([
      untimed('a', 20, { tier: 'A1' }),
      untimed('b', 50, { tier: 'A1' }),
      untimed('c', 20, { tier: 'B' }),
    ]);
    expect(belief.status).toBe('contested');
    expect(belief.contestedValues?.map((g) => g.value.amount)).toEqual([20, 50]);
  });

  it('T-BEL-79: values that differ in any dimension of the value are distinct, billing period and unit included', () => {
    const a = untimed('a', 20);
    const mk = (id: string, over: Partial<ReturnType<typeof usd>>): VerifiedEvidence => {
      const base = untimed(id, 20);
      return { ...base, beliefKey: LIST_KEY, fields: { ...base.fields, value: usd(20, over) } };
    };
    for (const over of [
      { billingPeriod: 'annual' as const },
      { unit: 'flat' as const },
      { valueKind: 'lower_bound' as const },
      { currency: 'EUR' },
      { usageUnit: 'gb' },
    ]) {
      expect(resolveAll([a, mk('b', over)]).belief.status, JSON.stringify(over)).toBe('contested');
    }
    // only the displayed symbol differs: not a different value
    expect(resolveAll([a, mk('s', { currencySymbol: '$' })]).belief.status).toBe('stale');
  });

  it('T-BEL-80: a contested stale belief that later gains a dated statement resolves to it (status becomes stale)', () => {
    const first = resolveAll(catalog());
    const dated = ev({ id: 'dated', amount: 50, tier: 'A2', observedAt: NOW - 60 * DAY });
    const second = resolveAll([...catalog(), dated], LIST_KEY, NOW, first.belief);
    expect(second.belief.status).toBe('stale');
    expect(second.belief.value?.amount).toBe(50);
    expect(second.transition?.reason).toBe('staled');
  });
});

describe('the finding carries the conflict', () => {
  const assembler = new FindingAssembler({
    detector: new RuleChangeDetector(),
    newFindingId: () => 'fnd_1',
  });
  const entity = {
    id: 'ent_acme' as const,
    name: 'Acme CRM',
    aliases: ['Acme'],
    plans: ['pro'],
    officialDomains: ['acme.example'],
  };

  it('T-BEL-81: a contested finding lists each value with its evidence, citations and conditions', () => {
    const e = catalog();
    const belief = resolveAll(e).belief;
    const set = assembler.assemble({
      turnId: 'trn_1',
      createdAt: NOW,
      snapshots: new Map(
        e.map((x) => [x.snapshotId, snapshot('x', { id: x.snapshotId, urlNorm: x.urlNorm })]),
      ),
      entities: [
        {
          entity,
          intents: ['pricing'],
          coverage: OK_COVERAGE,
          beliefs: [belief],
          evidenceByKey: new Map([[LIST_KEY, e]]),
          releaseEvidence: [],
          baselines: [],
          releaseSince: NOW - 30 * DAY,
        },
      ],
    });
    const f = set.findings[0];
    expect(f?.currentStatus).toBe('contested');
    expect(f?.current?.contested?.map((g) => [g.value.amount, g.conditions])).toEqual([
      [20, [STARTER]],
      [50, [PRO]],
      [75, [ENTERPRISE]],
    ]);
    expect(f?.current?.citations).toHaveLength(3);
    // and it survives the persistence schema
    const parsed = findingSchema.parse(JSON.parse(JSON.stringify(f)));
    expect(parsed.current?.contested?.[1]?.conditions).toEqual([PRO]);
  });
});
