import { describe, expect, it } from 'vitest';
import { deleteConversation, NotFoundError, type BeliefRebuilder } from '../../../src/db/index.js';
import type { UserId } from '../../../src/shared/ids.js';
import {
  count,
  insertAssertion,
  insertAssertionEvent,
  insertAssistantMessage,
  insertEntity,
  insertEvidence,
  insertFinding,
  insertMessageSearch,
  insertSnapshot,
  openTestDb,
  seedConversation,
  type TestDb,
} from '../../helpers/db.js';

class RecordingRebuilder implements BeliefRebuilder {
  calls: Array<{ userId: UserId; keys: string[]; inTransaction: boolean }> = [];
  constructor(private readonly t: TestDb) {}
  rebuild(userId: UserId, keys: readonly string[]): void {
    this.calls.push({ userId, keys: [...keys].sort(), inTransaction: this.t.db.inTransaction });
  }
}

/**
 * Conversation A (to be deleted) and conversation B (kept), both Alice's, plus Bob's unrelated data.
 *
 *   A's turn produced three pieces of evidence:
 *     evOnly    – cited by nothing outside A                -> must be deleted
 *     evShared  – cited by an assertion in conversation B   -> must survive
 *     evSecond  – another A-only piece on the shared snapshot
 *   snapshots: snOnly (evOnly), snShared (evShared + evSecond), snOrphan (nothing references it)
 *   entities:  hubspot (evidence survives), zoho (nothing left), notion (tagged in B),
 *              pipedrive (in a decision in B)
 */
function world() {
  const t = openTestDb();
  const alice = t.users.create();
  const bob = t.users.create();

  const a = seedConversation(t, alice, { text: 'Compare HubSpot and Zoho pricing' });
  const b = seedConversation(t, alice, { text: 'Anything on Notion lately?' });
  const bobs = seedConversation(t, bob, { text: 'Bob private question about HubSpot' });

  const hubspot = insertEntity(t.db, { userId: alice, norm: 'hubspot' });
  const zoho = insertEntity(t.db, { userId: alice, norm: 'zoho' });
  const notion = insertEntity(t.db, { userId: alice, norm: 'notion' });
  const pipedrive = insertEntity(t.db, { userId: alice, norm: 'pipedrive' });
  const bobHubspot = insertEntity(t.db, { userId: bob, norm: 'hubspot' });
  // Unreferenced on purpose: only the per-user scoping of the cleanup steps protects these.
  const bobOrphanEntity = insertEntity(t.db, { userId: bob, norm: 'unreferenced' });
  const bobOrphanSnapshot = insertSnapshot(t.db, { userId: bob });

  const snOnly = insertSnapshot(t.db, { userId: alice });
  const snShared = insertSnapshot(t.db, { userId: alice });
  const snOrphan = insertSnapshot(t.db, { userId: alice });

  const evOnly = insertEvidence(t.db, {
    userId: alice,
    snapshotId: snOnly,
    turnId: a.turnId,
    entityId: zoho,
    beliefKey: 'key-zoho',
  });
  const evShared = insertEvidence(t.db, {
    userId: alice,
    snapshotId: snShared,
    turnId: a.turnId,
    entityId: hubspot,
    beliefKey: 'key-hubspot',
  });
  const evSecond = insertEvidence(t.db, {
    userId: alice,
    snapshotId: snShared,
    turnId: a.turnId,
    entityId: hubspot,
    beliefKey: 'key-hubspot-2',
  });

  // A's own assertion cites evOnly and evShared; B's assertion also cites evShared.
  // (assertions belong to an assistant message of their own turn: migration 005)
  const answerA = insertAssistantMessage(t, {
    userId: alice,
    conversationId: a.conversationId,
    turnId: a.turnId,
  });
  const answerB = insertAssistantMessage(t, {
    userId: alice,
    conversationId: b.conversationId,
    turnId: b.turnId,
  });
  const findingA = insertFinding(t.db, { turnId: a.turnId, entityId: hubspot });
  const assertionA = insertAssertion(t.db, {
    userId: alice,
    messageId: answerA,
    turnId: a.turnId,
    findingId: findingA,
    evidenceIds: [evOnly, evShared],
  });
  // A's claim was acknowledged by the browser, so it is presented and carries a presented event
  t.db.prepare('UPDATE messages SET rendered_through = 0 WHERE id = ?').run(answerA);
  t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(1, assertionA);
  insertAssertionEvent(t.db, { assertionId: assertionA, status: 'presented' });
  const findingB = insertFinding(t.db, { turnId: b.turnId, entityId: hubspot });
  const assertionB = insertAssertion(t.db, {
    userId: alice,
    messageId: answerB,
    turnId: b.turnId,
    findingId: findingB,
    evidenceIds: [evShared],
  });

  insertMessageSearch(t.db, {
    messageId: a.userMessageId,
    userId: alice,
    body: 'Compare HubSpot and Zoho pricing',
    tags: 'hubspot zoho',
  });
  insertMessageSearch(t.db, {
    messageId: b.userMessageId,
    userId: alice,
    body: 'Anything on Notion lately',
    tags: 'notion',
  });
  insertMessageSearch(t.db, {
    messageId: bobs.userMessageId,
    userId: bob,
    body: 'Bob private question about HubSpot',
    tags: 'hubspot',
  });

  t.db
    .prepare(
      `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote, created_at)
       VALUES ('dec_1', ?, ?, ?, 'shortlist', '{}', 'Anything on Notion', 1)`,
    )
    .run(alice, b.conversationId, b.userMessageId);
  t.db
    .prepare('INSERT INTO decision_entities (decision_id, entity_id) VALUES (?, ?)')
    .run('dec_1', pipedrive);

  return {
    t,
    alice,
    bob,
    a,
    b,
    bobs,
    entities: { hubspot, zoho, notion, pipedrive, bobHubspot, bobOrphanEntity },
    snapshots: { snOnly, snShared, snOrphan, bobOrphanSnapshot },
    evidence: { evOnly, evShared, evSecond },
    assertionB,
  };
}

