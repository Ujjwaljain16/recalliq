import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLongMemEval } from '../../../scripts/bench/datasets.js';
import { MESSAGE_SPACING_MS, seedLongMemHistory, soleUserId } from '../../../scripts/bench/seed.js';
import {
  initializeDatabase,
  openDatabase,
  UserRepository,
  type Db,
} from '../../../src/db/index.js';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { parseId } from '../../../src/shared/ids.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { LONGMEMEVAL_JSON } from './fixtures.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-seed-'));
  db = openDatabase(path.join(dir, 'seed.db'));
  initializeDatabase(db, { mode: 'real', clock: new FixedClock(Date.UTC(2023, 0, 1)) });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LongMemEval seeding', () => {
  it('stores every session as a conversation with its messages at the haystack times', () => {
    const userId = new UserRepository(db, new FixedClock(Date.UTC(2023, 0, 1))).create();
    expect(soleUserId(db)).toBe(userId);
    const item = parseLongMemEval(LONGMEMEVAL_JSON)[0];
    if (item === undefined) throw new Error('fixture');
    const summary = seedLongMemHistory(db, userId, item);
    expect(summary).toMatchObject({ conversations: 2, userMessages: 2, assistantMessages: 2 });

    const rows = db
      .prepare(
        `SELECT m.role, m.seq, m.created_at, m.rendered_through, m.streamed_through, c.created_at AS conv_at
           FROM messages m JOIN conversations c ON c.id = m.conversation_id ORDER BY m.created_at`,
      )
      .all() as Array<Record<string, number | string>>;
    const may18 = Date.UTC(2023, 4, 18, 16, 30);
    const may20 = Date.UTC(2023, 4, 20, 10, 0);
    expect(rows.map((r) => [r['role'], r['seq'], r['created_at']])).toEqual([
      ['user', 1, may18],
      ['assistant', 2, may18 + MESSAGE_SPACING_MS],
      ['user', 1, may20],
      ['assistant', 2, may20 + MESSAGE_SPACING_MS],
    ]);
    // Assistant replies count as shown to the user; user messages have no streamed extent.
    expect(rows.filter((r) => r['role'] === 'assistant').map((r) => r['rendered_through'])).toEqual(
      [0, 0],
    );
    expect(rows.filter((r) => r['role'] === 'user').map((r) => r['streamed_through'])).toEqual([
      null,
      null,
    ]);
  });

  it("indexes the messages so the application's full-text recall finds them", () => {
    const userId = new UserRepository(db, new FixedClock(Date.UTC(2023, 0, 1))).create();
    const item = parseLongMemEval(LONGMEMEVAL_JSON)[0];
    if (item === undefined) throw new Error('fixture');
    seedLongMemHistory(db, userId, item);

    const memory = new SqliteMessageMemory(db);
    const user = parseId('usr', userId);
    const hits = memory.searchAll(user, ['sourdough'], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.createdAt).toBe(Date.UTC(2023, 4, 20, 10, 0));

    const inDay = memory.messagesInIntervals(
      user,
      [
        {
          startMs: Date.UTC(2023, 4, 20),
          endMs: Date.UTC(2023, 4, 21),
          localDate: '2023-05-20',
          tz: 'UTC',
        },
      ],
      ['rye'],
    );
    expect(inDay.map((h) => h.excerpt)).toEqual([expect.stringContaining('rye flour')]);

    // Assistant replies are indexed too (the application's recall reads only user messages, by design).
    const fts = db
      .prepare(
        `SELECT m.role FROM message_fts JOIN message_search ms ON ms.rowid = message_fts.rowid
           JOIN messages m ON m.id = ms.message_id WHERE message_fts MATCH ?`,
      )
      .all('marmalade') as Array<{ role: string }>;
    expect(fts).toEqual([{ role: 'assistant' }]);
  });

  it('is refused by the database for a user that does not own the conversation rows', () => {
    const item = parseLongMemEval(LONGMEMEVAL_JSON)[0];
    if (item === undefined) throw new Error('fixture');
    expect(() => seedLongMemHistory(db, 'usr_missing', item)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });
});
