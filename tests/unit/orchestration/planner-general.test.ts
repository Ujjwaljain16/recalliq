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

describe('planner: "what is new in X" with no interval is a general question', () => {
  const since: ResolvedContext['temporal'][number] = {
    mention: {
      text: 'since Monday',
      expr: {
        kind: 'since' as const,
        anchor: { kind: 'weekday' as const, weekday: 1, modifier: 'last' as const },
      },
      role: 'change_since' as const,
    },
    candidates: [
      {
        startMs: NOW - 2 * 86_400_000,
        endMs: NOW - 86_400_000,
        localDate: '2026-11-09',
        tz: 'UTC',
      },
    ],
    status: 'resolved' as const,
  };

  it('the live case: "What is new in Node.js 24?" plans the analysis queries and the release notes, no release tracking', () => {
    const node = entityRecord('Node.js', { domains: ['nodejs.org'] });
    const plan = planner.plan(
      ctx({ entities: [node] }),
      analysis({
        laneHint: 'research',
        intents: ['releases'],
        entities: [mention('Node.js')],
        queries: ['Node.js 24 new features', 'Node.js 24 release highlights'],
      }),
      NOW,
    );
    expect(plan.specs.map((s) => [s.request.query, s.intent, s.entityId])).toEqual([
      ['Node.js 24 new features', 'general', node.id],
      ['Node.js release notes', 'general', node.id],
      ['Node.js 24 release highlights', 'general', node.id],
    ]);
    for (const s of plan.specs) {
      expect(s.request.startPublishedDate).toBeUndefined();
      expect(s.request.includeDomains).toBeUndefined();
    }
    expect([...plan.specs, ...plan.fallback].some((s) => s.intent === 'releases')).toBe(false);
  });

  it('"What is the latest stable version of TypeScript?" with no analysis query still searches the release notes', () => {
    const ts = entityRecord('TypeScript');
    const plan = planner.plan(
      ctx({ entities: [ts] }),
      analysis({ intents: ['releases'], entities: [mention('TypeScript')] }),
      NOW,
    );
    expect(plan.specs.map((s) => [s.request.query, s.intent])).toEqual([
      ['TypeScript release notes', 'general'],
    ]);
  });

  it('with a "since" anchor the releases are tracked as before, from that day', () => {
    const node = entityRecord('Node.js', { domains: ['nodejs.org'] });
    const plan = planner.plan(
      ctx({ entities: [node], temporal: [since] }),
      analysis({ intents: ['releases'], entities: [mention('Node.js')] }),
      NOW,
    );
    expect(plan.specs.map((s) => s.intent)).toEqual(['releases']);
    expect(plan.specs[0]?.request.startPublishedDate).toBe(NOW - 2 * 86_400_000);
  });
});
