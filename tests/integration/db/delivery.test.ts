import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { InvalidAckError, NotFoundError, TurnNotFinishedError } from '../../../src/db/index.js';
import { newId } from '../../../src/shared/ids.js';
import {
  count,
  insertAssertion,
  insertAssertionEvent,
  insertAssistantMessage,
  insertEntity,
  insertFinding,
  openTestDb,
  seedConversation,
  T0,
  type TestDb,
} from '../../helpers/db.js';
import { advance, completedAnswer, startTurn, type CompletedAnswer } from '../../helpers/turns.js';

/** Seven sentences, the price claimed in 0, 2, 4 and 6, all of it streamed. */
function sevenSentenceAnswer(t: TestDb, extra: { streamedThrough?: number } = {}): CompletedAnswer {
  return completedAnswer(t, {
    sentences: 7,
    claimsAt: [0, 2, 4, 6],
    streamedThrough: extra.streamedThrough ?? 6,
  });
}

const ack = (
  t: TestDb,
  a: CompletedAnswer,
  renderedThrough: number,
  complete = false,
  at = T0 + 1_000,
) => t.turns.ack(a.userId, a.turnId, { renderedThrough, complete }, at);

const state = (t: TestDb, a: CompletedAnswer) =>
  t.assertions.listForMessage(a.userId, a.assistantMessageId);
const presentedIndexes = (t: TestDb, a: CompletedAnswer) =>
  state(t, a)
    .filter((x) => x.delivery === 'presented')
    .map((x) => x.sentenceIndex);

/** What the baseline loader reads: assertions the browser actually acknowledged. */
const baselines = (t: TestDb, a: CompletedAnswer): string[] =>
  (
    t.db
      .prepare(
        'SELECT id FROM assertions WHERE user_id = ? AND presented_at IS NOT NULL ORDER BY sentence_index',
      )
      .all(a.userId) as Array<{ id: string }>
  ).map((r) => r.id);

const extents = (t: TestDb, a: CompletedAnswer) =>
  t.db
    .prepare(
      'SELECT streamed_through AS streamed, rendered_through AS rendered, last_ack_at AS at FROM messages WHERE id = ?',
    )
    .get(a.assistantMessageId) as { streamed: number; rendered: number; at: number | null };

describe('T-DLV-01: a fully rendered answer is acknowledged, and every claim in it is presented once', () => {
  it('presents all four claims with exactly one presented event each', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(ack(t, a, 6, true)).toEqual({ renderedThrough: 6, newlyPresented: 4 });

    const claims = state(t, a);
    expect(claims.map((c) => c.delivery)).toEqual([
      'presented',
      'presented',
      'presented',
      'presented',
    ]);
    expect(claims.every((c) => c.presentedAt === T0 + 1_000)).toBe(true);
    expect(claims.map((c) => c.events.map((e) => [e.status, e.reason, e.turnId]))).toEqual(
      claims.map(() => [['presented', 'acknowledged', a.turnId]]),
    );
    expect(extents(t, a)).toEqual({ streamed: 6, rendered: 6, at: T0 + 1_000 });
    expect(baselines(t, a)).toHaveLength(4);
  });
});

describe('T-DLV-02: a partly rendered answer stays partly presented', () => {
  it('after acknowledging sentences 0-3 and then disconnecting, only claims in 0-3 are presented', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(ack(t, a, 3)).toEqual({ renderedThrough: 3, newlyPresented: 2 });

    // the stream reached sentence 6, the browser rendered up to 3: two different extents
    expect(extents(t, a)).toMatchObject({ streamed: 6, rendered: 3 });
    expect(state(t, a).map((c) => [c.sentenceIndex, c.delivery])).toEqual([
      [0, 'presented'],
      [2, 'presented'],
      [4, 'streamed_unacknowledged'],
      [6, 'streamed_unacknowledged'],
    ]);
    expect(
      state(t, a)
        .filter((c) => c.delivery !== 'presented')
        .every((c) => c.presentedAt === null && c.events.length === 0),
    ).toBe(true);

    // the browser goes away: a later restart and recovery change nothing about what was told
    t.clock.advance(3_600_000);
    t.turns.recoverRunning(t.clock.now());
    expect(presentedIndexes(t, a)).toEqual([0, 2]);
    expect(baselines(t, a)).toHaveLength(2); // INV-05: only acknowledged claims can be baselines
    expect(count(t.db, 'assertion_events', "status = 'presented'")).toBe(2);
  });
});

