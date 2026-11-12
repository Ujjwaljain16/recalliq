import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { LlmError } from '../../../src/shared/llm.js';
import { validateCompletion } from '../../../src/db/repositories/turn-completion.js';
import type { MessageId, TurnId } from '../../../src/shared/ids.js';
import type { TurnCompletion } from '../../../src/shared/repositories.js';
import { FakeBudget } from '../../helpers/budget.js';
import { buildCompletion } from '../../helpers/turns.js';
import { context, finding, findingSet, sink } from '../../unit/answer/builders.js';

/** The pipeline's output must be accepted by the persistence layer's own consistency check. */
describe('answer pipeline output is accepted by the completion check', () => {
  async function complete(
    deltas: string[],
    fail?: LlmError,
  ): Promise<{ c: TurnCompletion; turnId: TurnId }> {
    const f = finding(1);
    const set = findingSet([f]);
    const llm = new FakeLlm().queueStream({ deltas, failWith: fail });
    const r = await new LlmAnswerPipeline({ llm }).run(
      {
        findings: set,
        recall: new Map<MessageId, { text: string; localTime: string }>(),
        ctx: context(),
        userMessage: 'What does it cost?',
        window: [],
        tz: 'Europe/London',
      },
      new FakeBudget(60_000),
      sink().emit,
    );
    const turnId = set.turnId;
    const base = buildCompletion({
      turnId,
      userId: 'usr_1',
      entityId: 'ent_1',
      sentences: 1,
      claimsAt: [],
      streamedThrough: -1,
    });
    const assertions = r.sentences.flatMap((s) =>
      s.placeholders.flatMap((p) => {
        const m = /^\[\[(F\d+(?::baseline|:verdict|:derived:\d+)?)\]\]$/.exec(p.token);
        return m?.[1] && p.findingId
          ? [
              {
                findingId: p.findingId,
                sentenceIndex: s.index,
                placeholder: m[1],
                beliefKey: f.beliefKey,
                renderedText: p.rendered,
                value: f.current?.value ?? null,
                evidenceIds: [],
              },
            ]
          : [];
      }),
    );
    return {
      turnId,
      c: {
        ...base,
        status: r.interrupted ? 'interrupted' : 'complete',
        findings: set,
        assertions,
        assistant: {
          rendered: r.rendered,
          template: r.template,
          sentences: r.sentences,
          streamedThrough: r.streamedThrough,
          messageStatus: r.interrupted ? 'interrupted' : 'complete',
        },
      },
    };
  }

  it('a complete answer with claims', async () => {
    const { c, turnId } = await complete(['ExampleCo1 costs [[F1]]. Thanks.']);
    expect(c.assertions).toHaveLength(1);
    expect(() => validateCompletion(turnId, c)).not.toThrow();
  });

  it('an interrupted answer containing only its released sentences', async () => {
    const { c, turnId } = await complete(
      ['Fine. It costs [[F1]] and', ' more'],
      new LlmError('timeout', 't'),
    );
    expect(c.assistant?.sentences.map((s) => s.status)).toEqual(['no_claims']);
    expect(c.assistant?.streamedThrough).toBe(0);
    expect(() => validateCompletion(turnId, c)).not.toThrow();
  });
});
