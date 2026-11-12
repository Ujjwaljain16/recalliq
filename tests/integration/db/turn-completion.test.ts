import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  InvalidCompletionError,
  InvalidTransitionError,
  NotFoundError,
  validateCompletion,
} from '../../../src/db/index.js';
import type { TurnCompletion } from '../../../src/shared/repositories.js';
import {
  count,
  insertEntity,
  insertEvidence,
  insertSnapshot,
  openTestDb,
  T0,
  type TestDb,
} from '../../helpers/db.js';
import {
  advance,
  buildCompletion,
  buildFinding,
  completedAnswer,
  RENDERED_PRICE,
  startTurn,
  USD_90,
} from '../../helpers/turns.js';

/** A turn waiting in PERSISTING, with an entity for its finding. */
function readyTurn(t: TestDb, opts: { userId?: ReturnType<TestDb['users']['create']> } = {}) {
  const userId = opts.userId ?? t.users.create();
  const conversationId = t.conversations.create({ userId }).id;
  const { turnId } = startTurn(t, userId, conversationId);
  advance(t, userId, turnId);
  const entityId = insertEntity(t.db, { userId, norm: `hubspot-${turnId}` });
  return { userId, conversationId, turnId, entityId };
}

const answerRows = (t: TestDb) => ({
  assistantMessages: count(t.db, 'messages', "role = 'assistant'"),
  findings: count(t.db, 'findings'),
  assertions: count(t.db, 'assertions'),
  links: count(t.db, 'assertion_evidence'),
  events: count(t.db, 'assertion_events'),
});
const NOTHING_WRITTEN = { assistantMessages: 0, findings: 0, assertions: 0, links: 0, events: 0 };