describe('T-DLV-03: an answer that was streamed but never rendered presents nothing', () => {
  it('every claim is streamed_unacknowledged, with no presented_at, no event and no baseline', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(state(t, a).map((c) => c.delivery)).toEqual(Array(4).fill('streamed_unacknowledged'));
    expect(state(t, a).every((c) => c.presentedAt === null && c.events.length === 0)).toBe(true);
    expect(count(t.db, 'assertion_events')).toBe(0);
    expect(baselines(t, a)).toEqual([]);
    expect(extents(t, a)).toMatchObject({ rendered: -1, at: null });
  });

  it('a claim in a sentence that was never streamed is not_streamed and cannot be acknowledged', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t, { streamedThrough: 3 });
    expect(state(t, a).map((c) => [c.sentenceIndex, c.delivery])).toEqual([
      [0, 'streamed_unacknowledged'],
      [2, 'streamed_unacknowledged'],
      [4, 'not_streamed'],
      [6, 'not_streamed'],
    ]);
    // the never-streamed claims carry a not_presented event from the moment they were stored
    expect(state(t, a).map((c) => c.events.map((e) => e.status))).toEqual([
      [],
      [],
      ['not_presented'],
      ['not_presented'],
    ]);
    expect(() => ack(t, a, 4)).toThrow(InvalidAckError);
    expect(baselines(t, a)).toEqual([]);
  });
});

describe('T-DLV-04: a repeated acknowledgement changes nothing', () => {
  it('reports the stored extent, presents nothing new, and does not even touch last_ack_at', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(ack(t, a, 3, false, T0 + 1_000)).toEqual({ renderedThrough: 3, newlyPresented: 2 });
    const snapshot = {
      extents: extents(t, a),
      claims: state(t, a),
      events: count(t.db, 'assertion_events'),
    };

    expect(ack(t, a, 3, false, T0 + 99_000)).toEqual({ renderedThrough: 3, newlyPresented: 0 });
    expect(ack(t, a, 3, false, T0 + 199_000)).toEqual({ renderedThrough: 3, newlyPresented: 0 });

    expect({
      extents: extents(t, a),
      claims: state(t, a),
      events: count(t.db, 'assertion_events'),
    }).toEqual(snapshot);
    expect(extents(t, a).at).toBe(T0 + 1_000);
  });
});

describe('T-DLV-05: acknowledgements are monotonic, so out-of-order ones are harmless', () => {
  it('a lower acknowledgement arriving after a higher one is a no-op', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(ack(t, a, 5)).toEqual({ renderedThrough: 5, newlyPresented: 3 });
    expect(ack(t, a, 2)).toEqual({ renderedThrough: 5, newlyPresented: 0 });
    expect(ack(t, a, -1)).toEqual({ renderedThrough: 5, newlyPresented: 0 });
    expect(ack(t, a, 5)).toEqual({ renderedThrough: 5, newlyPresented: 0 });
    expect(extents(t, a).rendered).toBe(5);
    expect(presentedIndexes(t, a)).toEqual([0, 2, 4]);
    expect(count(t.db, 'assertion_events', "status = 'presented'")).toBe(3);

    expect(ack(t, a, 6)).toEqual({ renderedThrough: 6, newlyPresented: 1 });
    expect(presentedIndexes(t, a)).toEqual([0, 2, 4, 6]);
  });

  it('acknowledging nothing (-1) is valid and leaves the message unrendered', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    expect(ack(t, a, -1)).toEqual({ renderedThrough: -1, newlyPresented: 0 });
    expect(extents(t, a)).toMatchObject({ rendered: -1, at: null });
  });
});

describe('T-DLV-06: a reconnect that re-renders the stored answer completes the acknowledgement', () => {
  it('presents the rest later, without disturbing what was presented earlier', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    ack(t, a, 1, false, T0 + 1_000); // the browser's beacon before it went away: sentences 0-1
    const early = state(t, a)[0];
    expect(early).toMatchObject({ delivery: 'presented', presentedAt: T0 + 1_000 });

    // an hour later the user comes back and the stored answer is rendered in full
    expect(ack(t, a, 6, true, T0 + 3_600_000)).toEqual({ renderedThrough: 6, newlyPresented: 3 });

    const claims = state(t, a);
    expect(claims.map((c) => c.presentedAt)).toEqual([
      T0 + 1_000,
      T0 + 3_600_000,
      T0 + 3_600_000,
      T0 + 3_600_000,
    ]);
    expect(claims.map((c) => c.events.filter((e) => e.status === 'presented').length)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(extents(t, a)).toMatchObject({ rendered: 6, at: T0 + 3_600_000 });
  });
});

