import { describe, expect, it } from 'vitest';
import {
  insertAssertion,
  insertAssistantMessage,
  insertEntity,
  insertEvidence,
  insertFinding,
  insertSnapshot,
  openTestDb,
  seedConversation,
} from '../../helpers/db.js';

/**
 * Q-007, resolved by migration 003: a row may only reference rows owned by the same user as its owning
 * turn. These tests open the database at version 3 so that the error each one expects comes from migration
 * 003 itself and cannot be produced by a later migration's trigger.
 *
 * Two users, each with a conversation, a turn, an entity and a snapshot.
 */
function world() {
  const t = openTestDb('real', 3);
  const make = (name: string) => {
    const userId = t.users.create();
    const { conversationId, turnId, userMessageId } = seedConversation(t, userId);
    return {
      userId,
      conversationId,
      turnId,
      userMessageId,
      entityId: insertEntity(t.db, { userId, norm: name }),
      snapshotId: insertSnapshot(t.db, { userId }),
    };
  };
  return { t, alice: make('alice-co'), bob: make('bob-co') };
}

describe('Q-007: evidence ownership (migration 003)', () => {
  it('accepts evidence whose turn, snapshot and entity all belong to its user', () => {
    const { t, alice } = world();
    expect(() => insertEvidence(t.db, alice)).not.toThrow();
  });

  it('rejects evidence for another user’s turn', () => {
    const { t, alice, bob } = world();
    expect(() => insertEvidence(t.db, { ...alice, turnId: bob.turnId })).toThrow(
      /evidence turn owner mismatch/,
    );
  });

  it('rejects evidence that cites another user’s snapshot', () => {
    const { t, alice, bob } = world();
    expect(() => insertEvidence(t.db, { ...alice, snapshotId: bob.snapshotId })).toThrow(
      /evidence snapshot owner mismatch/,
    );
  });

  it('rejects evidence about another user’s entity', () => {
    const { t, alice, bob } = world();
    expect(() => insertEvidence(t.db, { ...alice, entityId: bob.entityId })).toThrow(
      /evidence entity owner mismatch/,
    );
  });

  it('rejects evidence for a turn that does not exist', () => {
    const { t, alice } = world();
    expect(() => insertEvidence(t.db, { ...alice, turnId: 'trn_missing' })).toThrow(
      /evidence turn owner mismatch/,
    );
  });
});

describe('Q-007: finding ownership (migration 003)', () => {
  it('accepts a finding about an entity of the turn’s user', () => {
    const { t, alice } = world();
    expect(() => insertFinding(t.db, alice)).not.toThrow();
  });

  it('rejects a finding about another user’s entity', () => {
    const { t, alice, bob } = world();
    expect(() => insertFinding(t.db, { turnId: alice.turnId, entityId: bob.entityId })).toThrow(
      /finding entity owner mismatch/,
    );
  });

  it('rejects a finding about an entity that does not exist', () => {
    const { t, alice } = world();
    expect(() => insertFinding(t.db, { turnId: alice.turnId, entityId: 'ent_missing' })).toThrow(
      /finding entity owner mismatch/,
    );
  });

  it('cannot be re-pointed at another turn or entity afterwards', () => {
    const { t, alice, bob } = world();
    const findingId = insertFinding(t.db, alice);
    expect(() =>
      t.db.prepare('UPDATE findings SET entity_id = ? WHERE id = ?').run(bob.entityId, findingId),
    ).toThrow(/finding references are immutable/);
    expect(() =>
      t.db.prepare('UPDATE findings SET turn_id = ? WHERE id = ?').run(bob.turnId, findingId),
    ).toThrow(/finding references are immutable/);
  });
});

