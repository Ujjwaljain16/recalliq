import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  initializeDatabase,
  InvalidTransitionError,
  NotFoundError,
  openDatabase,
  TurnInProgressError,
  TurnNotFinishedError,
} from '../../../src/db/index.js';
import { violatesOneRunningTurn } from '../../../src/db/repositories/turns.js';
import { newId, type TurnId, type UserId } from '../../../src/shared/ids.js';
import {
  canTransition,
  isFinalState,
  TURN_STATES,
  TURN_TRANSITIONS,
} from '../../../src/shared/turn-state-machine.js';
import type { TurnState } from '../../../src/shared/turn.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import {
  count,
  insertTurn,
  openTestDb,
  reposFor,
  seedConversation,
  T0,
  type TestDb,
} from '../../helpers/db.js';
import { advance, buildCompletion, completedAnswer, startTurn } from '../../helpers/turns.js';
import { insertEntity } from '../../helpers/db.js';

/** Shortest path from RECEIVED to `target` in the state machine. */
function pathTo(target: TurnState): TurnState[] {
  const queue: TurnState[][] = [['RECEIVED']];
  const seen = new Set<TurnState>(['RECEIVED']);
  while (queue.length > 0) {
    const route = queue.shift();
    if (!route) break;
    const last = route[route.length - 1] as TurnState;
    if (last === target) return route.slice(1);
    for (const next of TURN_TRANSITIONS[last]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...route, next]);
      }
    }
  }
  throw new Error(`${target} is unreachable`);
}

/** Writes `state` straight to the row, finishing the turn when the state is final (as migration 004 requires). */
function rawSetState(t: TestDb, turnId: TurnId, state: TurnState): void {
  if (isFinalState(state)) {
    t.db
      .prepare('UPDATE turns SET state = ?, status = ?, finished_at = ? WHERE id = ?')
      .run(state, state === 'COMPLETED' ? 'complete' : 'failed', T0 + 1, turnId);
  } else {
    t.db.prepare('UPDATE turns SET state = ? WHERE id = ?').run(state, turnId);
  }
}

function turnInState(t: TestDb, state: TurnState): TurnId {
  const user = t.users.create();
  const { conversationId, userMessageId } = seedConversation(t, user);
  const turnId = insertTurn(t.db, {
    conversationId,
    userId: user,
    userMessageId,
    status: 'running',
  });
  for (const step of pathTo(state)) rawSetState(t, turnId, step);
  return turnId;
}

