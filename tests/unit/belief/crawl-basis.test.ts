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
 * A requested live crawl (Exa reports none per result) counts as what the page showed when it was read, so a
 * price can be current and an earlier answer can be a baseline. It never times a change: only a confirmed fresh
 * fetch or a stated effective date can make a verdict "changed".
 */
const detector = new RuleChangeDetector();

const old = (basis: CrawlBasis, extra: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ id: 'old', amount: 90, observedAt: T0 + 2 * DAY, fresh: false, basis, ...extra });
const nu = (basis: CrawlBasis, extra: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY, fresh: false, basis, ...extra });

describe('a requested live crawl', () => {
  it('dates the evidence at the time it was read, without calling it a fresh fetch', () => {
    const snap = snapshot('x', { freshFetch: false, crawlBasis: 'requested_live' });
    expect(timeFields(snap, null, null)).toMatchObject({
      freshFetch: false,
      displayedAt: snap.observedAt,
      displayedAtBasis: 'unknown',
    });
  });

  it('does not when the crawl failed, and cached or unknown content stays undated', () => {
    for (const s of [
      snapshot('x', { freshFetch: false, crawlBasis: 'requested_live', crawlStatus: 'failed' }),
      snapshot('x', { freshFetch: false, crawlBasis: 'cached' }),
      snapshot('x', { freshFetch: false, crawlBasis: 'unknown' }),
    ])
      expect(timeFields(s, null, null).displayedAt).toBeNull();
  });

  it('makes a recent price current, where cached content leaves it stale', () => {
    const status = (b: CrawlBasis) => resolveAll([nu(b, { observedAt: NOW - DAY })]).belief.status;
    expect(status('requested_live')).toBe('confirmed');
    expect(status('cached')).toBe('stale');
  });

  it('never times a change: the old value then a new one on one page is not "changed" without a fresh fetch', () => {
    const verdict = (b: CrawlBasis, fresh: boolean) => {
      const evidence = [
        old(b, { fresh, ...(fresh ? { basis: 'confirmed_live' as const } : {}) }),
        nu(b, { fresh, ...(fresh ? { basis: 'confirmed_live' as const } : {}) }),
      ];
      const all = [...baseline().evidence, ...evidence];
      return detector.price(baseline(), resolveAll(all).belief, all, OK_COVERAGE).verdict;
    };
    expect(verdict('requested_live', false)).not.toBe('changed');
    expect(verdict('cached', false)).not.toBe('changed');
  });

  it('only a real fresh fetch (confirmed_live) is a fresh fetch', () => {
    const confirmed = ev({ id: 'c', observedAt: NOW - DAY, fresh: true, basis: 'confirmed_live' });
    expect(confirmed.freshFetch).toBe(true);
    expect(confirmed.displayedAtBasis).toBe('fresh_fetch');
    expect(resolveAll([confirmed]).belief.status).toBe('confirmed');
  });
});

describe('the basis reaches the finding', () => {
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

  it('a finding resting on requested_live says so', () => {
    const requested = assemble('requested_live');
    const cached = assemble('cached');
    expect(requested?.current?.crawlBasis).toBe('requested_live');
    expect(cached?.current?.crawlBasis).toBe('cached');
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
