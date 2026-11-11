import { describe, expect, it } from 'vitest';
import { analysisModelSchema, toTurnAnalysis } from '../../../src/llm/analysis/schema.js';
import { dayOf, mostRecentPastDay, peopleDate } from '../../../src/orchestration/lanes/common.js';
import { routeTurn } from '../../../src/orchestration/routing.js';
import type { IanaTz, Ms } from '../../../src/shared/ids.js';
import type { TemporalMention } from '../../../src/shared/understanding.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { analysis, laneInput } from './fakes.js';

// Thursday 12 November 2026, 10:00 in London (GMT, so also 10:00 UTC)
const THURSDAY: Ms = Date.UTC(2026, 10, 12, 10);
const LONDON = 'Europe/London' as IanaTz;
const resolver = new DefaultTemporalResolver();

const at = (expr: TemporalMention['expr'], now: Ms, tz: IanaTz) => {
  const mention: TemporalMention = { text: 'x', expr, role: 'reference_conversation' };
  const input = laneInput(analysis({ temporal: [mention] }), { now, tz }).input;
  return dayOf(input, resolver.resolve([mention], tz, now), 'reference_conversation');
};

describe('the one day a no-record sentence names', () => {
  it('is written for people: weekday, day and month, no ISO date', () => {
    expect(peopleDate('2026-11-09', THURSDAY, LONDON)).toBe('Monday 9 November');
    expect(peopleDate('2026-11-03', THURSDAY, LONDON)).toBe('Tuesday 3 November');
  });

  it('adds the year only when it is not the current one', () => {
    expect(peopleDate('2025-12-30', THURSDAY, LONDON)).toBe('Tuesday 30 December 2025');
  });

  it('is the most recent past Monday when "Monday" is said on a Thursday, with or without "last"', () => {
    expect(at({ kind: 'weekday', weekday: 1, modifier: 'last' }, THURSDAY, LONDON)).toBe(
      'Monday 9 November',
    );
    expect(at({ kind: 'weekday', weekday: 1, modifier: 'none' }, THURSDAY, LONDON)).toBe(
      'Monday 9 November',
    );
    expect(at({ kind: 'weekday', weekday: 2, modifier: 'last' }, THURSDAY, LONDON)).toBe(
      'Tuesday 10 November',
    );
  });

  it('is one of the candidates, never a list, and ignores a candidate that has not started', () => {
    const day = (localDate: string, startMs: Ms) => ({
      localDate,
      startMs,
      endMs: startMs + 86_400_000,
      tz: 'UTC',
    });
    const earlier = day('2026-11-02', Date.UTC(2026, 10, 2));
    const latest = day('2026-11-09', Date.UTC(2026, 10, 9));
    const future = day('2026-11-16', Date.UTC(2026, 10, 16));
    expect(mostRecentPastDay([earlier, latest, future], THURSDAY)).toBe(latest);
    expect(mostRecentPastDay([future], THURSDAY)).toBe(future);
  });

  it('follows the user zone across the daylight-saving change', () => {
    // Sunday 29 March 2026 23:30 UTC is Monday 30 March 00:30 in London (summer time began that Sunday).
    const night: Ms = Date.UTC(2026, 2, 29, 23, 30);
    expect(at({ kind: 'yesterday' }, night, LONDON)).toBe('Sunday 29 March');
    expect(at({ kind: 'yesterday' }, night, 'UTC')).toBe('Saturday 28 March');
    // and the week before the change: "last Sunday" said on Monday 30 March in London
    expect(at({ kind: 'weekday', weekday: 7, modifier: 'none' }, night, LONDON)).toBe(
      'Sunday 29 March',
    );
  });
});

describe('recall scope of the analysis', () => {
  const base = {
    laneHint: 'recall',
    intents: [],
    temporal: [],
    entities: [],
    references: [],
    topicTerms: [],
    asksStillCorrect: false,
    queries: [],
    alternateQueries: [],
    userFacts: [],
  };

  it('is optional: an output without it parses as before and carries no scope', () => {
    const parsed = toTurnAnalysis(analysisModelSchema.parse(base));
    expect('recallScope' in parsed).toBe(false);
  });

  it('keeps "conversation" and rejects any other value', () => {
    const parsed = toTurnAnalysis(
      analysisModelSchema.parse({ ...base, recallScope: 'conversation' }),
    );
    expect(parsed.recallScope).toBe('conversation');
    expect(analysisModelSchema.safeParse({ ...base, recallScope: 'everything' }).success).toBe(
      false,
    );
  });

  it('routes a recall of this conversation to the recall lane even when hinted as chat or clarify', () => {
    for (const laneHint of ['chat', 'clarify', 'recall'] as const) {
      expect(routeTurn(analysis({ laneHint, recallScope: 'conversation' })).lane).toBe('recall');
    }
    expect(routeTurn(analysis({ laneHint: 'chat' }))).toEqual({ lane: 'chat', reason: 'hint' });
  });
});
