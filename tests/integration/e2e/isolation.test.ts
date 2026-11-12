import { afterEach, describe, expect, it } from 'vitest';
import { acknowledge, ask, DAY, scalar, startE2e, TUE, type E2eApp } from './harness.js';
import {
  analysis,
  mention,
  extractionOf,
  fixture,
  priceSearch,
  researchOf,
  say,
} from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const Q = 'What does Acme CRM cost?';
const AUDIT = 'Is the Acme CRM price you gave me still correct?';
const RECALL = 'What did we talk about last Tuesday?';

const scenario = (acmePrices: number[]) =>
  fixture({
    analysis: [
      researchOf(Q, ['Acme CRM']),
      {
        whenMessageContains: AUDIT,
        // a mention with a domain guess: a user with no stored entity needs it to find the official site
        reply: analysis({
          laneHint: 'audit',
          intents: ['pricing'],
          entities: [mention('Acme CRM')],
          asksStillCorrect: true,
        }),
      },
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
    extraction: [...new Set(acmePrices)].map((p) => extractionOf('Acme CRM', p)),
    search: [priceSearch('Acme CRM', ...acmePrices)],
    synthesis: [
      say(Q, 'Acme CRM Pro is [[F1]].'),
      say(AUDIT, 'Acme CRM: [[F1]].'),
      say(RECALL, 'You wrote this: [[M:{{M1}}]].'),
    ],
  });

const count = (app: E2eApp, table: string, user: string): number =>
  scalar(app.app, `SELECT count(*) FROM ${table} WHERE user_id = ?`, user);

describe('T-E2E users are isolated across the whole path', () => {
  it('one user cannot read, acknowledge, audit, recall or delete the data of another', async () => {
    t = await startE2e({ fixture: scenario([90, 90, 90]) });
    const alice = t.client();
    const bob = t.client();
    const aliceConv = await alice.newConversation();
    const aliceTurn = await ask(alice, aliceConv, Q);
    await acknowledge(alice, aliceTurn);
    const aliceUser = scalar<string>(t.app, 'SELECT id FROM users LIMIT 1');
    const evidenceBefore = count(t, 'evidence_statements', aliceUser);
    const presentedBefore = scalar(
      t.app,
      'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL',
    );
    expect(evidenceBefore).toBeGreaterThan(0);

    const bobConv = await bob.newConversation();
    // retrieve, post into, acknowledge and delete: all indistinguishable from "not found"
    expect((await bob.json('GET', `/api/conversations/${aliceConv}/messages`)).status).toBe(404);
    const post = await bob.json('POST', `/api/conversations/${aliceConv}/turns`, {
      text: 'hello',
      idempotencyKey: 'bob-1',
    });
    expect(post.status).toBe(404);
    const ack = await bob.json('POST', `/api/turns/${aliceTurn.turnId}/ack`, {
      renderedThrough: 0,
      complete: true,
    });
    expect(ack.status).toBe(404);
    expect((await bob.json('DELETE', `/api/conversations/${aliceConv}`)).status).toBe(404);
    const list = await bob.json<{ conversations: Array<{ id: string }> }>(
      'GET',
      '/api/conversations',
    );
    expect(list.body.conversations.map((c) => c.id)).toEqual([bobConv]);

    // audit and recall see only the caller's own history: Bob has none
    t.clock.set(TUE + 8 * DAY);
    // Bob has no earlier answer of his own: the audit researches and says so, and never shows Alice's price.
    const audit = await ask(bob, bobConv, AUDIT);
    expect(audit.sentences.join(' ')).toContain('no earlier answer of my own on record');
    expect(
      (audit.read.events.filter((e) => e.event === 'finding') as Array<{ data: object }>).every(
        (e) => !('baseline' in e.data),
      ),
    ).toBe(true);
    const recall = await ask(bob, bobConv, RECALL);
    expect(recall.sentences.join(' ')).toContain('no record of a conversation');

    // Bob's own research stores Bob's rows only and leaves Alice's untouched
    const bobResearch = await ask(bob, bobConv, Q);
    expect(bobResearch.status).toBe('complete');
    const bobUser = scalar<string>(t.app, 'SELECT id FROM users WHERE id <> ?', aliceUser);
    expect(count(t, 'evidence_statements', aliceUser)).toBe(evidenceBefore);
    expect(count(t, 'evidence_statements', bobUser)).toBeGreaterThan(0);
    expect(count(t, 'entities', bobUser)).toBe(1);
    expect(count(t, 'beliefs', bobUser)).toBe(1);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(
      presentedBefore,
    );
    expect(
      scalar(
        t.app,
        'SELECT count(*) FROM assertions WHERE user_id = ? AND presented_at IS NOT NULL',
        bobUser,
      ),
    ).toBe(0);
  });
});

describe('T-E2E privacy deletion', () => {
  it('removes the conversation, its evidence and beliefs, keeps the other conversation, and leaves nothing recallable', async () => {
    // conversation 1 sees US$90, conversation 2 (8 days later) sees US$100 for the same key
    t = await startE2e({ fixture: scenario([90, 100]) });
    const user = t.client();
    const one = await user.newConversation();
    await acknowledge(user, await ask(user, one, Q));
    t.clock.advance(8 * DAY);
    const two = await user.newConversation();
    await acknowledge(user, await ask(user, two, Q));
    expect(scalar(t.app, 'SELECT count(*) FROM evidence_statements')).toBe(2);
    expect(scalar(t.app, 'SELECT count(*) FROM beliefs')).toBe(1);

    const del = await user.request('DELETE', `/api/conversations/${one}`);
    expect(del.status).toBe(204);

    // everything of conversation 1 is gone
    expect(scalar(t.app, 'SELECT count(*) FROM conversations WHERE id = ?', one)).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM turns WHERE conversation_id = ?', one)).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM messages WHERE conversation_id = ?', one)).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(1);
    expect(scalar(t.app, 'SELECT count(*) FROM findings')).toBe(1);
    // its evidence and snapshot are gone; the other conversation's survive
    expect(scalar(t.app, 'SELECT count(*) FROM evidence_statements')).toBe(1);
    expect(scalar(t.app, 'SELECT count(*) FROM source_snapshots')).toBe(1);
    expect(
      scalar(
        t.app,
        'SELECT count(*) FROM evidence_statements WHERE payload_json LIKE \'%"amount":90%\'',
      ),
    ).toBe(0);
    // the belief was rebuilt from what survives: US$100, and its history never mentions US$90
    const belief = t.app.db.prepare('SELECT status, value_json FROM beliefs').get() as {
      status: string;
      value_json: string;
    };
    expect(belief.status).toBe('confirmed');
    expect((JSON.parse(belief.value_json) as { amount: number }).amount).toBe(100);
    expect(
      scalar(
        t.app,
        'SELECT count(*) FROM belief_history WHERE prev_json LIKE \'%"amount":90%\' OR next_json LIKE \'%"amount":90%\'',
      ),
    ).toBe(0);

    // nothing stale is recallable from the deleted conversation
    t.clock.set(TUE + 9 * DAY);
    const recall = await ask(user, await user.newConversation(), RECALL);
    expect(recall.sentences.join(' ')).not.toContain('Acme CRM cost');
  });

  it('after deleting the only conversation, recall and audit find no record and nothing remains', async () => {
    t = await startE2e({ fixture: scenario([90, 90]) });
    const user = t.client();
    const conv = await user.newConversation();
    await acknowledge(user, await ask(user, conv, Q));
    expect((await user.request('DELETE', `/api/conversations/${conv}`)).status).toBe(204);
    for (const table of [
      'messages',
      'assertions',
      'findings',
      'evidence_statements',
      'source_snapshots',
      'beliefs',
      'belief_history',
      'entities',
      'search_requests',
    ]) {
      expect(scalar(t.app, `SELECT count(*) FROM ${table}`), table).toBe(0);
    }

    t.clock.set(TUE + 9 * DAY);
    const next = await user.newConversation();
    const recall = await ask(user, next, RECALL);
    expect(recall.sentences.join(' ')).toContain('no record of a conversation');
    const audit = await ask(user, next, AUDIT);
    expect(audit.sentences.join(' ')).toContain('no earlier answer of my own on record');
    expect(
      (audit.read.events.filter((e) => e.event === 'finding') as Array<{ data: object }>).every(
        (e) => !('baseline' in e.data),
      ),
    ).toBe(true);
  });
});
