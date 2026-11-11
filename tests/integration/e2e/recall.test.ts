import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../../src/temporal/clock.js';
import { ask, DAY, eventsOf, startE2e, TUE, type E2eApp } from './harness.js';
import { analysis, fixture, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const NOTE_A = 'Our CRM shortlist is still open on Tuesday';
const NOTE_B = 'The CRM shortlist needs a decision';
const RECALL = 'What did we talk about last Tuesday?';

const scenario = () =>
  fixture({
    analysis: [
      { whenMessageContains: NOTE_A, reply: analysis({ laneHint: 'chat' }) },
      { whenMessageContains: NOTE_B, reply: analysis({ laneHint: 'chat' }) },
      {
        whenMessageContains: RECALL,
        reply: analysis({
          laneHint: 'recall',
          temporal: [
            {
              text: 'last Tuesday',
              expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
              role: 'reference_conversation',
            },
          ],
        }),
      },
    ],
    synthesis: [
      say(NOTE_A, 'Noted.'),
      say(NOTE_B, 'Noted.'),
      say(RECALL, 'You wrote this: [[M:{{M1}}]].'),
    ],
  });

// "last Tuesday", asked on Thursday 2026-11-12, is 2026-11-10 or 2026-11-03.
const THURSDAY = TUE + 9 * DAY;

describe('T-E2E relative weekday recall', () => {
  it('clarifies when both candidate Tuesdays have a conversation', async () => {
    t = await startE2e({ fixture: scenario(), clock: new FixedClock(TUE) });
    const user = t.client();
    await ask(user, await user.newConversation(), NOTE_A);
    t.clock.set(TUE + 7 * DAY);
    await ask(user, await user.newConversation(), NOTE_B);

    t.clock.set(THURSDAY);
    const turn = await ask(user, await user.newConversation(), RECALL);
    expect(turn.status).toBe('clarify');
    const clarification = eventsOf(turn, 'clarification')[0] as {
      options: Array<{ label: string; ref: string }>;
    };
    expect(clarification.options.map((o) => o.ref)).toEqual(['day:2026-11-10', 'day:2026-11-03']);
    expect(turn.names).not.toContain('source');
    expect(turn.sentences.join(' ')).not.toContain('You wrote');
  });

  it('answers from the stored message when only one candidate Tuesday has a conversation', async () => {
    t = await startE2e({ fixture: scenario(), clock: new FixedClock(TUE) });
    const user = t.client();
    await ask(user, await user.newConversation(), NOTE_A);

    t.clock.set(THURSDAY);
    const turn = await ask(user, await user.newConversation(), RECALL);
    expect(turn.status).toBe('complete');
    const text = turn.sentences.join(' ');
    // the model quoted nothing itself: code rendered the stored message with its local time
    expect(text).toContain(NOTE_A);
    expect(text).toContain('Tuesday 3 Nov, 10:00');
  });
});
