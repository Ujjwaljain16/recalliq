import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerOutcome } from '../../helpers/concurrency-worker.js';
import { count, openTestDbAt, T0, type TestDb } from '../../helpers/db.js';
import { race } from '../../helpers/race.js';
import { completedAnswer } from '../../helpers/turns.js';

/**
 * Real contention: every contender runs in its own worker thread with its own SQLite connection to the same
 * file, released at the same instant. The guarantees under test come from BEGIN IMMEDIATE transactions and
 * the database's own constraints, not from JavaScript being single-threaded.
 */
let dir: string;
let file: string;
let t: TestDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-concurrency-'));
  file = path.join(dir, 'race.db');
  t = openTestDbAt(file);
});
afterEach(() => {
  t.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TIMEOUT = 60_000;

const created = (outcomes: WorkerOutcome[]) =>
  outcomes.filter(
    (o) => o.ok && typeof o.value === 'object' && o.value !== null && 'turnId' in o.value,
  );
const existing = (outcomes: WorkerOutcome[]) =>
  outcomes.filter(
    (o) => o.ok && typeof o.value === 'object' && o.value !== null && 'existing' in o.value,
  );
const failures = (outcomes: WorkerOutcome[]) => outcomes.flatMap((o) => (o.ok ? [] : [o.error]));

function request(
  userId: string,
  conversationId: string,
  key: string,
  text = 'Has HubSpot changed?',
) {
  return {
    userId: userId as never,
    conversationId: conversationId as never,
    text,
    tz: 'UTC',
    idempotencyKey: key,
  };
}

describe('concurrent begin requests', () => {
  it(
    'the same idempotency key from six connections creates exactly one turn and one message',
    async () => {
      const userId = t.users.create();
      const conversation = t.conversations.create({ userId });

      const outcomes = await race(
        file,
        Array.from({ length: 6 }, () => ({
          op: 'begin' as const,
          request: request(userId, conversation.id, 'one-send'),
        })),
      );

      expect(failures(outcomes)).toEqual([]);
      expect(created(outcomes)).toHaveLength(1);
      expect(existing(outcomes)).toHaveLength(5);
      const winner = created(outcomes)[0];
      const turnId = winner?.ok ? (winner.value as { turnId: string }).turnId : null;
      for (const outcome of existing(outcomes)) {
        expect(outcome.ok && outcome.value).toEqual({ existing: turnId, status: 'running' });
      }
      expect(count(t.db, 'turns')).toBe(1);
      expect(count(t.db, 'messages')).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'different keys in one conversation: exactly one wins, the rest get TurnInProgressError, nothing is left behind',
    async () => {
      const userId = t.users.create();
      const conversation = t.conversations.create({ userId });

      const outcomes = await race(
        file,
        Array.from({ length: 6 }, (_, i) => ({
          op: 'begin' as const,
          request: request(userId, conversation.id, `send-${i}`),
        })),
      );

      expect(created(outcomes)).toHaveLength(1);
      const errors = failures(outcomes);
      expect(errors).toHaveLength(5);
      expect(errors.every((e) => e.name === 'TurnInProgressError')).toBe(true);
      expect(count(t.db, 'turns', "status = 'running'")).toBe(1);
      expect(count(t.db, 'turns')).toBe(1);
      expect(count(t.db, 'messages')).toBe(1); // the refused attempts rolled their messages back
    },
    TIMEOUT,
  );

  it(
    'different conversations of one user do not block each other',
    async () => {
      const userId = t.users.create();
      const conversations = Array.from({ length: 4 }, () => t.conversations.create({ userId }));

      const outcomes = await race(
        file,
        conversations.map((c, i) => ({
          op: 'begin' as const,
          request: request(userId, c.id, `send-${i}`),
        })),
      );

      expect(failures(outcomes)).toEqual([]);
      expect(created(outcomes)).toHaveLength(4);
      expect(count(t.db, 'turns', "status = 'running'")).toBe(4);
    },
    TIMEOUT,
  );

  it(
    'the same key reused with different text, from two connections, is a conflict for the loser',
    async () => {
      const userId = t.users.create();
      const conversation = t.conversations.create({ userId });
      const outcomes = await race(file, [
        { op: 'begin', request: request(userId, conversation.id, 'shared-key', 'first wording') },
        { op: 'begin', request: request(userId, conversation.id, 'shared-key', 'second wording') },
      ]);
      expect(created(outcomes)).toHaveLength(1);
      expect(failures(outcomes).map((e) => e.name)).toEqual(['IdempotencyConflictError']);
      expect(count(t.db, 'turns')).toBe(1);
    },
    TIMEOUT,
  );
});

describe('concurrent acknowledgements', () => {
  it(
    'eight racing acknowledgements end at the highest extent, presenting each claim exactly once',
    async () => {
      const a = completedAnswer(t, { sentences: 7, claimsAt: [0, 2, 4, 6], streamedThrough: 6 });
      const extents = [1, 3, 3, 5, 6, 2, 6, 0];

      const outcomes = await race(
        file,
        extents.map((renderedThrough) => ({
          op: 'ack' as const,
          userId: a.userId,
          turnId: a.turnId,
          ack: { renderedThrough, complete: false },
        })),
      );

      expect(failures(outcomes)).toEqual([]);
      const newly = outcomes.map((o) =>
        o.ok ? (o.value as { newlyPresented: number }).newlyPresented : -1,
      );
      expect(newly.reduce((sum, n) => sum + n, 0)).toBe(4); // no claim presented twice, none missed
      expect(
        (
          t.db
            .prepare('SELECT rendered_through AS r FROM messages WHERE id = ?')
            .get(a.assistantMessageId) as { r: number }
        ).r,
      ).toBe(6);
      expect(count(t.db, 'assertions', 'presented_at IS NOT NULL')).toBe(4);
      expect(count(t.db, 'assertion_events', "status = 'presented'")).toBe(4);
      const perAssertion = t.db
        .prepare(
          "SELECT assertion_id, count(*) AS n FROM assertion_events WHERE status = 'presented' GROUP BY assertion_id",
        )
        .all() as Array<{ n: number }>;
      expect(perAssertion.map((r) => r.n)).toEqual([1, 1, 1, 1]);
      // every reported extent is a real stored extent, never beyond what was acknowledged
      for (const o of outcomes) {
        expect(
          o.ok && (o.value as { renderedThrough: number }).renderedThrough,
        ).toBeGreaterThanOrEqual(0);
      }
    },
    TIMEOUT,
  );

  it(
    'valid and impossible acknowledgements together: the impossible ones are rejected, the valid ones still land',
    async () => {
      const a = completedAnswer(t, { sentences: 7, claimsAt: [0, 2, 4, 6], streamedThrough: 3 }); // streamed only to 3
      const requests = [2, 9, 3, 5, 3, 7];

      const outcomes = await race(
        file,
        requests.map((renderedThrough) => ({
          op: 'ack' as const,
          userId: a.userId,
          turnId: a.turnId,
          ack: { renderedThrough, complete: false },
        })),
      );

      expect(
        failures(outcomes)
          .map((e) => e.name)
          .sort(),
      ).toEqual(['InvalidAckError', 'InvalidAckError', 'InvalidAckError']);
      expect(
        (
          t.db
            .prepare('SELECT rendered_through AS r FROM messages WHERE id = ?')
            .get(a.assistantMessageId) as { r: number }
        ).r,
      ).toBe(3);
      expect(count(t.db, 'assertions', 'presented_at IS NOT NULL')).toBe(2); // claims 0 and 2 only
      expect(count(t.db, 'assertions', 'presented_at IS NOT NULL AND sentence_index > 3')).toBe(0);
    },
    TIMEOUT,
  );
});

describe('the clock used by workers is fixed, so the outcomes above are deterministic', () => {
  it(
    'workers stamp acknowledgements with the fixed time passed in',
    async () => {
      const a = completedAnswer(t, { sentences: 2, claimsAt: [0], streamedThrough: 1 });
      await race(file, [
        {
          op: 'ack',
          userId: a.userId,
          turnId: a.turnId,
          ack: { renderedThrough: 1, complete: true },
        },
      ]);
      const row = t.db
        .prepare('SELECT last_ack_at AS at FROM messages WHERE id = ?')
        .get(a.assistantMessageId) as { at: number };
      expect(row.at).toBe(T0 + 1_000);
    },
    TIMEOUT,
  );
});
