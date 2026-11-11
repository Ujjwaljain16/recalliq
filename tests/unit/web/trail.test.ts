import { describe, expect, it } from 'vitest';
import {
  activeStep,
  createTrail,
  reduceTrail,
  summaryOf,
  trailSummary,
  type TrailState,
} from '../../../web/js/trail.js';
import type { SseEvent } from '../../../src/shared/sse.js';

function run(events: SseEvent[], end = 23_000): TrailState {
  let s = createTrail(0);
  for (const e of events) s = reduceTrail(s, e, end);
  return s;
}

const source = (domain: string) =>
  ({
    event: 'source',
    data: {
      sourceId: `src_${domain}`,
      url: `https://${domain}/`,
      domain,
      title: null,
      tier: 'A1',
      freshFetch: true,
      observedAt: 0,
      providerPublishedAt: null,
    },
  }) as SseEvent;
const progress = (stage: string) => ({ event: 'progress', data: { stage, text: '' } }) as SseEvent;
const context = (data: Record<string, unknown>) =>
  ({
    event: 'context',
    data: { lane: 'recall', resolvedDates: [], memoryHits: [], decisionIds: [], ...data },
  }) as SseEvent;
const plan = (entities: string[], intents: string[], plannedSearches: number) =>
  ({ event: 'plan', data: { entities, intents, plannedSearches } }) as SseEvent;
const completed = (status = 'complete') =>
  ({
    event: 'turn.completed',
    data: { status, metrics: { ttfpMs: 1, ttftMs: 2, ttcMs: 3 } },
  }) as SseEvent;

describe('activity trail', () => {
  it('follows a research turn from question to answer', () => {
    const s = run([
      { event: 'turn.started', data: { turnId: 'trn_1', userMessageId: 'msg_1' } },
      progress('ANALYZING'),
      progress('PLANNING'),
      plan(['A', 'B', 'C', 'D', 'E'], ['pricing'], 12),
      progress('SEARCHING'),
      source('a.example'),
      source('b.example'),
      source('a.example'),
      progress('EXTRACTING'),
      progress('VERIFYING'),
      progress('SYNTHESIZING'),
    ]);
    expect(s.steps.map((x) => x.label)).toEqual([
      'Understanding your question',
      'Searching 5 companies · 12 searches',
      'Reading 3 sources',
      'Checking the evidence',
      'Writing the answer',
    ]);
    expect(s.steps.find((x) => x.key === 'read')?.chips).toEqual(['a.example', 'b.example']);
    expect(s.steps.filter((x) => x.state === 'active').map((x) => x.key)).toEqual(['write']);
    expect(activeStep(s)?.label).toBe('Writing the answer');

    const done = reduceTrail(s, completed(), 23_400);
    expect(done.running).toBe(false);
    expect(done.steps.every((x) => x.state === 'done')).toBe(true);
    expect(summaryOf(done)).toBe('Searched 12 times · 3 sources · 23 s');
  });

  it('names a single company and a general web search', () => {
    expect(run([plan(['Supabase'], ['pricing'], 3)]).steps[0]?.label).toBe(
      'Searching Supabase · 3 searches',
    );
    const web = run([progress('SEARCHING'), plan(['Node.js'], ['general'], 1)]);
    expect(web.steps.map((x) => x.label)).toEqual(['Searching the web · 1 search']);
    expect(run([progress('SEARCHING')]).steps[0]?.label).toBe('Searching the web');
  });

  it('says what it recalled, or that a day had no conversation', () => {
    const found = run([
      context({
        memoryHits: [
          { messageId: 'msg_9', localTime: '2026-11-09 10:00', excerpt: 'Shortlist five CRMs' },
        ],
      }),
    ]);
    expect(found.steps[0]).toMatchObject({
      label: 'Found your conversation from Monday 9 November',
      detail: 'Shortlist five CRMs',
    });
    const none = run([
      context({ resolvedDates: [{ text: 'on 3 November', localDates: ['2026-11-03'] }] }),
    ]);
    expect(none.steps[0]?.label).toBe('No earlier conversation on Tuesday 3 November');
    expect(run([context({ lane: 'research' })]).steps).toEqual([]);
    const self = run([
      { event: 'turn.started', data: { turnId: 'trn_1', userMessageId: 'msg_1' } },
      context({
        lane: 'research',
        memoryHits: [{ messageId: 'msg_1', localTime: '2026-11-12 10:00', excerpt: 'this one' }],
      }),
    ]);
    expect(self.memoryHits).toEqual([]);
    expect(self.steps.map((x) => x.key)).toEqual(['understand']);
  });

  it('summarises turns that searched nothing', () => {
    expect(trailSummary({ plannedSearches: null, sources: 0, recalled: 0, elapsedMs: 1800 })).toBe(
      'Answered · 2 s',
    );
    expect(trailSummary({ plannedSearches: null, sources: 0, recalled: 2, elapsedMs: null })).toBe(
      'Recalled 2 messages',
    );
    expect(
      trailSummary({
        plannedSearches: null,
        sources: 0,
        recalled: 0,
        elapsedMs: 1200,
        status: 'failed',
      }),
    ).toBe('Stopped · 1 s');
  });

  it('ignores events once the turn is over', () => {
    const done = run([completed()]);
    expect(reduceTrail(done, progress('SEARCHING'), 0)).toBe(done);
  });
});