describe('T-TRN-01: the database enforces the state machine, and agrees with the TypeScript table', () => {
  it('accepts exactly the 19 edges and rejects every other ordered pair (182 probes)', () => {
    const t = openTestDb();
    let accepted = 0;
    let rejected = 0;
    for (const from of TURN_STATES) {
      for (const to of TURN_STATES) {
        if (from === to) continue;
        const turnId = turnInState(t, from);
        let ok = true;
        try {
          rawSetState(t, turnId, to);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/invalid turn state transition|already finished/.test(error.message)
          ) {
            throw error;
          }
          ok = false;
        }
        expect(ok, `${from} -> ${to}`).toBe(canTransition(from, to));
        if (ok) accepted += 1;
        else rejected += 1;
      }
    }
    expect(accepted).toBe(19);
    expect(rejected).toBe(182 - 19);
  });

  it('rejects a state value that is not part of the state machine', () => {
    const t = openTestDb();
    const turnId = turnInState(t, 'RECEIVED');
    expect(() =>
      t.db.prepare("UPDATE turns SET state = 'TELEPORTED' WHERE id = ?").run(turnId),
    ).toThrow(/invalid turn state transition/);
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO turns (id, conversation_id, user_id, user_message_id, idempotency_key, state, status, deadline_at, started_at)
           VALUES (?, ?, ?, ?, ?, 'TELEPORTED', 'running', 1, 1)`,
        )
        .run(newId('trn'), conversationId, user, userMessageId, newId('trn')),
    ).toThrow(/invalid turn state|invalid new turn/);
  });
});

describe('T-TRN-02: finished turns are final, and turn rows keep their shape', () => {
  it('a finished turn cannot change status, state or results', () => {
    const t = openTestDb();
    const { userId, turnId } = completedAnswer(t, {
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    for (const sql of [
      "UPDATE turns SET status = 'running' WHERE id = ?",
      "UPDATE turns SET status = 'failed' WHERE id = ?",
      "UPDATE turns SET state = 'FAILED' WHERE id = ?",
      "UPDATE turns SET error_code = 'late' WHERE id = ?",
      "UPDATE turns SET metrics_json = '{}' WHERE id = ?",
      'UPDATE turns SET finished_at = 1 WHERE id = ?',
      "UPDATE turns SET lane = 'audit' WHERE id = ?",
    ]) {
      // several triggers overlap on a finished turn (finality, state/status coupling, the transition table); every one of these updates must be refused by one of them
      expect(() => t.db.prepare(sql).run(turnId), sql).toThrow(
        /already finished|cannot be in a final state|invalid turn state transition/,
      );
    }
    expect(t.turns.get(userId, turnId)?.status).toBe('complete');
  });

  it('turn identity can never change (owner, conversation, key, start, deadline)', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const { turnId } = seedConversation(t, alice);
    for (const sql of [
      'UPDATE turns SET user_id = ? WHERE id = ?',
      'UPDATE turns SET conversation_id = ? WHERE id = ?',
      "UPDATE turns SET idempotency_key = 'other' WHERE id = ? AND ? IS NOT NULL",
      'UPDATE turns SET started_at = 5 WHERE id = ? AND ? IS NOT NULL',
      'UPDATE turns SET deadline_at = 5 WHERE id = ? AND ? IS NOT NULL',
    ]) {
      const params =
        sql.includes('user_id') || sql.includes('conversation_id') ? [bob, turnId] : [turnId, bob];
      expect(() => t.db.prepare(sql).run(...params), sql).toThrow(/identity is immutable/);
    }
  });

  it('a running turn cannot be in a final state, and a finished turn needs a finish time', () => {
    const t = openTestDb();
    const turnId = turnInState(t, 'PERSISTING');
    expect(() =>
      t.db.prepare("UPDATE turns SET state = 'COMPLETED' WHERE id = ?").run(turnId),
    ).toThrow(/running turn cannot be in a final state/);
    expect(() =>
      t.db.prepare("UPDATE turns SET status = 'complete' WHERE id = ?").run(turnId),
    ).toThrow(/needs finished_at/);
  });

  it('a new turn must start running in RECEIVED, or already be finished with a finish time', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    const insert = (state: string, status: string, finishedAt: number | null) =>
      t.db
        .prepare(
          `INSERT INTO turns (id, conversation_id, user_id, user_message_id, idempotency_key, state, status, deadline_at, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
        )
        .run(
          newId('trn'),
          conversationId,
          user,
          userMessageId,
          newId('trn'),
          state,
          status,
          finishedAt,
        );
    expect(() => insert('SEARCHING', 'running', null)).toThrow(/invalid new turn/);
    expect(() => insert('RECEIVED', 'running', 5)).toThrow(/invalid new turn/);
    expect(() => insert('COMPLETED', 'complete', null)).toThrow(/invalid new turn/);
    expect(() => insert('RECEIVED', 'running', null)).not.toThrow();
  });

  it('at most one turn per conversation is running, enforced by the database', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    insertTurn(t.db, { conversationId, userId: user, userMessageId, status: 'running' });
    expect(() =>
      insertTurn(t.db, { conversationId, userId: user, userMessageId, status: 'running' }),
    ).toThrow(/UNIQUE constraint failed: turns.conversation_id/);
    // a different conversation is unaffected
    const other = seedConversation(t, user);
    expect(() =>
      insertTurn(t.db, {
        conversationId: other.conversationId,
        userId: user,
        userMessageId: other.userMessageId,
        status: 'running',
      }),
    ).not.toThrow();
  });
});

