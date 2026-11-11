import { describe, expect, it } from 'vitest';
import { DefaultResearchPlanner } from '../../../src/orchestration/planner.js';
import { routeTurn } from '../../../src/orchestration/routing.js';
import { newId } from '../../../src/shared/ids.js';
import type { Baseline, ResolvedContext } from '../../../src/shared/memory.js';
import type { Lane } from '../../../src/shared/understanding.js';
import { analysis, entityRecord, mention, NOW } from './fakes.js';

describe('routeTurn: deterministic lanes', () => {
  const lanes: Lane[] = ['chat', 'recall', 'research', 'audit', 'clarify'];

  it.each(lanes)('the %s hint is followed when no rule overrides it', (lane) => {
    const a = analysis({
      laneHint: lane,
      entities: [mention('HubSpot')],
      queries: ['hubspot pricing'],
    });
    expect(routeTurn(a)).toEqual({ lane, reason: 'hint' });
  });

  it('recall + asksStillCorrect becomes audit', () => {
    expect(routeTurn(analysis({ laneHint: 'recall', asksStillCorrect: true }))).toEqual({
      lane: 'audit',
      reason: 'recall_asks_still_correct',
    });
  });

  it('asksStillCorrect on any other lane does not change it', () => {
    for (const lane of ['chat', 'research', 'clarify'] as const) {
      const a = analysis({ laneHint: lane, asksStillCorrect: true, entities: [mention('X')] });
      expect(routeTurn(a).lane).toBe(lane);
    }
  });

  it('research with no entity and no query falls back to chat', () => {
    expect(routeTurn(analysis({ laneHint: 'research' }))).toEqual({
      lane: 'chat',
      reason: 'research_without_subject',
    });
  });

  it('research with only an entity, or only a query, stays research', () => {
    expect(routeTurn(analysis({ laneHint: 'research', entities: [mention('A')] })).lane).toBe(
      'research',
    );
    expect(routeTurn(analysis({ laneHint: 'research', queries: ['q'] })).lane).toBe('research');
  });
});

function ctx(over: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    lane: 'research',
    temporal: [],
    memoryHits: [],
    decisions: [],
    entities: [],
    baselines: [],
    ...over,
  };
}

