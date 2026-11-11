import { afterEach, describe, expect, it } from 'vitest';
import { ask, dbContains, eventsOf, scalar, startE2e, type E2eApp } from './harness.js';
import { analysis, extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const Q = 'What does Acme CRM cost?';

const base = (synthesis: Parameters<typeof fixture>[0]['synthesis']) =>
  fixture({
    analysis: [researchOf(Q, ['Acme CRM'])],
    extraction: [extractionOf('Acme CRM', 90)],
    search: [priceSearch('Acme CRM', 90)],
    synthesis,
  });

describe('T-E2E failures are reported as what they are', () => {
  it('a model failure before any sentence is a failed turn with a fixed reply, not an answer', async () => {
    t = await startE2e({
      fixture: base([{ whenMessageContains: Q, deltas: [], failWith: 'unavailable' }]),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.status).toBe('failed');
    expect(turn.sentences.join(' ')).toContain('could not process that request');
    expect(turn.sentences.join(' ')).not.toContain('US$');
    // the research that did succeed is stored as findings, but nothing was claimed to the user
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(0);
    expect(scalar(t.app, "SELECT count(*) FROM turns WHERE status = 'complete'")).toBe(0);
  });

  it('a model failure mid-answer is an interrupted turn that keeps only the sentences it released', async () => {
    t = await startE2e({
      fixture: base([
        {
          whenMessageContains: Q,
          deltas: ['Acme CRM Pro is [[F1]].', ' Beta'],
          failWith: 'unavailable',
        },
      ]),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const turn = await ask(user, conv, Q);
    expect(turn.status).toBe('interrupted');
    expect(turn.sentences).toHaveLength(1);
    expect(turn.sentences.join(' ')).not.toContain('Beta');
    expect(eventsOf(turn, 'error').length).toBeGreaterThan(0);
    const stored = await user.json<{ messages: Array<{ role: string; status: string }> }>(
      'GET',
      `/api/conversations/${conv}/messages`,
    );
    expect(stored.body.messages.find((m) => m.role === 'assistant')?.status).toBe('interrupted');
    expect(dbContains(t.app, 'Beta')).toBe(false);
  });

  it('a search outage for the only entity is partial and says nothing was verified', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        search: [
          priceSearch('Acme CRM', 'unavailable', 'unavailable'),
          {
            query: 'Acme CRM pricing plans per user 2026',
            steps: [{ error: 'unavailable' }, { error: 'unavailable' }],
          },
        ],
        synthesis: [say(Q, 'Acme CRM: [[F1]].')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.status).toBe('partial');
    expect(turn.sentences.join(' ')).not.toContain('US$');
    expect(scalar(t.app, "SELECT count(*) FROM findings WHERE current_status = 'confirmed'")).toBe(
      0,
    );
    expect(scalar(t.app, 'SELECT count(*) FROM beliefs')).toBe(0);
  });

  it('a database failure while storing evidence propagates: the turn is never completed and no answer is sent', async () => {
    t = await startE2e({ fixture: base([say(Q, 'Acme CRM Pro is [[F1]].')]) });
    t.app.db.exec(
      "CREATE TRIGGER disk_failure BEFORE INSERT ON evidence_statements BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
    );
    const user = t.client();
    const conv = await user.newConversation();
    const res = await user.request('POST', `/api/conversations/${conv}/turns`, {
      text: Q,
      idempotencyKey: 'db-failure',
    });
    const raw = await res.text();
    expect(raw).toContain('event: error');
    expect(raw).toContain('internal_error');
    expect(raw).not.toContain('answer.delta');
    expect(raw).not.toContain('answer.completed');
    expect(raw).not.toContain('US$90');
    expect(scalar(t.app, "SELECT count(*) FROM turns WHERE status = 'complete'")).toBe(0);
    expect(scalar(t.app, "SELECT count(*) FROM messages WHERE role = 'assistant'")).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(0);
  });

  it('a refusal by the model is a failed turn with no claim stored', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [{ whenMessageContains: Q, reply: analysis({ laneHint: 'chat' }) }],
        synthesis: [{ whenMessageContains: Q, deltas: [], failWith: 'refused' }],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.status).toBe('failed');
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(0);
  });
});