describe('T-DLV-07: acknowledging a retry never touches the original turn’s assertions', () => {
  it('the interrupted original stays unpresented while its retry is fully presented', () => {
    const t = openTestDb();
    const original = completedAnswer(t, {
      sentences: 7,
      claimsAt: [0, 2],
      streamedThrough: 4,
      status: 'interrupted',
    });
    const retry = completedAnswer(t, {
      userId: original.userId,
      conversationId: original.conversationId,
      retryOfTurnId: original.turnId,
      sentences: 3,
      claimsAt: [1],
      streamedThrough: 2,
    });
    expect(t.turns.get(original.userId, retry.turnId)?.retryOfTurnId).toBe(original.turnId);

    expect(ack(t, retry, 2, true)).toEqual({ renderedThrough: 2, newlyPresented: 1 });

    expect(state(t, original).every((c) => c.presentedAt === null && c.events.length === 0)).toBe(
      true,
    );
    expect(extents(t, original)).toMatchObject({ rendered: -1 });
    expect(presentedIndexes(t, retry)).toEqual([1]);
    expect(baselines(t, retry)).toHaveLength(1);
    expect(
      count(t.db, 'assertions', 'turn_id = ? AND presented_at IS NOT NULL', original.turnId),
    ).toBe(0);
  });
});

describe('T-DLV-08: an interrupted turn keeps the exact acknowledged extent', () => {
  it('cannot be acknowledged beyond what was streamed, and its truncated claims stay not_presented', () => {
    const t = openTestDb();
    // 5 sentences; claims in 1, 3 and 4; the stream broke after sentence 2, so 3 and 4 were never streamed
    const a = completedAnswer(t, {
      sentences: 5,
      claimsAt: [1, 3, 4],
      streamedThrough: 2,
      status: 'interrupted',
    });
    expect(t.messages.getOwned(a.userId, a.assistantMessageId)).toMatchObject({
      status: 'interrupted',
      streamedThrough: 2,
    });

    expect(ack(t, a, 1)).toEqual({ renderedThrough: 1, newlyPresented: 1 });
    expect(ack(t, a, 2, true)).toEqual({ renderedThrough: 2, newlyPresented: 0 }); // complete = everything streamed

    expect(() => ack(t, a, 3)).toThrow(InvalidAckError);
    expect(() => ack(t, a, 4, true)).toThrow(InvalidAckError);
    expect(() => ack(t, a, 1, true)).toThrow(
      /complete=true requires renderedThrough to equal the streamed extent/,
    );

    expect(extents(t, a)).toMatchObject({ streamed: 2, rendered: 2 });
    expect(state(t, a).map((c) => [c.sentenceIndex, c.delivery])).toEqual([
      [1, 'presented'],
      [3, 'not_streamed'],
      [4, 'not_streamed'],
    ]);
    expect(
      state(t, a)
        .filter((c) => c.sentenceIndex >= 3)
        .every(
          (c) => c.presentedAt === null && c.events.map((e) => e.status).join() === 'not_presented',
        ),
    ).toBe(true);

    // a later restart does not alter the acknowledged extent
    t.turns.recoverRunning(T0 + 10_000);
    expect(extents(t, a)).toMatchObject({ streamed: 2, rendered: 2 });
    expect(baselines(t, a)).toHaveLength(1);
  });
});