describe('DefaultResearchPlanner', () => {
  const planner = new DefaultResearchPlanner();

  it('plans a pricing round 1 (live, text, official domain) and a round 2 fallback', () => {
    const hubspot = entityRecord('HubSpot', { domains: ['hubspot.com'] });
    const plan = planner.plan(
      ctx({ entities: [hubspot] }),
      analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('HubSpot')] }),
      NOW,
    );
    expect(plan.specs).toHaveLength(1);
    const [r1] = plan.specs;
    expect(r1?.request).toMatchObject({
      query: 'HubSpot pricing',
      numResults: 5,
      includeDomains: ['hubspot.com'],
      freshness: 'live',
      contentMode: 'text',
    });
    expect(r1?.entityId).toBe(hubspot.id);
    const [r2] = plan.fallback;
    expect(r2?.round).toBe(2);
    expect(r2?.request).toMatchObject({
      query: 'HubSpot pricing plans per user 2026',
      numResults: 8,
      freshness: 'cached',
      contentMode: 'text',
    });
    expect(r2?.request.includeDomains).toBeUndefined();
  });

  it('adds an official-domain discovery search when no official domain is known', () => {
    const plan = planner.plan(
      ctx(),
      analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Acme')] }),
      NOW,
    );
    const kinds = plan.specs.map((s) => s.intent);
    expect(kinds).toEqual(['official_domain_discovery', 'pricing']);
    expect(plan.specs[0]?.request).toMatchObject({ query: 'Acme official site', numResults: 3 });
    expect(plan.specs[0]?.entityId).toBeNull();
  });

  it('plans releases from T0 = the earliest presented baseline of the entity', () => {
    const e = entityRecord('Notion');
    const base = (at: number): Baseline =>
      ({ entityId: e.id, presentedAt: at }) as unknown as Baseline;
    const plan = planner.plan(
      ctx({ entities: [e], baselines: [base(NOW - 5_000), base(NOW - 9_000)] }),
      analysis({ laneHint: 'audit', intents: ['releases'], entities: [mention('Notion')] }),
      NOW,
    );
    expect(plan.specs[0]?.request).toMatchObject({
      query: 'Notion announces new',
      numResults: 6,
      startPublishedDate: NOW - 9_000,
      contentMode: 'highlights',
    });
    expect(plan.fallback[0]?.request).toMatchObject({
      query: 'Notion launch OR release',
      category: 'news',
      numResults: 8,
      startPublishedDate: NOW - 9_000,
    });
  });

  it('plans general queries from the analysis, at most 3, with one alternate', () => {
    const plan = planner.plan(
      ctx(),
      analysis({
        laneHint: 'research',
        intents: ['general'],
        entities: [mention('Linear')],
        queries: ['a', 'b', 'c', 'd'],
        alternateQueries: ['alt1', 'alt2'],
      }),
      NOW,
    );
    expect(plan.specs.map((s) => s.request.query)).toEqual(['a', 'b', 'c']);
    expect(plan.fallback.map((s) => s.request.query)).toEqual(['alt1']);
  });

  it('never plans more than 6 entities, 4 searches per entity or 16 per turn', () => {
    const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'];
    const plan = planner.plan(
      ctx(),
      analysis({
        laneHint: 'research',
        intents: ['pricing', 'releases', 'general'],
        entities: names.map(mention),
        queries: ['q1', 'q2', 'q3'],
      }),
      NOW,
    );
    const all = [...plan.specs, ...plan.fallback];
    expect(all.length).toBeLessThanOrEqual(16);
    const perEntity = new Map<string, number>();
    for (const s of all) {
      const key = s.id.split(':')[0] ?? '';
      perEntity.set(key, (perEntity.get(key) ?? 0) + 1);
    }
    expect(perEntity.size).toBeLessThanOrEqual(6);
    for (const n of perEntity.values()) expect(n).toBeLessThanOrEqual(4);
    // the two entities beyond the sixth are not planned
    expect(all.some((s) => s.id.startsWith('g7') || s.id.startsWith('h8'))).toBe(false);
  });

  it('keeps every entity round-1 search before any fallback when the turn cap cuts', () => {
    const plan = planner.plan(
      ctx(),
      analysis({
        laneHint: 'research',
        intents: ['pricing'],
        entities: ['A', 'B', 'C', 'D', 'E', 'F'].map(mention),
      }),
      NOW,
    );
    // 6 entities x (discovery + price + fallback) = 18 > 16: the cut removes fallbacks only
    const pricingR1 = plan.specs.filter((s) => s.intent === 'pricing');
    expect(pricingR1).toHaveLength(6);
    expect(plan.specs.length + plan.fallback.length).toBe(16);
  });

  it('de-duplicates identical queries within a turn', () => {
    const plan = planner.plan(
      ctx(),
      analysis({
        laneHint: 'research',
        intents: ['general'],
        entities: [mention('Same'), mention('same')],
        queries: ['same pricing', 'same pricing'],
      }),
      NOW,
    );
    expect(plan.specs.map((s) => s.request.query)).toEqual(['same pricing']);
  });

  it('is deterministic and plans nothing when there is nothing to search for', () => {
    const a = analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Z')] });
    expect(planner.plan(ctx(), a, NOW)).toEqual(planner.plan(ctx(), a, NOW));
    expect(planner.plan(ctx(), analysis({ laneHint: 'research' }), NOW).specs).toEqual([]);
  });

  it('uses a resolved entity id, and the analysis guess only as a search filter', () => {
    const id = newId('ent');
    const plan = planner.plan(
      ctx({ entities: [{ ...entityRecord('Known'), id, officialDomains: ['known.io'] }] }),
      analysis({
        laneHint: 'research',
        intents: ['pricing'],
        entities: [mention('Known'), { ...mention('Guess'), officialDomainGuess: 'guess.dev' }],
      }),
      NOW,
    );
    const guess = plan.specs.find((s) => s.request.query === 'Guess pricing');
    expect(guess?.entityId).toBeNull();
    expect(guess?.request.includeDomains).toEqual(['guess.dev']);
    expect(plan.specs.find((s) => s.request.query === 'Known pricing')?.entityId).toBe(id);
  });
});
