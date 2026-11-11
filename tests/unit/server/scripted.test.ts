import { describe, expect, it } from 'vitest';
import {
  formatLocalTime,
  renderCurrent,
  renderMessageQuote,
  renderVerdict,
  ScriptedAnswer,
} from '../../../src/app/scripted/answer.js';
import { scriptedAnalysis } from '../../../src/app/scripted/analyzer.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { newId } from '../../../src/shared/ids.js';
import type { Finding } from '../../../src/shared/findings.js';
import { buildFinding } from '../../helpers/turns.js';
import type { TurnBudget } from '../../../src/shared/infrastructure.js';

describe('scripted analyzer', () => {
  it('routes the demonstrable cases', () => {
    expect(scriptedAnalysis('Hello there').laneHint).toBe('chat');
    expect(scriptedAnalysis('What does HubSpot cost?')).toMatchObject({
      laneHint: 'research',
      entities: [{ text: 'HubSpot', normalized: 'hubspot' }],
    });
    expect(scriptedAnalysis('What did I ask yesterday about HubSpot?')).toMatchObject({
      laneHint: 'recall',
      temporal: [{ expr: { kind: 'yesterday' }, role: 'reference_conversation' }],
      topicTerms: ['hubspot'],
    });
    expect(scriptedAnalysis('compare them').laneHint).toBe('clarify');
    expect(scriptedAnalysis('2026-11-10').temporal[0]?.expr).toEqual({
      kind: 'calendar_date',
      year: 2026,
      month: 11,
      day: 10,
    });
  });

  it('does not take a sentence-initial word for a company, and is deterministic', () => {
    expect(
      scriptedAnalysis('What does Acme cost? Add a note.').entities.map((e) => e.text),
    ).toEqual(['Acme']);
    expect(scriptedAnalysis('What does Acme cost?')).toEqual(
      scriptedAnalysis('What does Acme cost?'),
    );
  });

  it('marks a simulated outage only when asked', () => {
    expect(
      scriptedAnalysis('What does Acme cost? Search is offline.').alternateQueries,
    ).toHaveLength(1);
    expect(scriptedAnalysis('What does Acme cost?').alternateQueries).toEqual([]);
  });
});

describe('scripted rendering follows the rendering contract', () => {
  it('renders a current price, a verdict, and a message quote in the documented forms', () => {
    const f = buildFinding(newId('ent'), 1);
    expect(renderCurrent(f, 1)).toBe('US$90 per user per month [1]');
    const unable: Finding = {
      ...f,
      currentStatus: 'unable_to_verify',
      verdict: 'unable_to_verify',
      verdictReason: 'search_unavailable',
    };
    expect(renderVerdict(unable)).toBe("couldn't be checked this time (search unavailable)");
    expect(formatLocalTime('2026-11-03 14:05')).toBe('Tue 3 Nov, 14:05');
    expect(renderMessageQuote('hi', '2026-11-03 14:05')).toBe('"hi" (Tue 3 Nov, 14:05)');
  });
});

describe('scripted answer pipeline', () => {
  const budget = {} as TurnBudget;
  const ctx = (lane: 'chat' | 'research') => ({
    lane,
    temporal: [],
    memoryHits: [],
    decisions: [],
    entities: [],
    baselines: [],
  });

  async function run(userMessage: string) {
    const events: SseEvent[] = [];
    const result = await new ScriptedAnswer().run(
      { findings: null, recall: new Map(), ctx: ctx('chat'), userMessage, window: [] },
      budget,
      (e) => events.push(e),
    );
    return { events, result };
  }

  it('releases each sentence whole: one delta with the full text, then its sentence_end', async () => {
    const { events, result } = await run('Hello');
    expect(result.sentences.length).toBeGreaterThanOrEqual(2);
    const names = events.map((e) => e.event);
    expect(names).toEqual(result.sentences.flatMap(() => ['answer.delta', 'answer.sentence_end']));
    events.forEach((e, i) => {
      if (e.event !== 'answer.delta') return;
      const s = result.sentences[i / 2]!;
      expect(e.data).toEqual({ sentenceIndex: s.index, text: s.text });
    });
    expect(result.streamedThrough).toBe(result.sentences.length - 1);
    expect(result.rendered).toBe(result.sentences.map((s) => s.text).join(' '));
  });
});