describe('acknowledgement: validation, ownership and atomicity', () => {
  it('has nothing to acknowledge before the answer is stored', () => {
    const t = openTestDb();
    const userId = t.users.create();
    const { turnId } = startTurn(t, userId, t.conversations.create({ userId }).id);
    expect(() => t.turns.ack(userId, turnId, { renderedThrough: 0, complete: false }, T0)).toThrow(
      TurnNotFinishedError,
    );
    advance(t, userId, turnId);
    expect(() => t.turns.ack(userId, turnId, { renderedThrough: 0, complete: false }, T0)).toThrow(
      TurnNotFinishedError,
    );
  });

  it('is scoped to the owner of the turn', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    const intruder = t.users.create();
    expect(() =>
      t.turns.ack(intruder, a.turnId, { renderedThrough: 6, complete: true }, T0),
    ).toThrow(NotFoundError);
    expect(() =>
      t.turns.ack(a.userId, newId('trn'), { renderedThrough: 0, complete: false }, T0),
    ).toThrow(NotFoundError);
    expect(extents(t, a).rendered).toBe(-1);
    expect(baselines(t, a)).toEqual([]);
  });

  it('rejects malformed acknowledgements', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    for (const bad of [
      { renderedThrough: -2, complete: false },
      { renderedThrough: 1.5, complete: false },
      { renderedThrough: '3', complete: false },
      { renderedThrough: 3 },
    ]) {
      expect(() => t.turns.ack(a.userId, a.turnId, bad as never, T0)).toThrow(ZodError);
    }
    expect(extents(t, a).rendered).toBe(-1);
  });

  it('is atomic: if recording a presented event fails, the extent and presented_at roll back too', () => {
    const t = openTestDb();
    const a = sevenSentenceAnswer(t);
    // Fault injection (test only)
    t.db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON assertion_events WHEN NEW.status = 'presented'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => ack(t, a, 6, true)).toThrow(/boom/);
    expect(extents(t, a)).toMatchObject({ rendered: -1, at: null });
    expect(
      state(t, a).every((c) => c.presentedAt === null && c.delivery === 'streamed_unacknowledged'),
    ).toBe(true);

    t.db.exec('DROP TRIGGER temp.boom');
    expect(ack(t, a, 6, true)).toEqual({ renderedThrough: 6, newlyPresented: 4 }); // the retry works
  });

  it('advances the extent even when no claim lies in the newly rendered sentences', () => {
    const t = openTestDb();
    const a = completedAnswer(t, { sentences: 5, claimsAt: [4], streamedThrough: 4 });
    expect(ack(t, a, 2)).toEqual({ renderedThrough: 2, newlyPresented: 0 });
    expect(extents(t, a).rendered).toBe(2);
    expect(state(t, a)[0]?.delivery).toBe('streamed_unacknowledged');
  });

  it('a user cannot acknowledge into someone else’s answer even with the right turn id', () => {
    const t = openTestDb();
    const alice = sevenSentenceAnswer(t);
    const bob = sevenSentenceAnswer(t);
    expect(() =>
      t.turns.ack(bob.userId, alice.turnId, { renderedThrough: 6, complete: true }, T0),
    ).toThrow(NotFoundError);
    expect(baselines(t, alice)).toEqual([]);
    expect(baselines(t, bob)).toEqual([]);
  });
});

