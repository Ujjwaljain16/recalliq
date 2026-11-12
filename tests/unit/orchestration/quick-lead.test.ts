import { describe, expect, it } from 'vitest';
import { QuickSection } from '../../../src/orchestration/quick.js';
import type { AnswerPipeline, AnswerResult } from '../../../src/shared/answer.js';
import type { TurnId } from '../../../src/shared/ids.js';
import type { SseEvent } from '../../../src/shared/sse.js';

const quickResult: AnswerResult = {
  sentences: [
    {
      index: 0,
      text: 'Here is a preface.',
      template: 'p',
      status: 'no_claims',
      issues: [],
      placeholders: [],
    },
    {
      index: 1,
      text: ' It costs US$90.',
      template: 'q',
      status: 'no_claims',
      issues: [],
      placeholders: [],
    },
  ],
  streamedThrough: 1,
  interrupted: false,
  template: 'p q',
  rendered: 'Here is a preface. It costs US$90.',
};

function section(result: AnswerResult | null): { q: QuickSection; events: SseEvent[] } {
  const events: SseEvent[] = [];
  const answer = {
    quick: async (_i: unknown, _b: unknown, emit: (e: SseEvent) => void) => {
      await Promise.resolve();
      if (result) {
        for (const s of result.sentences) {
          emit({ event: 'answer.delta', data: { sentenceIndex: s.index, text: s.text } });
          emit({
            event: 'answer.sentence_end',
            data: { index: s.index, status: s.status, issues: [] },
          });
        }
      }
      return (
        result ?? {
          sentences: [],
          streamedThrough: -1,
          interrupted: false,
          template: '',
          rendered: '',
        }
      );
    },
  } as unknown as AnswerPipeline;
  const q = new QuickSection({
    answer,
    budget: {} as never,
    emit: (e) => events.push(e),
    turnId: 't' as TurnId,
    now: 0,
    userMessage: 'm',
    tz: 'UTC',
  });
  return { q, events };
}

const ready = (lead?: string[]) => ({ ctx: {}, sources: {}, ...(lead ? { lead } : {}) }) as never;

describe('quick section with sentences written in code', () => {
  it('releases the opening sentences first and numbers the quick sentences after them', async () => {
    const { q, events } = section(quickResult);
    q.start(ready(['You asked about CRMs.', 'I took the companies: A.']));
    const result = await q.finish();
    const deltas = events.filter((e) => e.event === 'answer.delta') as Array<{
      data: { sentenceIndex: number; text: string };
    }>;
    expect(deltas.map((d) => d.data.sentenceIndex)).toEqual([0, 1, 2, 3]);
    expect(deltas[0]?.data.text).toBe('You asked about CRMs.');
    expect(deltas[2]?.data.text).toBe(' Here is a preface.');
    expect(q.leadCount).toBe(2);
    expect(result?.sentences.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(result?.streamedThrough).toBe(3);
  });

  it('keeps the opening sentences when the quick section released nothing', async () => {
    const { q } = section(null);
    q.start(ready(['You asked about CRMs.']));
    const result = await q.finish();
    expect(result?.sentences).toHaveLength(1);
    expect(q.leadCount).toBe(1);
  });

  it('is unchanged without opening sentences', async () => {
    const { q, events } = section(quickResult);
    q.start(ready());
    const result = await q.finish();
    expect(q.leadCount).toBe(0);
    expect(result?.sentences.map((s) => s.index)).toEqual([0, 1]);
    expect(events.filter((e) => e.event === 'answer.delta')).toHaveLength(2);
  });
});
