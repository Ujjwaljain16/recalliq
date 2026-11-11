import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Components } from '../../../src/app/components.js';
import type { TurnBudget } from '../../../src/shared/infrastructure.js';
import { startTestApp, type TestApp } from './harness.js';

let t: TestApp | undefined;
let dir: string | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('graceful shutdown', () => {
  it('lets a running turn finish and persist, stops accepting, and closes the database last', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-shutdown-'));
    const dbPath = path.join(dir, 'app.db');
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let budget: TurnBudget | undefined;
    t = await startTestApp({
      dbPath,
      decorate: (c: Components): Components => ({
        ...c,
        analyzer: {
          analyze: async (input, b) => {
            budget = b;
            await open;
            return c.analyzer.analyze(input, b);
          },
        },
      }),
    });
    const u = t.client();
    const id = await u.newConversation();
    const res = await fetch(`${t.base}/api/conversations/${id}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u.cookie! },
      body: JSON.stringify({ text: 'What does Acme cost?', idempotencyKey: 'sd' }),
    });
    expect(res.status).toBe(200); // headers are sent with turn.started: the turn is running

    const stopping = t.app.stop();
    // the shutdown signal reached the turn's budget, which is what lets components stop early
    expect(budget?.signal.aborted).toBe(true);

    release();
    const body = await res.text();
    expect(body).toContain('event: turn.completed');
    expect(body).toContain('event: answer.completed');
    expect(await stopping).toEqual({ drained: true });

    // the server no longer accepts connections
    await expect(fetch(`${t.base}/api/health`)).rejects.toThrow();

    // the turn is stored as finished, with its answer, in the database file
    const db = new Database(dbPath, { readonly: true });
    try {
      const turn = db.prepare('SELECT status, state, assistant_message_id FROM turns').get() as {
        status: string;
        state: string;
        assistant_message_id: string | null;
      };
      expect(turn.status).toBe('complete');
      expect(turn.state).toBe('COMPLETED');
      expect(turn.assistant_message_id).not.toBeNull();
    } finally {
      db.close();
    }
    expect(t.app.db.open).toBe(false);
  });

  it('is safe to call twice', async () => {
    t = await startTestApp();
    const a = t.app.stop();
    const b = t.app.stop();
    expect(await a).toEqual(await b);
  });

  it('marks a turn left running by a crash as interrupted on the next start, unblocking its conversation', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-recover-'));
    const dbPath = path.join(dir, 'app.db');
    t = await startTestApp({ dbPath });
    const u = t.client();
    const id = await u.newConversation();
    // simulate a crash: a running turn that no process owns
    t.app.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, status, tz, origin, created_at)
         SELECT 'msg_crash', ?, user_id, 1, 'user', 'lost', 'complete', 'UTC', 'live', 1 FROM conversations WHERE id = ?`,
      )
      .run(id, id);
    t.app.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, user_id, user_message_id, idempotency_key, state, status, deadline_at, started_at)
         SELECT 'trn_crash', ?, user_id, 'msg_crash', 'crash-key', 'RECEIVED', 'running', 2, 1 FROM conversations WHERE id = ?`,
      )
      .run(id, id);
    await t.app.stop();

    t = await startTestApp({ dbPath });
    const row = t.app.db.prepare("SELECT status FROM turns WHERE id = 'trn_crash'").get() as {
      status: string;
    };
    expect(row.status).toBe('interrupted');
  });
});