describe('violatesOneRunningTurn recognises the real SQLite error, and only that one', () => {
  function capture(run: () => void): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error('expected the statement to fail');
  }

  it('matches the one-running-turn violation and not the idempotency-key violation', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    insertTurn(t.db, {
      conversationId,
      userId: user,
      userMessageId,
      status: 'running',
      idempotencyKey: 'dup',
    });

    const runningViolation = capture(() =>
      insertTurn(t.db, { conversationId, userId: user, userMessageId, status: 'running' }),
    );
    const idempotencyViolation = capture(() =>
      insertTurn(t.db, {
        conversationId,
        userId: user,
        userMessageId,
        status: 'complete',
        idempotencyKey: 'dup',
      }),
    );
    expect(violatesOneRunningTurn(runningViolation)).toBe(true);
    expect(violatesOneRunningTurn(idempotencyViolation)).toBe(false);
    expect(
      violatesOneRunningTurn(new Error('UNIQUE constraint failed: turns.conversation_id')),
    ).toBe(false); // no SQLite code
    expect(violatesOneRunningTurn('nope')).toBe(false);
  });
});

describe('T-TRN-03: TurnRepository.setState validates every transition', () => {
  it('walks a research turn through the full path', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    const route: TurnState[] = [
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'PLANNING',
      'SEARCHING',
      'EXTRACTING',
      'VERIFYING',
      'SEARCHING', // fallback round
      'EXTRACTING',
      'VERIFYING',
      'RESOLVING_BELIEFS',
      'SYNTHESIZING',
      'POST_VERIFYING',
      'PERSISTING',
    ];
    for (const state of route) {
      t.turns.setState(user, turnId, state);
      expect(t.turns.get(user, turnId)?.state).toBe(state);
    }
  });

  it('rejects a jump, a skipped state, a self-transition and a step backwards', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    expect(() => t.turns.setState(user, turnId, 'SEARCHING')).toThrow(InvalidTransitionError);
    expect(() => t.turns.setState(user, turnId, 'RECEIVED')).toThrow(InvalidTransitionError);
    t.turns.setState(user, turnId, 'ANALYZING');
    expect(() => t.turns.setState(user, turnId, 'ANALYZING')).toThrow(InvalidTransitionError);
    expect(() => t.turns.setState(user, turnId, 'RECEIVED')).toThrow(InvalidTransitionError);
    // none of the refused attempts moved the turn
    expect(t.turns.get(user, turnId)?.state).toBe('ANALYZING');
  });

  it('reaches PERSISTING early only through the two documented shortcuts', () => {
    const t = openTestDb();
    const user = t.users.create();
    const c1 = t.conversations.create({ userId: user });
    const outage = startTurn(t, user, c1.id);
    t.turns.setState(user, outage.turnId, 'ANALYZING');
    expect(() => t.turns.setState(user, outage.turnId, 'PERSISTING')).not.toThrow(); // LLM outage

    const c2 = t.conversations.create({ userId: user });
    const midway = startTurn(t, user, c2.id);
    advance(t, user, midway.turnId, ['ANALYZING', 'RESOLVING_CONTEXT', 'PLANNING', 'SEARCHING']);
    expect(() => t.turns.setState(user, midway.turnId, 'PERSISTING')).toThrow(
      InvalidTransitionError,
    );
  });

  it('refuses final states: only complete() and fail() set them', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    advance(t, user, turnId);
    expect(() => t.turns.setState(user, turnId, 'COMPLETED')).toThrow(/complete\(\) or fail\(\)/);
    expect(() => t.turns.setState(user, turnId, 'FAILED')).toThrow(/complete\(\) or fail\(\)/);
    expect(t.turns.get(user, turnId)?.state).toBe('PERSISTING');
  });

  it('refuses any change to a finished turn', () => {
    const t = openTestDb();
    const { userId, turnId } = completedAnswer(t, {
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });
    expect(() => t.turns.setState(userId, turnId, 'ANALYZING')).toThrow(/already complete/);
  });

  it('is scoped to the owner, and unknown turns are not found', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conversation = t.conversations.create({ userId: alice });
    const { turnId } = startTurn(t, alice, conversation.id);
    expect(() => t.turns.setState(bob, turnId, 'ANALYZING')).toThrow(NotFoundError);
    expect(() => t.turns.setState(alice, newId('trn'), 'ANALYZING')).toThrow(NotFoundError);
    expect(t.turns.get(alice, turnId)?.state).toBe('RECEIVED');
  });

  it('fail() is only valid from PERSISTING, and records a distinct FAILED outcome', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    expect(() => t.turns.fail(user, turnId, 'db_unavailable')).toThrow(InvalidTransitionError);
    advance(t, user, turnId);
    t.turns.fail(user, turnId, 'db_unavailable');
    const turn = t.turns.get(user, turnId);
    expect(turn).toMatchObject({ state: 'FAILED', status: 'failed', errorCode: 'db_unavailable' });
    expect(turn?.finishedAt).toBe(T0);
  });
});