describe('T-ASR-01: turn completion persists the answer, findings, assertions and events', () => {
  it('stores everything in one transaction and leaves every assertion unpresented', () => {
    const t = openTestDb();
    const { userId, conversationId, turnId, entityId } = readyTurn(t);
    const snapshotId = insertSnapshot(t.db, { userId });
    const evidenceId = insertEvidence(t.db, { userId, snapshotId, turnId, entityId });
    t.clock.advance(2_000);

    // 6 sentences; the price is claimed in sentences 0, 2 and 5; the stream got as far as sentence 3
    const completion = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 6,
      claimsAt: [0, 2, 5],
      streamedThrough: 3,
      evidenceIds: [evidenceId],
    });
    t.turns.complete(userId, turnId, completion);

    const turn = t.turns.get(userId, turnId);
    expect(turn).toMatchObject({
      state: 'COMPLETED',
      status: 'complete',
      lane: 'chat',
      finishedAt: T0 + 2_000,
      errorCode: null,
    });
    expect(turn?.assistantMessageId).not.toBeNull();

    const message = t.messages.getOwned(userId, turn?.assistantMessageId as never);
    expect(message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      conversationId,
      turnId,
      streamedThrough: 3,
      renderedThrough: -1,
      lastAckAt: null,
      tz: 'Europe/London', // inherited from the turn's user message
      origin: 'live',
    });
    expect(message?.sentences).toEqual(completion.assistant?.sentences);

    const stored = t.assertions.listForMessage(userId, turn?.assistantMessageId as never);
    expect(stored.map((a) => [a.sentenceIndex, a.delivery, a.presentedAt])).toEqual([
      [0, 'streamed_unacknowledged', null],
      [2, 'streamed_unacknowledged', null],
      [5, 'not_streamed', null],
    ]);
    expect(stored.every((a) => a.evidenceIds.length === 1 && a.evidenceIds[0] === evidenceId)).toBe(
      true,
    );
    expect(stored.every((a) => a.renderedText === RENDERED_PRICE && a.value?.amount === 90)).toBe(
      true,
    );
    expect(stored.every((a) => a.createdAt === T0 + 2_000)).toBe(true);

    // nothing has been told: no presented event, and only the never-streamed claim has an event at all
    expect(count(t.db, 'assertion_events', "status = 'presented'")).toBe(0);
    expect(stored.map((a) => a.events.map((e) => [e.status, e.reason]))).toEqual([
      [],
      [],
      [['not_presented', 'never_streamed']],
    ]);

    expect(count(t.db, 'findings', 'turn_id = ?', turnId)).toBe(1);
    const events = JSON.parse(
      (
        t.db.prepare('SELECT events_json FROM turns WHERE id = ?').get(turnId) as {
          events_json: string;
        }
      ).events_json,
    ) as unknown[];
    expect(events).toEqual(completion.events);
  });

  it('stores an interrupted answer with its exact streamed extent and a truncated last sentence', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    const completion = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 5,
      claimsAt: [1, 4],
      streamedThrough: 2,
      status: 'interrupted',
    });
    // the last sentence was cut off mid-way: it is persisted, but as truncated, and it was never fully streamed
    const sentences = completion.assistant?.sentences ?? [];
    sentences[4] = { ...(sentences[4] as (typeof sentences)[number]), status: 'truncated' };
    t.turns.complete(userId, turnId, completion);

    const turn = t.turns.get(userId, turnId);
    expect(turn).toMatchObject({ state: 'COMPLETED', status: 'interrupted' });
    const message = t.messages.getOwned(userId, turn?.assistantMessageId as never);
    expect(message).toMatchObject({
      status: 'interrupted',
      streamedThrough: 2,
      renderedThrough: -1,
    });
    expect(message?.sentences?.[4]?.status).toBe('truncated');
    const stored = t.assertions.listForMessage(userId, turn?.assistantMessageId as never);
    expect(stored.map((a) => [a.sentenceIndex, a.delivery])).toEqual([
      [1, 'streamed_unacknowledged'],
      [4, 'not_streamed'],
    ]);
    expect(count(t.db, 'assertion_events', "status = 'not_presented'")).toBe(1);
  });

  it('records outcomes that have no answer: a failed turn, with findings but no assertions', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    const completion: TurnCompletion = {
      ...buildCompletion({
        turnId,
        userId,
        entityId,
        sentences: 0,
        claimsAt: [],
        streamedThrough: -1,
        status: 'failed',
      }),
      assistant: null,
      assertions: [],
      errorCode: 'llm_unavailable',
    };
    t.turns.complete(userId, turnId, completion);
    expect(t.turns.get(userId, turnId)).toMatchObject({
      state: 'COMPLETED',
      status: 'failed',
      assistantMessageId: null,
      errorCode: 'llm_unavailable',
    });
    expect(count(t.db, 'messages', "role = 'assistant'")).toBe(0);
  });

  it('needs a running turn in PERSISTING', () => {
    const t = openTestDb();
    const userId = t.users.create();
    const conversationId = t.conversations.create({ userId }).id;
    const { turnId } = startTurn(t, userId, conversationId);
    const entityId = insertEntity(t.db, { userId, norm: 'x' });
    const completion = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });

    expect(() => t.turns.complete(userId, turnId, completion)).toThrow(InvalidTransitionError); // RECEIVED
    advance(t, userId, turnId, ['ANALYZING', 'RESOLVING_CONTEXT', 'SYNTHESIZING']);
    expect(() => t.turns.complete(userId, turnId, completion)).toThrow(InvalidTransitionError); // SYNTHESIZING
    advance(t, userId, turnId, ['POST_VERIFYING', 'PERSISTING']);
    t.turns.complete(userId, turnId, completion);
    expect(() => t.turns.complete(userId, turnId, completion)).toThrow(InvalidTransitionError); // already finished
    expect(count(t.db, 'messages', "role = 'assistant'")).toBe(1);
  });

  it('belongs to the owner: another user cannot complete the turn', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    const intruder = t.users.create();
    const completion = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    expect(() => t.turns.complete(intruder, turnId, completion)).toThrow(NotFoundError);
    expect(t.turns.get(userId, turnId)?.status).toBe('running');
  });
});

