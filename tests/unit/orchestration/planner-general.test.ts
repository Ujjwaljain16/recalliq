import { describe, expect, it } from 'vitest';
import { DefaultResearchPlanner } from '../../../src/orchestration/planner.js';
import type { ResolvedContext } from '../../../src/shared/memory.js';
import { analysis, entityRecord, mention, NOW } from './fakes.js';

/** [SYNTHETIC] queries and names only. */
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

const planner = new DefaultResearchPlanner();

describe('planner: the general research path', () => {
  it('plans the analysis queries with no entity, as general specs that run no extraction', () => {
    const plan = planner.plan(
      ctx(),
      analysis({
        laneHint: 'research',
        intents: ['general'],
        queries: ['ExampleRuntime 24 new features', 'ExampleRuntime 24 changelog'],
      }),
      NOW,
    );
    expect(plan.specs.map((s) => [s.request.query, s.entityId, s.intent, s.round])).toEqual([
      ['ExampleRuntime 24 new features', null, 'general', 1],
      ['ExampleRuntime 24 changelog', null, 'general', 1],
    ]);
    for (const s of plan.specs) {
      expect(s.request).toMatchObject({
        numResults: 5,
        freshness: 'cached',
        contentMode: 'highlights',
      });
      expect(s.request.includeDomains).toBeUndefined();
    }
    expect(plan.fallback).toEqual([]);
  });

  it('caps the queries at three, drops blanks, and makes the first alternate a round-2 fallback', () => {
    const plan = planner.plan(
      ctx(),
      analysis({
        intents: [],
        queries: ['a one', ' ', 'b two', 'c three', 'd four'],
        alternateQueries: ['', 'alt five'],
      }),
      NOW,
    );
    expect(plan.specs.map((s) => s.request.query)).toEqual(['a one', 'b two', 'c three']);
    expect(plan.fallback.map((s) => [s.request.query, s.round, s.entityId])).toEqual([
      ['alt five', 2, null],
    ]);
  });

  it('searches a stated subject with a pricing intent and no entity as a general query too', () => {
    const plan = planner.plan(
      ctx(),
      analysis({ intents: ['pricing'], queries: ['managed Postgres hosting pricing'] }),
      NOW,
    );
    expect(plan.specs.map((s) => [s.request.query, s.entityId, s.intent])).toEqual([
      ['managed Postgres hosting pricing', null, 'general'],
    ]);
  });

  it('plans nothing with neither an entity nor a query', () => {
    const plan = planner.plan(ctx(), analysis({ intents: ['general'] }), NOW);
    expect(plan.specs).toEqual([]);
    expect(plan.fallback).toEqual([]);
  });

  it('keeps the resolved day of the question as the earliest publication date', () => {
    const start = NOW - 3 * 86_400_000;
    const plan = planner.plan(
      ctx({
        temporal: [
          {
            mention: { text: 'last week', expr: { kind: 'last_week' }, role: 'event_time' },
            candidates: [{ startMs: start, endMs: NOW, localDate: '2026-11-01' } as never],
            status: 'resolved',
          },
        ],
      }),
      analysis({ intents: ['general'], queries: ['who won the race'] }),
      NOW,
    );
    expect(plan.specs[0]?.request.startPublishedDate).toBe(start);
  });

  it('leaves pricing for a named entity as it was: price searches, never general ones', () => {
    const plan = planner.plan(
      ctx({ entities: [entityRecord('Acme CRM', { domains: ['acme.example'] })] }),
      analysis({ intents: ['pricing'], queries: ['acme crm cost'] }),
      NOW,
    );
    expect(plan.specs.every((s) => s.intent === 'pricing')).toBe(true);
    expect(plan.specs[0]?.request.query).toBe('Acme CRM pricing');
  });

  it('with entities named, plans per entity and not entity-less queries', () => {
    const plan = planner.plan(
      ctx(),
      analysis({ intents: ['general'], entities: [mention('Beta Suite')], queries: ['q one'] }),
      NOW,
    );
    expect(plan.specs.map((s) => s.entityId)).toEqual([null]);
    expect(plan.specs[0]?.id.startsWith('beta suite:general')).toBe(true);
  });
});