describe('delivery rules enforced by the database itself (migration 005)', () => {
  function world(streamedThrough = 2) {
    const t = openTestDb();
    const a = completedAnswer(t, { sentences: 4, claimsAt: [0, 3], streamedThrough });
    const [first, last] = state(t, a);
    return { t, a, first: first?.id as string, last: last?.id as string };
  }

  it('refuses to mark a claim presented until its sentence is acknowledged', () => {
    const { t, first } = world();
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0, first),
    ).toThrow(/sentence has not been acknowledged as rendered/);
  });

  it('refuses to render beyond the streamed extent, and refuses rendering a user message', () => {
    const { t, a } = world(2);
    expect(() =>
      t.db
        .prepare('UPDATE messages SET rendered_through = 3 WHERE id = ?')
        .run(a.assistantMessageId),
    ).toThrow(/cannot render beyond the streamed extent/);
    t.db.prepare('UPDATE messages SET rendered_through = 2 WHERE id = ?').run(a.assistantMessageId); // up to the extent is fine
    const turn = t.turns.get(a.userId, a.turnId);
    expect(() =>
      t.db
        .prepare('UPDATE messages SET rendered_through = 0 WHERE id = ?')
        .run(turn?.userMessageId),
    ).toThrow(/cannot render beyond the streamed extent/);
  });

  it('once rendered, a claim may be presented, but only for sentences at or below the extent', () => {
    const { t, a, first, last } = world(3);
    t.db.prepare('UPDATE messages SET rendered_through = 1 WHERE id = ?').run(a.assistantMessageId);
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0, first),
    ).not.toThrow();
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0, last),
    ).toThrow(/has not been acknowledged/);
  });

  it('creates assertions unpresented, for an existing sentence of an assistant message of their own turn', () => {
    const { t, a } = world();
    const userId = a.userId;
    const turn = t.turns.get(userId, a.turnId);
    const findingId = (
      t.db.prepare('SELECT id FROM findings WHERE turn_id = ?').get(a.turnId) as { id: string }
    ).id;
    const insert = (
      over: Partial<{
        presentedAt: number | null;
        messageId: string;
        sentenceIndex: number;
        turnId: string;
      }> = {},
    ) =>
      t.db
        .prepare(
          `INSERT INTO assertions (id, user_id, message_id, turn_id, finding_id, sentence_index, placeholder, rendered_text, created_at, presented_at)
           VALUES (?, ?, ?, ?, ?, ?, 'F1', 'x', ?, ?)`,
        )
        .run(
          newId('asr'),
          userId,
          over.messageId ?? a.assistantMessageId,
          over.turnId ?? a.turnId,
          findingId,
          over.sentenceIndex ?? 1,
          T0,
          over.presentedAt ?? null,
        );
    expect(() => insert({ presentedAt: T0 })).toThrow(/assertions are created unpresented/);
    // a user message has no sentences either, so the range rule may fire alongside the assistant-message rule
    expect(() => insert({ messageId: turn?.userMessageId as string })).toThrow(
      /assistant message of its turn|sentence_index out of range/,
    );
    expect(() => insert({ sentenceIndex: 4 })).toThrow(/sentence_index out of range/);
    expect(() => insert({ sentenceIndex: -1 })).toThrow(/sentence_index out of range/);
    expect(() => insert()).not.toThrow();
  });

  it('refuses an assertion on an assistant message that belongs to a different turn', () => {
    const t = openTestDb();
    const userId = t.users.create();
    const one = seedConversation(t, userId);
    const two = seedConversation(t, userId);
    const answerOfOne = insertAssistantMessage(t, {
      userId,
      conversationId: one.conversationId,
      turnId: one.turnId,
    });
    const entityId = insertEntity(t.db, { userId, norm: 'x' });
    const findingOfTwo = insertFinding(t.db, { turnId: two.turnId, entityId });
    expect(() =>
      insertAssertion(t.db, {
        userId,
        messageId: answerOfOne,
        turnId: two.turnId,
        findingId: findingOfTwo,
      }),
    ).toThrow(/assistant message of its turn/);
  });

  it('allows a not_presented event only for a sentence that was never streamed', () => {
    const { t, first, last } = world(1); // streamed through sentence 1: claim 0 streamed, claim 3 not
    expect(() =>
      insertAssertionEvent(t.db, { assertionId: first as never, status: 'not_presented' }),
    ).toThrow(/not_presented only for sentences that were never streamed/);
    expect(
      count(t.db, 'assertion_events', "assertion_id = ? AND status = 'not_presented'", last),
    ).toBe(1); // already there
  });

  it('allows a presented event only once the assertion has presented_at, and never together with not_presented', () => {
    const { t, a, first, last } = world(3);
    expect(() =>
      insertAssertionEvent(t.db, { assertionId: first as never, status: 'presented' }),
    ).toThrow(/presented event requires presented_at/);
    t.db.prepare('UPDATE messages SET rendered_through = 3 WHERE id = ?').run(a.assistantMessageId);
    t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0, last);
    expect(() =>
      insertAssertionEvent(t.db, { assertionId: last as never, status: 'presented' }),
    ).not.toThrow();
    expect(() =>
      insertAssertionEvent(t.db, { assertionId: last as never, status: 'not_presented' }),
    ).toThrow(/not_presented only for sentences that were never streamed/);
  });

  it('stores messages unrendered, with a streamed extent that lies within their sentences', () => {
    const t = openTestDb();
    const userId = t.users.create();
    const { conversationId } = seedConversation(t, userId);
    const insert = (over: {
      rendered?: number;
      ackAt?: number | null;
      streamed?: number | null;
      sentences?: string | null;
    }) =>
      t.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, sentences_json, streamed_through,
             rendered_through, last_ack_at, tz, created_at)
           VALUES (?, ?, ?, ?, 'assistant', 'x', ?, ?, ?, ?, 'UTC', ?)`,
        )
        .run(
          newId('msg'),
          conversationId,
          userId,
          10 + Math.floor(Math.random() * 1e6),
          over.sentences === undefined ? '["a","b"]' : over.sentences,
          over.streamed === undefined ? 1 : over.streamed,
          over.rendered ?? -1,
          over.ackAt ?? null,
          T0,
        );
    expect(() => insert({ rendered: 0 })).toThrow(/messages are stored unrendered/);
    expect(() => insert({ ackAt: T0 })).toThrow(/messages are stored unrendered/);
    expect(() => insert({ streamed: 2 })).toThrow(/streamed_through out of range/);
    expect(() => insert({ streamed: -2 })).toThrow(/streamed_through out of range/);
    expect(() => insert({ streamed: null })).toThrow(/streamed_through out of range/);
    expect(() => insert({ streamed: 1 })).not.toThrow();
    expect(() => insert({ streamed: -1 })).not.toThrow();
  });
});
