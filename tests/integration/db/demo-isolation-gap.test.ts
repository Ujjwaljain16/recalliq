import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/shared/ids.js';
import { count, insertEntity, openTestDb, seedConversation, T0 } from '../../helpers/db.js';

/**
 * KNOWN GAP Q-002 (docs/questions.md, docs/proposals/q-002-demo-isolation.md).
 *
 * These tests assert what the shipped schema does TODAY, so the incomplete demo isolation is visible and
 * verifiable rather than only written down. They are not guarantees. Each is expected to start failing the
 * day the remediation migration lands; at that point replace it with the matching test in
 * demo-isolation-proposal.test.ts.
 */
describe('KNOWN GAP Q-002: a real database accepts non-live data in these cases', () => {
  it('a recorded message inside a live conversation', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    const { conversationId } = seedConversation(t, user);
    t.messages.insert({
      userId: user,
      conversationId,
      role: 'user',
      content: 'fixture text',
      tz: 'UTC',
      origin: 'recorded',
    });
    expect(count(t.db, 'messages', "origin = 'recorded'")).toBe(1);
  });

  it('a synthetic entity', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    const id = insertEntity(t.db, { userId: user, norm: 'acme crm' });
    t.db.prepare("UPDATE entities SET origin = 'synthetic' WHERE id = ?").run(id);
    expect(count(t.db, 'entities', "origin = 'synthetic'")).toBe(1);
  });

  it('a recorded decision', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    t.db
      .prepare(
        `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote, origin, created_at)
         VALUES (?, ?, ?, ?, 'shortlist', '{}', 'q', 'recorded', ?)`,
      )
      .run(newId('dec'), user, conversationId, userMessageId, T0);
    expect(count(t.db, 'decisions', "origin = 'recorded'")).toBe(1);
  });

  it('relabelling an existing user as a fixture (the user trigger fires on INSERT only)', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    t.db.prepare("UPDATE users SET kind = 'fixture' WHERE id = ?").run(user);
    expect(count(t.db, 'users', "kind = 'fixture'")).toBe(1);
  });

  it('relabelling an existing conversation as recorded (the conversation trigger fires on INSERT only)', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    t.db.prepare("UPDATE conversations SET origin = 'recorded' WHERE id = ?").run(conversation.id);
    expect(count(t.db, 'conversations', "origin = 'recorded'")).toBe(1);
  });

  it('changing or deleting meta.db_mode, which every isolation trigger reads', () => {
    const updated = openTestDb('real');
    updated.db.prepare("UPDATE meta SET value = 'demo' WHERE key = 'db_mode'").run();
    expect(() => updated.users.create('fixture')).not.toThrow();

    const deleted = openTestDb('real');
    deleted.db.prepare("DELETE FROM meta WHERE key = 'db_mode'").run();
    // with the row gone the triggers' comparison is NULL, so they pass everything
    expect(() => deleted.users.create('fixture')).not.toThrow();
  });
});