const exists = (t: TestDb, table: string, id: string) => count(t.db, table, 'id = ?', id) === 1;

describe('deleteConversation', () => {
  it('removes the conversation and everything that hangs off it', () => {
    const w = world();
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );

    expect(exists(w.t, 'conversations', w.a.conversationId)).toBe(false);
    expect(count(w.t.db, 'messages', 'conversation_id = ?', w.a.conversationId)).toBe(0);
    expect(count(w.t.db, 'turns', 'id = ?', w.a.turnId)).toBe(0);
    expect(count(w.t.db, 'findings', 'turn_id = ?', w.a.turnId)).toBe(0);
    expect(count(w.t.db, 'assertions', 'turn_id = ?', w.a.turnId)).toBe(0);
    expect(count(w.t.db, 'assertion_events')).toBe(0);
  });

  it('T-DB-08: keeps evidence an assertion in another conversation still cites, and what it needs', () => {
    const w = world();
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );

    expect(exists(w.t, 'evidence_statements', w.evidence.evOnly)).toBe(false);
    expect(exists(w.t, 'evidence_statements', w.evidence.evShared)).toBe(true);
    // evSecond is A-only (nothing outside A cites it) even though it shares a snapshot
    expect(exists(w.t, 'evidence_statements', w.evidence.evSecond)).toBe(false);

    // B's assertion still has its evidence link, so the baseline it supports is still explainable
    expect(count(w.t.db, 'assertion_evidence', 'assertion_id = ?', w.assertionB)).toBe(1);
  });

  it('garbage-collects snapshots nothing references, and keeps those that are still cited', () => {
    const w = world();
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );
    expect(exists(w.t, 'source_snapshots', w.snapshots.snOnly)).toBe(false);
    expect(exists(w.t, 'source_snapshots', w.snapshots.snOrphan)).toBe(false);
    expect(exists(w.t, 'source_snapshots', w.snapshots.snShared)).toBe(true);
  });

  it('garbage-collects entities with no evidence, decision or tag mention, and keeps the rest', () => {
    const w = world();
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );
    expect(exists(w.t, 'entities', w.entities.zoho)).toBe(false); // only A mentioned it
    expect(exists(w.t, 'entities', w.entities.hubspot)).toBe(true); // surviving evidence
    expect(exists(w.t, 'entities', w.entities.notion)).toBe(true); // tagged in B
    expect(exists(w.t, 'entities', w.entities.pipedrive)).toBe(true); // in B's decision
  });

  it('removes the deleted conversation from the full-text index, and only that one', () => {
    const w = world();
    const hits = (q: string) => count(w.t.db, 'message_fts', 'message_fts MATCH ?', q);
    expect(hits('zoho')).toBe(1);
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );
    expect(hits('zoho')).toBe(0);
    expect(hits('notion')).toBe(1);
    expect(hits('private')).toBe(1); // Bob's message
  });

  it('hands the affected belief keys to the rebuilder, once, inside the transaction', () => {
    const w = world();
    const rebuilder = new RecordingRebuilder(w.t);
    const result = deleteConversation(w.t.db, { beliefs: rebuilder }, w.alice, w.a.conversationId);
    expect(result.affectedBeliefKeys.sort()).toEqual(['key-hubspot', 'key-hubspot-2', 'key-zoho']);
    expect(rebuilder.calls).toEqual([
      {
        userId: w.alice,
        keys: ['key-hubspot', 'key-hubspot-2', 'key-zoho'],
        inTransaction: true,
      },
    ]);
  });

  it('does not touch another user’s data, even where names coincide', () => {
    const w = world();
    deleteConversation(
      w.t.db,
      { beliefs: new RecordingRebuilder(w.t) },
      w.alice,
      w.a.conversationId,
    );
    expect(exists(w.t, 'conversations', w.bobs.conversationId)).toBe(true);
    expect(exists(w.t, 'entities', w.entities.bobHubspot)).toBe(true);
    expect(count(w.t.db, 'messages', 'user_id = ?', w.bob)).toBe(1);
    // unreferenced rows of another user are not Alice's to garbage-collect
    expect(exists(w.t, 'entities', w.entities.bobOrphanEntity)).toBe(true);
    expect(exists(w.t, 'source_snapshots', w.snapshots.bobOrphanSnapshot)).toBe(true);
  });

  it('refuses to delete someone else’s conversation, and changes nothing', () => {
    const w = world();
    const before = count(w.t.db, 'messages');
    expect(() =>
      deleteConversation(
        w.t.db,
        { beliefs: new RecordingRebuilder(w.t) },
        w.bob,
        w.a.conversationId,
      ),
    ).toThrow(NotFoundError);
    expect(count(w.t.db, 'messages')).toBe(before);
    expect(exists(w.t, 'conversations', w.a.conversationId)).toBe(true);
  });

  it('is all-or-nothing: a failing rebuilder rolls the whole deletion back', () => {
    const w = world();
    const failing: BeliefRebuilder = {
      rebuild() {
        throw new Error('rebuild failed');
      },
    };
    expect(() =>
      deleteConversation(w.t.db, { beliefs: failing }, w.alice, w.a.conversationId),
    ).toThrow('rebuild failed');
    expect(exists(w.t, 'conversations', w.a.conversationId)).toBe(true);
    expect(exists(w.t, 'evidence_statements', w.evidence.evOnly)).toBe(true);
    expect(exists(w.t, 'source_snapshots', w.snapshots.snOnly)).toBe(true);
    expect(exists(w.t, 'entities', w.entities.zoho)).toBe(true);
    expect(count(w.t.db, 'message_fts', 'message_fts MATCH ?', 'zoho')).toBe(1);
  });

  it('does not call the rebuilder when no belief keys were affected', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId } = seedConversation(t, user);
    const rebuilder = new RecordingRebuilder(t);
    expect(
      deleteConversation(t.db, { beliefs: rebuilder }, user, conversationId).affectedBeliefKeys,
    ).toEqual([]);
    expect(rebuilder.calls).toEqual([]);
  });

  // Full recall needs the memory milestone; at the database level this is covered by the tests above.
  it.todo('T-MEM-08: a deleted conversation cannot be recalled (needs MemoryRetriever)');
});
