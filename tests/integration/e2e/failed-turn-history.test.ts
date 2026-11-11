import { afterEach, describe, expect, it } from 'vitest';
import { BaselineLoader } from '../../../src/db/index.js';
import { acknowledge, ask, eventsOf, scalar, startE2e, type E2eApp } from './harness.js';
import { extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const Q = 'What does Acme CRM cost?';
const NOT_IN_FIXTURE = 'Tell me about quantum gardening';
const AGAIN = 'What does Acme CRM cost, once more?';

/**
 * A later unexpected failure must not disturb what the user was already told: sentences released and
 * acknowledged in an earlier turn stay presented, and the failed turn adds nothing that looks like an answer.
 */
describe('T-E2E a later failure leaves earlier presented sentences intact', () => {
  it('two released and acknowledged sentences stay presented; the failed turn creates no answer, finding, assertion or baseline; the next turn works', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM']), researchOf(AGAIN, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90, 90)],
        synthesis: [
          say(Q, 'Acme CRM Pro is [[F1]].', ' The page was written for a team plan.'),
          say(AGAIN, 'Acme CRM Pro is [[F1]].'),
        ],
      }),
    });
    const app = t.app;
    const user = t.client();
    const conv = await user.newConversation();

    // Turn 1: two validated sentences are released, then acknowledged by the browser.
    const first = await ask(user, conv, Q);
    expect(first.status).toBe('complete');
    expect(first.sentences).toHaveLength(2);
    const ack = await acknowledge(user, first);
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ renderedThrough: 1, newlyPresented: 1 });
    const presentedBefore = scalar<number>(
      app,
      'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL',
    );
    expect(presentedBefore).toBe(1);

    // Turn 2: an unexpected failure (nothing recorded for this message, so the replay provider misses).
    const failed = await ask(user, conv, NOT_IN_FIXTURE);
    expect(eventsOf(failed, 'error')).toEqual([
      expect.objectContaining({ code: 'replay_miss', recoverable: false }),
    ]);
    expect(failed.names).not.toContain('turn.completed');
    expect(failed.names).not.toContain('answer.delta');
    expect(failed.completed).toBeNull();

    // The failed turn is terminal and left nothing that looks like an answer.
    const row = {
      state: scalar<string>(app, 'SELECT state FROM turns WHERE id = ?', failed.turnId),
      status: scalar<string>(app, 'SELECT status FROM turns WHERE id = ?', failed.turnId),
      code: scalar<string>(app, 'SELECT error_code FROM turns WHERE id = ?', failed.turnId),
    };
    expect(row).toEqual({ state: 'COMPLETED', status: 'failed', code: 'replay_miss' });
    expect(
      scalar(
        app,
        'SELECT count(*) FROM messages WHERE turn_id = ? AND role = ?',
        failed.turnId,
        'assistant',
      ),
    ).toBe(0);
    expect(scalar(app, 'SELECT count(*) FROM findings WHERE turn_id = ?', failed.turnId)).toBe(0);
    expect(scalar(app, 'SELECT count(*) FROM assertions WHERE turn_id = ?', failed.turnId)).toBe(0);
    expect(
      scalar(app, 'SELECT count(*) FROM assertion_events WHERE turn_id = ?', failed.turnId),
    ).toBe(0);
    expect(scalar(app, "SELECT count(*) FROM turns WHERE status = 'complete'")).toBe(1);

    // Nothing can be acknowledged for it: there is no stored answer.
    const refused = await user.json('POST', `/api/turns/${failed.turnId}/ack`, {
      renderedThrough: 0,
      complete: true,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // What the user was told in turn 1 is unchanged and still a baseline for a later audit.
    expect(
      scalar<number>(app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL'),
    ).toBe(presentedBefore);
    expect(
      scalar<number>(
        app,
        'SELECT rendered_through FROM messages WHERE turn_id = ? AND role = ?',
        first.turnId,
        'assistant',
      ),
    ).toBe(1);
    const userId = scalar<string>(app, 'SELECT user_id FROM turns WHERE id = ?', first.turnId);
    const baselines = new BaselineLoader(app.db).loadBaselines(
      userId as never,
      failed.turnId as never,
    );
    expect(baselines).toHaveLength(1);

    // The conversation is still usable: the next turn is accepted and completes.
    const next = await ask(user, conv, AGAIN);
    expect(next.status).toBe('complete');
    expect(next.sentences.join(' ')).toContain('US$90');
  });
});
