import { describe, expect, it } from 'vitest';
import { FindingAssembler, strongestCrawlBasis } from '../../../src/belief/assembler.js';
import { RuleChangeDetector } from '../../../src/belief/detector.js';
import { timeFields } from '../../../src/evidence/verifier.js';
import type {
  CrawlBasis,
  EvidenceId,
  SourceSnapshot,
  VerifiedEvidence,
} from '../../../src/shared/index.js';
import { snapshot } from '../evidence/support.js';
import { baseline, DAY, ev, LIST_KEY, NOW, OK_COVERAGE, resolveAll, T0 } from './support.js';

/**
 * The recorded crawl basis is reported, never used: for the same evidence, a snapshot that says requested_live,
 * cached or unknown must produce the same belief, the same time fields and the same verdict.
 */
const NOT_CONFIRMED: CrawlBasis[] = ['requested_live', 'cached', 'unknown'];
const detector = new RuleChangeDetector();

interface Scenario {
  name: string;
  /** Evidence for the non-confirmed snapshots, built for one basis. */
  build: (basis: CrawlBasis) => VerifiedEvidence[];
}

const old = (basis: CrawlBasis, extra: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ id: 'old', amount: 90, observedAt: T0 + 2 * DAY, fresh: false, basis, ...extra });
const nu = (basis: CrawlBasis, extra: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY, fresh: false, basis, ...extra });

const scenarios: Scenario[] = [
  { name: 'one recent non-confirmed price', build: (b) => [nu(b, { observedAt: NOW - DAY })] },
  {
    name: 'a recent price that also has a provider last-updated time',
    build: (b) => [nu(b, { observedAt: NOW - DAY, lastUpdated: NOW - 2 * DAY })],
  },
  {
    name: 'a re-observation of the old value then the new value on one page',
    build: (b) => [old(b), nu(b)],
  },
  {
    name: 'two different values from two official pages',
    build: (b) => [
      nu(b, { observedAt: NOW - DAY }),
      ev({
        id: 'other',
        amount: 120,
        observedAt: NOW - DAY,
        fresh: false,
        basis: b,
        urlNorm: 'acme.example/other',
      }),
    ],
  },
  {
    name: 'a new value with an explicit effective date',
    build: (b) => [nu(b, { effectiveFrom: T0 + 5 * DAY })],
  },
  {
    name: 'a published-only price',
    build: (b) => [nu(b, { observedAt: NOW - DAY, published: NOW - 3 * DAY })],
  },
];

describe('crawl basis changes no belief, time field or verdict', () => {
  for (const sc of scenarios) {
    it(`${sc.name}: identical for ${NOT_CONFIRMED.join(', ')}`, () => {
      const outputs = NOT_CONFIRMED.map((basis) => {
        const evidence = sc.build(basis);
        const all = [...baseline().evidence, ...evidence];
        const belief = resolveAll(all);
        return {
          times: evidence.map((e) => [
            e.freshFetch,
            e.displayedAt,
            e.displayedAtBasis,
            e.observedAt,
          ]),
          belief,
          verdict: detector.price(baseline(), belief.belief, all, OK_COVERAGE),
        };
      });
      for (const o of outputs.slice(1)) expect(o).toEqual(outputs[0]);
    });
  }

  it('requested_live does not make evidence a fresh fetch or give it a displayed-at time', () => {
    const snap = snapshot('x', { freshFetch: false, crawlBasis: 'requested_live' });
    expect(timeFields(snap, null, null)).toMatchObject({
      freshFetch: false,
      displayedAt: null,
      displayedAtBasis: 'unknown',
    });
  });

  it('requested_live alone leaves a price stale, as cached does', () => {
    const status = (b: CrawlBasis) => resolveAll([nu(b, { observedAt: NOW - DAY })]).belief.status;
    expect(status('requested_live')).toBe('stale');
    expect(status('requested_live')).toBe(status('cached'));
    expect(status('requested_live')).not.toBe('confirmed');
  });

  it('only a real fresh fetch (confirmed_live) changes what the evidence proves', () => {
    const confirmed = ev({ id: 'c', observedAt: NOW - DAY, fresh: true, basis: 'confirmed_live' });
    expect(confirmed.freshFetch).toBe(true);
    expect(resolveAll([confirmed]).belief.status).toBe('confirmed');
  });
});

describe('the basis reaches the finding without changing it', () => {
  const entity = {
    id: 'ent_acme' as const,
    name: 'Acme CRM',
    aliases: ['Acme'],
    plans: ['pro'],
    officialDomains: ['acme.example'],
  };

  function assemble(basis: CrawlBasis | undefined) {
    const e = nu('cached', { observedAt: NOW - DAY });
    const belief = resolveAll([e]).belief;
    const snaps = new Map<SourceSnapshot['id'], SourceSnapshot>([
      [
        e.snapshotId,
        snapshot('x', {
          id: e.snapshotId,
          urlNorm: e.urlNorm,
          url: `https://${e.urlNorm}`,
          freshFetch: false,
          ...(basis !== undefined ? { crawlBasis: basis } : {}),
        }),
      ],
    ]);
    let n = 0;
    return new FindingAssembler({
      detector,
      newFindingId: () => `fnd_${++n}`,
    }).assemble({
      turnId: 'trn_1',
      createdAt: NOW,
      entities: [
        {
          entity,
          intents: ['pricing'],
          coverage: OK_COVERAGE,
          beliefs: [belief],
          evidenceByKey: new Map([[LIST_KEY, [e]]]),
          releaseEvidence: [],
          baselines: [],
          releaseSince: T0,
        },
      ],
      snapshots: snaps,
    }).findings[0];
  }

  it('a finding resting on requested_live says so, with the same status and verdict as cached', () => {
    const requested = assemble('requested_live');
    const cached = assemble('cached');
    expect(requested?.current?.crawlBasis).toBe('requested_live');
    expect(cached?.current?.crawlBasis).toBe('cached');
    const strip = (f: typeof requested) => {
      if (!f?.current) return f;
      const current = { ...f.current };
      delete current.crawlBasis;
      return { ...f, id: 'x', current };
    };
    expect(strip(requested)).toEqual(strip(cached));
    expect(requested?.currentStatus).toBe('stale');
  });

  it('a finding is unchanged, and carries no basis, when the snapshot has none', () => {
    expect(assemble(undefined)?.current).not.toHaveProperty('crawlBasis');
  });

  it('reports the strongest basis among the winning evidence', () => {
    const a = ev({ id: 'a', fresh: false, basis: 'unknown' });
    const b = ev({ id: 'b', fresh: false, basis: 'requested_live' });
    const byId = new Map<EvidenceId, VerifiedEvidence>([
      [a.id, a],
      [b.id, b],
    ]);
    const snaps = new Map<SourceSnapshot['id'], SourceSnapshot>([
      [a.snapshotId, snapshot('x', { id: a.snapshotId, crawlBasis: 'unknown' })],
      [b.snapshotId, snapshot('x', { id: b.snapshotId, crawlBasis: 'requested_live' })],
    ]);
    expect(strongestCrawlBasis([a.id, b.id], byId, snaps)).toBe('requested_live');
    expect(strongestCrawlBasis([], byId, snaps)).toBeUndefined();
  });
});
