import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/shared/ids.js';
import {
  count,
  insertEntity,
  openTestDb,
  seedConversation,
  T0,
  type TestDb,
} from '../../helpers/db.js';

/**
 * PROPOSED Q-002 remediation, validated against a scratch database. NOT PART OF THE SHIPPED SCHEMA.
 *
 * The proposal SQL (docs/proposals/q-002-demo-isolation.sql) is applied on top of migration 001 inside the
 * test only. These tests are skipped unless RUN_PROPOSALS=1, so the default suite never reports them as
 * coverage of the real schema. Run: RUN_PROPOSALS=1 npx vitest run tests/integration/db/demo-isolation-proposal.test.ts
 */
const enabled = process.env['RUN_PROPOSALS'] === '1';

function withProposal(mode: 'real' | 'demo'): TestDb {
  const t = openTestDb(mode);
  t.db.exec(fs.readFileSync('docs/proposals/q-002-demo-isolation.sql', 'utf8'));
  return t;
}

function insertDecision(
  t: TestDb,
  p: { userId: string; conversationId: string; messageId: string; origin: string },
) {
  t.db
    .prepare(
      `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote, origin, created_at)
       VALUES (?, ?, ?, ?, 'shortlist', '{}', 'q', ?, ?)`,
    )
    .run(newId('dec'), p.userId, p.conversationId, p.messageId, p.origin, T0);
}

describe.skipIf(!enabled)(
  'PROPOSED Q-002 (not applied): real database with the proposal triggers',
  () => {
    it('rejects a non-live message, through the repository and through raw SQL', () => {
      const t = withProposal('real');
      const user = t.users.create();
      const { conversationId } = seedConversation(t, user);
      expect(() =>
        t.messages.insert({
          userId: user,
          conversationId,
          role: 'user',
          content: 'x',
          tz: 'UTC',
          origin: 'recorded',
        }),
      ).toThrow(/non-live message in real db/);
      expect(() =>
        t.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, tz, origin, created_at)
           VALUES (?, ?, ?, 50, 'user', 'x', 'UTC', 'synthetic', ?)`,
          )
          .run(newId('msg'), conversationId, user, T0),
      ).toThrow(/non-live message in real db/);
      expect(count(t.db, 'messages', "origin <> 'live'")).toBe(0);
    });

    it('rejects a non-live entity on insert and on relabel', () => {
      const t = withProposal('real');
      const user = t.users.create();
      expect(() =>
        t.db
          .prepare(
            "INSERT INTO entities (id, user_id, canonical, norm, origin, created_at) VALUES (?, ?, 'x', 'x', 'synthetic', ?)",
          )
          .run(newId('ent'), user, T0),
      ).toThrow(/non-live entity in real db/);
      const live = insertEntity(t.db, { userId: user, norm: 'acme crm' });
      expect(() =>
        t.db.prepare("UPDATE entities SET origin = 'recorded' WHERE id = ?").run(live),
      ).toThrow(/non-live entity in real db/);
      expect(count(t.db, 'entities', "origin <> 'live'")).toBe(0);
    });

    it('rejects a non-live decision on insert and on relabel', () => {
      const t = withProposal('real');
      const user = t.users.create();
      const { conversationId, userMessageId } = seedConversation(t, user);
      expect(() =>
        insertDecision(t, {
          userId: user,
          conversationId,
          messageId: userMessageId,
          origin: 'recorded',
        }),
      ).toThrow(/non-live decision in real db/);
      insertDecision(t, { userId: user, conversationId, messageId: userMessageId, origin: 'live' });
      expect(() => t.db.prepare("UPDATE decisions SET origin = 'synthetic'").run()).toThrow(
        /non-live decision in real db/,
      );
      expect(count(t.db, 'decisions', "origin <> 'live'")).toBe(0);
    });

    it('rejects relabelling an existing user or conversation', () => {
      const t = withProposal('real');
      const user = t.users.create();
      const conversation = t.conversations.create({ userId: user });
      expect(() =>
        t.db.prepare("UPDATE users SET kind = 'fixture' WHERE id = ?").run(user),
      ).toThrow(/fixture user in real db/);
      expect(() =>
        t.db
          .prepare("UPDATE conversations SET origin = 'recorded' WHERE id = ?")
          .run(conversation.id),
      ).toThrow(/non-live conversation in real db/);
    });

    it('makes db_mode immutable, so the triggers cannot be switched off', () => {
      const t = withProposal('real');
      expect(() =>
        t.db.prepare("UPDATE meta SET value = 'demo' WHERE key = 'db_mode'").run(),
      ).toThrow(/db_mode is immutable/);
      expect(() => t.db.prepare("DELETE FROM meta WHERE key = 'db_mode'").run()).toThrow(
        /db_mode is immutable/,
      );
      expect(() => t.users.create('fixture')).toThrow(/fixture user in real db/);
    });

    it('still accepts live data, and still allows schema_version to be updated', () => {
      const t = withProposal('real');
      const user = t.users.create();
      const { conversationId, userMessageId } = seedConversation(t, user);
      insertEntity(t.db, { userId: user, norm: 'hubspot' });
      insertDecision(t, { userId: user, conversationId, messageId: userMessageId, origin: 'live' });
      expect(() =>
        t.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run(),
      ).not.toThrow();
    });
  },
);

describe.skipIf(!enabled)(
  'PROPOSED Q-002 (not applied): demo database with the proposal triggers',
  () => {
    it('accepts non-live messages, entities and decisions', () => {
      const t = withProposal('demo');
      const user = t.users.create('fixture');
      const conversation = t.conversations.create({ userId: user, origin: 'recorded' });
      const message = t.messages.insert({
        userId: user,
        conversationId: conversation.id,
        role: 'user',
        content: 'x',
        tz: 'UTC',
        origin: 'recorded',
      });
      t.db
        .prepare(
          "INSERT INTO entities (id, user_id, canonical, norm, origin, created_at) VALUES (?, ?, 'x', 'x', 'synthetic', ?)",
        )
        .run(newId('ent'), user, T0);
      insertDecision(t, {
        userId: user,
        conversationId: conversation.id,
        messageId: message.id,
        origin: 'recorded',
      });
      expect(count(t.db, 'messages', "origin = 'recorded'")).toBe(1);
      expect(count(t.db, 'entities', "origin = 'synthetic'")).toBe(1);
      expect(count(t.db, 'decisions', "origin = 'recorded'")).toBe(1);
    });
  },
);