describe('T-ASR-02: completion is atomic: a failure part-way writes nothing', () => {
  it('rolls back the message, findings and earlier assertions when a later write fails, and can be retried', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    const completion = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 4,
      claimsAt: [0, 1, 2],
      streamedThrough: 3,
    });

    // Fault injection (test only): the second assertion insert fails after the first, the message and
    // the finding have already been written inside the transaction.
    t.db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON assertions
       WHEN (SELECT count(*) FROM assertions) >= 1
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => t.turns.complete(userId, turnId, completion)).toThrow(/boom/);

    expect(answerRows(t)).toEqual(NOTHING_WRITTEN);
    expect(t.turns.get(userId, turnId)).toMatchObject({
      state: 'PERSISTING',
      status: 'running',
      assistantMessageId: null,
      finishedAt: null,
    });

    t.db.exec('DROP TRIGGER temp.boom');
    t.turns.complete(userId, turnId, completion); // the same completion now succeeds: nothing was half-applied
    expect(answerRows(t)).toMatchObject({ assistantMessages: 1, findings: 1, assertions: 3 });
  });

  it('rolls back when the final turn update is refused', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    t.db.exec(
      `CREATE TEMP TRIGGER boom BEFORE UPDATE ON turns WHEN NEW.state = 'COMPLETED'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() =>
      t.turns.complete(
        userId,
        turnId,
        buildCompletion({
          turnId,
          userId,
          entityId,
          sentences: 2,
          claimsAt: [0],
          streamedThrough: 1,
        }),
      ),
    ).toThrow(/boom/);
    expect(answerRows(t)).toEqual(NOTHING_WRITTEN);
    expect(t.turns.get(userId, turnId)?.status).toBe('running');
  });
});

describe('T-ASR-03: inconsistent or premature completions are refused before anything is written', () => {
  const cases: Array<[string, (c: TurnCompletion) => TurnCompletion, 'invalid' | 'zod']> = [
    [
      'belief keys to recompute (needs the belief resolver)',
      (c) => ({ ...c, touchedBeliefKeys: ['price:v1|x'] }),
      'invalid',
    ],
    [
      'status interrupted with a complete assistant message',
      (c) => ({ ...c, status: 'interrupted' }),
      'invalid',
    ],
    [
      'an interrupted assistant message under status complete',
      (c) => ({ ...c, assistant: c.assistant && { ...c.assistant, messageStatus: 'interrupted' } }),
      'invalid',
    ],
    [
      'an assertion that cites an unknown finding',
      (c) => ({
        ...c,
        assertions: c.assertions.map((a) => ({ ...a, findingId: 'fnd_unknown' as const })),
      }),
      'invalid',
    ],
    [
      'a placeholder that does not match its finding’s ord',
      (c) => ({ ...c, assertions: c.assertions.map((a) => ({ ...a, placeholder: 'F2' })) }),
      'invalid',
    ],
    [
      'an assertion whose text is not what was rendered',
      (c) => ({ ...c, assertions: c.assertions.map((a) => ({ ...a, renderedText: '$1 [1]' })) }),
      'invalid',
    ],
    [
      'an assertion in a sentence beyond the answer',
      (c) => ({ ...c, assertions: c.assertions.map((a) => ({ ...a, sentenceIndex: 99 })) }),
      'invalid',
    ],
    [
      'a duplicated assertion',
      (c) => ({ ...c, assertions: [...c.assertions, ...c.assertions] }),
      'invalid',
    ],
    ['assertions without an assistant message', (c) => ({ ...c, assistant: null }), 'invalid'],
    [
      'a streamed extent beyond the last sentence',
      (c) => ({ ...c, assistant: c.assistant && { ...c.assistant, streamedThrough: 50 } }),
      'invalid',
    ],
    [
      'sentences that are not numbered in order',
      (c) => ({
        ...c,
        assistant: c.assistant && {
          ...c.assistant,
          sentences: c.assistant.sentences.map((s) => ({ ...s, index: s.index + 1 })),
        },
      }),
      'invalid',
    ],
    [
      'findings that belong to another turn',
      (c) => ({ ...c, findings: c.findings && { ...c.findings, turnId: 'trn_other' as const } }),
      'invalid',
    ],
    [
      'two findings with the same ord',
      (c) => {
        const set = c.findings;
        const first = set?.findings[0];
        if (!set || !first) throw new Error('fixture has no finding');
        return {
          ...(set && {
            ...c,
            findings: { ...set, findings: [first, { ...first, id: 'fnd_second' as const }] },
          }),
        };
      },
      'invalid',
    ],
    ['an unknown status (malformed)', (c) => ({ ...c, status: 'bogus' as never }), 'zod'],
    [
      'a malformed placeholder (malformed)',
      (c) => ({ ...c, assertions: c.assertions.map((a) => ({ ...a, placeholder: '[[F1]]' })) }),
      'zod',
    ],
    [
      'negative streamed extent below -1 (malformed)',
      (c) => ({ ...c, assistant: c.assistant && { ...c.assistant, streamedThrough: -2 } }),
      'zod',
    ],
  ];

  for (const [name, mutate, kind] of cases) {
    it(`refuses ${name}`, () => {
      const t = openTestDb();
      const { userId, turnId, entityId } = readyTurn(t);
      const valid = buildCompletion({
        turnId,
        userId,
        entityId,
        sentences: 3,
        claimsAt: [1],
        streamedThrough: 2,
      });
      const bad = mutate(valid);
      expect(() => validateCompletion(turnId, bad)).toThrow(
        kind === 'zod' ? ZodError : InvalidCompletionError,
      );
      expect(() => t.turns.complete(userId, turnId, bad)).toThrow(
        kind === 'zod' ? ZodError : InvalidCompletionError,
      );
      expect(answerRows(t)).toEqual(NOTHING_WRITTEN);
      expect(t.turns.get(userId, turnId)).toMatchObject({ state: 'PERSISTING', status: 'running' });
    });
  }

  it('accepts the unmodified completion the cases above were derived from', () => {
    const t = openTestDb();
    const { userId, turnId, entityId } = readyTurn(t);
    const valid = buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 3,
      claimsAt: [1],
      streamedThrough: 2,
    });
    expect(() => validateCompletion(turnId, valid)).not.toThrow();
    t.turns.complete(userId, turnId, valid);
    expect(answerRows(t)).toMatchObject({ assistantMessages: 1, assertions: 1 });
  });
});

describe('T-ASR-04: cross-user ownership violations are refused by the database, and roll the completion back', () => {
  it('rejects an assertion that cites another user’s evidence', () => {
    const t = openTestDb();
    const alice = readyTurn(t);
    const bob = readyTurn(t);
    const bobsEvidence = insertEvidence(t.db, {
      userId: bob.userId,
      snapshotId: insertSnapshot(t.db, { userId: bob.userId }),
      turnId: bob.turnId,
      entityId: bob.entityId,
    });
    const completion = buildCompletion({
      turnId: alice.turnId,
      userId: alice.userId,
      entityId: alice.entityId,
      sentences: 2,
      claimsAt: [0],
      streamedThrough: 1,
      evidenceIds: [bobsEvidence],
    });
    expect(() => t.turns.complete(alice.userId, alice.turnId, completion)).toThrow(
      /assertion evidence owner mismatch/,
    );
    expect(answerRows(t)).toEqual(NOTHING_WRITTEN);
    expect(t.turns.get(alice.userId, alice.turnId)?.status).toBe('running');
  });

  it('rejects a finding about another user’s entity', () => {
    const t = openTestDb();
    const alice = readyTurn(t);
    const bob = readyTurn(t);
    const completion = buildCompletion({
      turnId: alice.turnId,
      userId: alice.userId,
      entityId: bob.entityId,
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    expect(() => t.turns.complete(alice.userId, alice.turnId, completion)).toThrow(
      /finding entity owner mismatch/,
    );
    expect(answerRows(t)).toEqual(NOTHING_WRITTEN);
  });

  it('rejects a finding about an entity that does not exist', () => {
    const t = openTestDb();
    const alice = readyTurn(t);
    const completion = buildCompletion({
      turnId: alice.turnId,
      userId: alice.userId,
      entityId: 'ent_missing',
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    expect(() => t.turns.complete(alice.userId, alice.turnId, completion)).toThrow(
      /finding entity owner mismatch/,
    );
  });
});

describe('T-ASR-05: only presented claims can be judged, or used as a baseline', () => {
  function firstAnswerPresented(t: TestDb) {
    const first = completedAnswer(t, { sentences: 2, claimsAt: [0], streamedThrough: 1 });
    t.turns.ack(first.userId, first.turnId, { renderedThrough: 1, complete: true }, T0 + 10);
    const [assertion] = t.assertions.listForMessage(first.userId, first.assistantMessageId);
    if (!assertion) throw new Error('no assertion');
    return { first, assertion };
  }

  it('records a verdict event on a claim the user was actually told, in a later turn', () => {
    const t = openTestDb();
    const { first, assertion } = firstAnswerPresented(t);
    expect(assertion.delivery).toBe('presented');

    const second = readyTurn(t, { userId: first.userId });
    t.clock.advance(5_000);
    t.turns.complete(first.userId, second.turnId, {
      ...buildCompletion({
        turnId: second.turnId,
        userId: first.userId,
        entityId: second.entityId,
        sentences: 1,
        claimsAt: [],
        streamedThrough: 0,
      }),
      baselineEvents: [
        {
          assertionId: assertion.id,
          status: 'superseded_world_changed',
          reason: 'price changed',
          evidenceIds: [],
        },
      ],
    });

    const [reloaded] = t.assertions.listForMessage(first.userId, first.assistantMessageId);
    expect(reloaded?.events.map((e) => [e.status, e.reason, e.turnId])).toEqual([
      ['presented', 'acknowledged', first.turnId],
      ['superseded_world_changed', 'price changed', second.turnId],
    ]);
  });

  it('refuses a verdict on a claim that was streamed but never acknowledged', () => {
    const t = openTestDb();
    const unacknowledged = completedAnswer(t, { sentences: 2, claimsAt: [0], streamedThrough: 1 });
    const [assertion] = t.assertions.listForMessage(
      unacknowledged.userId,
      unacknowledged.assistantMessageId,
    );
    expect(assertion?.delivery).toBe('streamed_unacknowledged');

    const second = readyTurn(t, { userId: unacknowledged.userId });
    const completion: TurnCompletion = {
      ...buildCompletion({
        turnId: second.turnId,
        userId: unacknowledged.userId,
        entityId: second.entityId,
        sentences: 1,
        claimsAt: [],
        streamedThrough: 0,
      }),
      baselineEvents: [
        {
          assertionId: assertion?.id as never,
          status: 'reaffirmed',
          reason: 'same',
          evidenceIds: [],
        },
      ],
    };
    expect(() => t.turns.complete(unacknowledged.userId, second.turnId, completion)).toThrow(
      InvalidCompletionError,
    );
    // the first answer's claim was streamed (no event yet), and the refused completion added none
    expect(answerRows(t).events).toBe(0);
    expect(t.turns.get(unacknowledged.userId, second.turnId)?.status).toBe('running');
  });

  it('refuses a finding whose baseline was never presented', () => {
    const t = openTestDb();
    const unacknowledged = completedAnswer(t, { sentences: 2, claimsAt: [0], streamedThrough: 1 });
    const [assertion] = t.assertions.listForMessage(
      unacknowledged.userId,
      unacknowledged.assistantMessageId,
    );
    const second = readyTurn(t, { userId: unacknowledged.userId });
    const finding = {
      ...buildFinding(second.entityId),
      baseline: {
        value: USD_90,
        presentedAt: T0,
        citations: [],
        assertionId: assertion?.id as never,
      },
    };
    const completion = buildCompletion({
      turnId: second.turnId,
      userId: unacknowledged.userId,
      entityId: second.entityId,
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    expect(() =>
      t.turns.complete(unacknowledged.userId, second.turnId, {
        ...completion,
        findings: completion.findings && { ...completion.findings, findings: [finding] },
      }),
    ).toThrow(/never presented/);
  });

  it('refuses a verdict on another user’s claim, and writes nothing', () => {
    const t = openTestDb();
    const { assertion } = firstAnswerPresented(t);
    const intruder = readyTurn(t);
    const attempt = (turn: ReturnType<typeof readyTurn>, userId: typeof intruder.userId) =>
      t.turns.complete(userId, turn.turnId, {
        ...buildCompletion({
          turnId: turn.turnId,
          userId,
          entityId: turn.entityId,
          sentences: 1,
          claimsAt: [],
          streamedThrough: 0,
        }),
        baselineEvents: [
          { assertionId: assertion.id, status: 'reaffirmed', reason: 'x', evidenceIds: [] },
        ],
      });
    expect(() => attempt(intruder, intruder.userId)).toThrow(InvalidCompletionError);

    expect(answerRows(t).events).toBe(1); // only the first answer's own presented event
    expect(t.turns.get(intruder.userId, intruder.turnId)?.status).toBe('running');
  });

  it('the database itself refuses verdict events on an unpresented claim, whatever the application does', () => {
    const t = openTestDb();
    const unacknowledged = completedAnswer(t, { sentences: 2, claimsAt: [0], streamedThrough: 1 });
    const [assertion] = t.assertions.listForMessage(
      unacknowledged.userId,
      unacknowledged.assistantMessageId,
    );
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO assertion_events (id, assertion_id, status, at) VALUES ('aev_x', ?, 'superseded_world_changed', 1)",
        )
        .run(assertion?.id),
    ).toThrow(/verdict events apply to presented assertions only/);
  });
});