describe('T-TRN-04: TurnRepository.begin', () => {
  it('creates a running turn in RECEIVED together with its user message, linked both ways', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId, userMessageId } = startTurn(t, user, conversation.id, { text: 'Hello there' });
    const turn = t.turns.get(user, turnId);
    expect(turn).toMatchObject({
      state: 'RECEIVED',
      status: 'running',
      userMessageId,
      assistantMessageId: null,
      startedAt: T0,
      deadlineAt: T0 + 60_000,
      finishedAt: null,
    });
    const message = t.messages.getOwned(user, userMessageId);
    expect(message).toMatchObject({
      role: 'user',
      content: 'Hello there',
      turnId,
      tz: 'Europe/London',
      seq: 1,
    });
  });

  it('returns the existing turn for a repeated idempotency key, without creating anything', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const first = startTurn(t, user, conversation.id, { key: 'send-1', text: 'Hi' });
    const request = {
      userId: user,
      conversationId: conversation.id,
      text: 'Hi',
      tz: 'Europe/London',
      idempotencyKey: 'send-1',
    };

    expect(t.turns.begin(request, T0 + 5, T0 + 60_005)).toEqual({
      existing: first.turnId,
      status: 'running',
    });
    expect(count(t.db, 'turns')).toBe(1);
    expect(count(t.db, 'messages')).toBe(1);

    // still the same answer once the turn has finished
    advance(t, user, first.turnId);
    const entityId = insertEntity(t.db, { userId: user, norm: 'x' });
    t.turns.complete(
      user,
      first.turnId,
      buildCompletion({
        turnId: first.turnId,
        userId: user,
        entityId,
        sentences: 1,
        claimsAt: [],
        streamedThrough: 0,
      }),
    );
    expect(t.turns.begin(request, T0 + 9, T0 + 60_009)).toEqual({
      existing: first.turnId,
      status: 'complete',
    });
    expect(count(t.db, 'turns')).toBe(1);
  });

  it('refuses to reuse an idempotency key for a different request', () => {
    const t = openTestDb();
    const user = t.users.create();
    const c1 = t.conversations.create({ userId: user });
    const c2 = t.conversations.create({ userId: user });
    startTurn(t, user, c1.id, { key: 'k', text: 'original' });
    const base = { userId: user, tz: 'UTC', idempotencyKey: 'k' };
    expect(() =>
      t.turns.begin({ ...base, conversationId: c1.id, text: 'different' }, T0, T0 + 1),
    ).toThrow(IdempotencyConflictError);
    expect(() =>
      t.turns.begin({ ...base, conversationId: c2.id, text: 'original' }, T0, T0 + 1),
    ).toThrow(IdempotencyConflictError);
    expect(count(t.db, 'turns')).toBe(1);
  });

  it('scopes idempotency keys per user', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const a = startTurn(t, alice, t.conversations.create({ userId: alice }).id, { key: 'same' });
    const b = startTurn(t, bob, t.conversations.create({ userId: bob }).id, { key: 'same' });
    expect(a.turnId).not.toBe(b.turnId);
  });

  it('refuses a second turn while one is running (Q-006), and allows one once it has finished', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const first = startTurn(t, user, conversation.id, { key: 'a' });
    const attempt = () => startTurn(t, user, conversation.id, { key: 'b' });
    expect(attempt).toThrow(TurnInProgressError);
    try {
      attempt();
    } catch (error) {
      expect((error as TurnInProgressError).existingTurnId).toBe(first.turnId);
    }
    expect(count(t.db, 'turns')).toBe(1);
    expect(count(t.db, 'messages')).toBe(1); // nothing left behind by the refused attempt

    t.turns.recoverRunning(T0 + 10);
    expect(() => startTurn(t, user, conversation.id, { key: 'c' })).not.toThrow();
  });

  it('only creates a retry of a turn that exists in the same conversation for the same user', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conversation = t.conversations.create({ userId: alice });
    const other = t.conversations.create({ userId: alice });
    const original = startTurn(t, alice, conversation.id);
    t.turns.recoverRunning(T0 + 1);

    const retry = startTurn(t, alice, conversation.id, { retryOfTurnId: original.turnId });
    expect(t.turns.get(alice, retry.turnId)?.retryOfTurnId).toBe(original.turnId);

    expect(() => startTurn(t, alice, conversation.id, { retryOfTurnId: newId('trn') })).toThrow(
      NotFoundError,
    );
    expect(() => startTurn(t, alice, other.id, { retryOfTurnId: original.turnId })).toThrow(
      NotFoundError,
    );
    const bobsConversation = t.conversations.create({ userId: bob });
    expect(() =>
      startTurn(t, bob, bobsConversation.id, { retryOfTurnId: original.turnId }),
    ).toThrow(NotFoundError);
  });

  it('does not let a user start a turn in someone else’s conversation, or leave anything behind', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conversation = t.conversations.create({ userId: alice });
    expect(() => startTurn(t, bob, conversation.id)).toThrow(NotFoundError);
    expect(() => startTurn(t, bob, `cnv_${'0'.repeat(8)}`)).toThrow(NotFoundError);
    expect(count(t.db, 'turns')).toBe(0);
    expect(count(t.db, 'messages')).toBe(0);
  });

  it('validates untrusted input at the boundary', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const valid = {
      userId: user,
      conversationId: conversation.id,
      text: 'hi',
      tz: 'UTC',
      idempotencyKey: 'k',
    };
    const attempt = (patch: object) => t.turns.begin({ ...valid, ...patch }, T0, T0 + 1);
    expect(() => attempt({ text: '' })).toThrow();
    expect(() => attempt({ text: 'x'.repeat(4001) })).toThrow();
    expect(() => attempt({ idempotencyKey: '' })).toThrow();
    expect(() => attempt({ idempotencyKey: 'k'.repeat(129) })).toThrow();
    expect(() => attempt({ tz: '' })).toThrow();
    expect(() => attempt({ userId: 'not-an-id' })).toThrow();
    expect(() => attempt({ conversationId: 'not-an-id' })).toThrow();
    expect(count(t.db, 'turns')).toBe(0);
    expect(() => attempt({ text: 'x'.repeat(4000) })).not.toThrow();
  });
});