describe('Q-007: assertion ownership (migration 003)', () => {
  function withAssistantMessages() {
    const w = world();
    const aliceAnswer = insertAssistantMessage(w.t, w.alice);
    const bobAnswer = insertAssistantMessage(w.t, w.bob);
    const aliceFinding = insertFinding(w.t.db, w.alice);
    const bobFinding = insertFinding(w.t.db, w.bob);
    return { ...w, aliceAnswer, bobAnswer, aliceFinding, bobFinding };
  }

  it('accepts an assertion whose turn, message and finding all belong to its user', () => {
    const w = withAssistantMessages();
    expect(() =>
      insertAssertion(w.t.db, {
        userId: w.alice.userId,
        messageId: w.aliceAnswer,
        turnId: w.alice.turnId,
        findingId: w.aliceFinding,
      }),
    ).not.toThrow();
  });

  it('rejects an assertion filed under a user who does not own the turn', () => {
    const w = withAssistantMessages();
    // Bob owns the message, so the only ownership violation is that Alice owns the turn.
    expect(() =>
      insertAssertion(w.t.db, {
        userId: w.bob.userId,
        messageId: w.bobAnswer,
        turnId: w.alice.turnId,
        findingId: w.aliceFinding,
      }),
    ).toThrow(/assertion turn owner mismatch/);
  });

  it('rejects an assertion attached to another user’s message', () => {
    const w = withAssistantMessages();
    expect(() =>
      insertAssertion(w.t.db, {
        userId: w.alice.userId,
        messageId: w.bobAnswer,
        turnId: w.alice.turnId,
        findingId: w.aliceFinding,
      }),
    ).toThrow(/assertion message owner mismatch/);
  });

  it('rejects an assertion that cites another user’s finding', () => {
    const w = withAssistantMessages();
    expect(() =>
      insertAssertion(w.t.db, {
        userId: w.alice.userId,
        messageId: w.aliceAnswer,
        turnId: w.alice.turnId,
        findingId: w.bobFinding,
      }),
    ).toThrow(/assertion finding belongs to another turn/);
  });

  it('rejects an assertion that cites a finding from a different turn of the same user', () => {
    const w = withAssistantMessages();
    const second = seedConversation(w.t, w.alice.userId);
    const otherFinding = insertFinding(w.t.db, {
      turnId: second.turnId,
      entityId: w.alice.entityId,
    });
    expect(() =>
      insertAssertion(w.t.db, {
        userId: w.alice.userId,
        messageId: w.aliceAnswer,
        turnId: w.alice.turnId,
        findingId: otherFinding,
      }),
    ).toThrow(/assertion finding belongs to another turn/);
  });

  it('an assertion can only cite its own user’s evidence, and the link cannot be edited', () => {
    const w = withAssistantMessages();
    const aliceAssertion = insertAssertion(w.t.db, {
      userId: w.alice.userId,
      messageId: w.aliceAnswer,
      turnId: w.alice.turnId,
      findingId: w.aliceFinding,
    });
    const aliceEvidence = insertEvidence(w.t.db, w.alice);
    const bobEvidence = insertEvidence(w.t.db, w.bob);
    const link = (evidenceId: string) =>
      w.t.db
        .prepare('INSERT INTO assertion_evidence (assertion_id, evidence_id) VALUES (?, ?)')
        .run(aliceAssertion, evidenceId);
    expect(() => link(bobEvidence)).toThrow(/assertion evidence owner mismatch/);
    expect(() => link(aliceEvidence)).not.toThrow();
    expect(() =>
      w.t.db
        .prepare('UPDATE assertion_evidence SET evidence_id = ? WHERE assertion_id = ?')
        .run(bobEvidence, aliceAssertion),
    ).toThrow(/append-only/);
  });
});

describe('Q-007: ownership holds on the real write path at the latest schema', () => {
  it('turn completion cannot cite another user’s evidence, and writes nothing when it tries', () => {
    // covered end to end in turn-completion.test.ts ("cross-user evidence"); this guard only pins that the
    // latest schema still carries the migration 003 triggers.
    const t = openTestDb();
    const names = (
      t.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'assertion_evidence_owner',
        'assertions_finding_turn',
        'assertions_message_owner',
        'assertions_turn_owner',
        'evidence_entity_owner',
        'evidence_snapshot_owner',
        'evidence_turn_owner',
        'findings_entity_owner',
        'messages_owner',
        'turns_owner',
      ]),
    );
  });
});