describe('T-TRN-05: recovery of running turns', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-recover-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks every running turn interrupted, keeps its state, and touches nothing else', () => {
    const t = openTestDb();
    const user = t.users.create();
    const searching = startTurn(t, user, t.conversations.create({ userId: user }).id);
    advance(t, user, searching.turnId, ['ANALYZING', 'RESOLVING_CONTEXT', 'PLANNING', 'SEARCHING']);
    const fresh = startTurn(t, user, t.conversations.create({ userId: user }).id);
    const done = completedAnswer(t, {
      userId: user,
      sentences: 1,
      claimsAt: [],
      streamedThrough: 0,
    });

    expect(t.turns.recoverRunning(T0 + 500)).toBe(2);

    expect(t.turns.get(user, searching.turnId)).toMatchObject({
      status: 'interrupted',
      state: 'SEARCHING',
      errorCode: 'recovered_after_restart',
      finishedAt: T0 + 500,
      assistantMessageId: null,
    });
    expect(t.turns.get(user, fresh.turnId)).toMatchObject({
      status: 'interrupted',
      state: 'RECEIVED',
    });
    expect(t.turns.get(user, done.turnId)).toMatchObject({
      status: 'complete',
      state: 'COMPLETED',
    });
  });

  it('is idempotent', () => {
    const t = openTestDb();
    const user = t.users.create();
    startTurn(t, user, t.conversations.create({ userId: user }).id);
    expect(t.turns.recoverRunning(T0 + 1)).toBe(1);
    expect(t.turns.recoverRunning(T0 + 2)).toBe(0);
  });

  it('invents no answer, no acknowledgement, no presented claim and no baseline', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    advance(t, user, turnId, ['ANALYZING', 'RESOLVING_CONTEXT', 'SYNTHESIZING']);

    t.turns.recoverRunning(T0 + 1);

    expect(count(t.db, 'messages', "role = 'assistant'")).toBe(0);
    expect(count(t.db, 'assertions')).toBe(0);
    expect(count(t.db, 'assertion_events')).toBe(0);
    expect(count(t.db, 'findings')).toBe(0);
    expect(count(t.db, 'messages', 'rendered_through <> -1')).toBe(0);
    expect(count(t.db, 'messages', 'last_ack_at IS NOT NULL')).toBe(0);
    // and there is nothing to acknowledge for the recovered turn
    expect(() =>
      t.turns.ack(user, turnId, { renderedThrough: 0, complete: false }, T0 + 2),
    ).toThrow(TurnNotFinishedError);
  });

  it('leaves a recovered turn final: it cannot be resumed or completed', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { turnId } = startTurn(t, user, t.conversations.create({ userId: user }).id);
    advance(t, user, turnId);
    t.turns.recoverRunning(T0 + 1);
    const entityId = insertEntity(t.db, { userId: user, norm: 'x' });
    expect(() => t.turns.setState(user, turnId, 'ANALYZING')).toThrow(InvalidTransitionError);
    expect(() =>
      t.turns.complete(
        user,
        turnId,
        buildCompletion({
          turnId,
          userId: user,
          entityId,
          sentences: 1,
          claimsAt: [],
          streamedThrough: 0,
        }),
      ),
    ).toThrow(InvalidTransitionError);
    expect(t.turns.get(user, turnId)?.status).toBe('interrupted');
  });

  it('survives a process restart: a new connection recovers what the old one left running', () => {
    const file = path.join(dir, 'restart.db');
    const clock = new FixedClock(T0);

    // "first process": starts a turn, gets partway, and dies without closing cleanly
    const first = openDatabase(file);
    initializeDatabase(first, { mode: 'real', clock });
    const before = reposFor(first, clock);
    const user: UserId = before.users.create();
    const conversation = before.conversations.create({ userId: user });
    const started = before.turns.begin(
      {
        userId: user,
        conversationId: conversation.id,
        text: 'Has HubSpot changed?',
        tz: 'UTC',
        idempotencyKey: 'send-1',
      },
      T0,
      T0 + 60_000,
    );
    if ('existing' in started) throw new Error('unexpected');
    for (const state of ['ANALYZING', 'RESOLVING_CONTEXT', 'PLANNING', 'SEARCHING'] as const) {
      before.turns.setState(user, started.turnId, state);
    }
    first.close();

    // "second process": reopens the file and recovers on boot
    const second = openDatabase(file);
    initializeDatabase(second, { mode: 'real', clock });
    const after = reposFor(second, clock);
    expect(after.turns.get(user, started.turnId)?.status).toBe('running'); // what the crash left behind
    expect(after.turns.recoverRunning(T0 + 90_000)).toBe(1);
    expect(after.turns.get(user, started.turnId)).toMatchObject({
      status: 'interrupted',
      state: 'SEARCHING',
    });

    // the conversation is usable again, and the client can retry the interrupted turn
    const retry = after.turns.begin(
      {
        userId: user,
        conversationId: conversation.id,
        text: 'Has HubSpot changed?',
        tz: 'UTC',
        idempotencyKey: 'send-2',
        retryOfTurnId: started.turnId,
      },
      T0 + 91_000,
      T0 + 151_000,
    );
    expect('turnId' in retry).toBe(true);
    // the same send, retried by the same client, still resolves to the interrupted turn
    expect(
      after.turns.begin(
        {
          userId: user,
          conversationId: conversation.id,
          text: 'Has HubSpot changed?',
          tz: 'UTC',
          idempotencyKey: 'send-1',
        },
        T0 + 92_000,
        T0 + 152_000,
      ),
    ).toEqual({ existing: started.turnId, status: 'interrupted' });
    second.close();
  });
});
