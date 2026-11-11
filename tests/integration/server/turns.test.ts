import { afterEach, describe, expect, it } from 'vitest';
import type { Components } from '../../../src/app/components.js';
import type { TurnAnalysis } from '../../../src/shared/understanding.js';
import { count } from '../../helpers/db.js';
import { eventNames, parseSse, startTestApp, type TestApp } from './harness.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

/** Holds every analysis until `release()`, so a turn stays running while the test acts. */
function gate() {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    decorate: (c: Components): Components => ({
      ...c,
      analyzer: {
        analyze: async (input, budget): Promise<TurnAnalysis> => {
          await open;
          return c.analyzer.analyze(input, budget);
        },
      },
    }),
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('idempotency', () => {
  it('replays a finished turn for the same key without running it again', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    const first = await u.turn(id, 'What does Acme cost?', 'same-key');
    const again = await u.turn(id, 'What does Acme cost?', 'same-key');
    expect(again.status).toBe(200);
    expect(eventNames(again.events).at(-1)).toBe('turn.completed');
    const completed = (r: typeof first) =>
      r.events.find((e) => e.event === 'answer.completed')?.data as { assistantMessageId: string };
    expect(completed(again).assistantMessageId).toBe(completed(first).assistantMessageId);
    expect(count(t.app.db, 'turns')).toBe(1);
    expect(count(t.app.db, 'messages')).toBe(2);
    // the replay carries the same story, in the same order
    expect(eventNames(again.events)).toEqual(eventNames(first.events));
  });

  it('refuses the same key for a different message', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    await u.turn(id, 'Hello', 'k');
    const res = await u.request('POST', `/api/conversations/${id}/turns`, {
      text: 'Something else',
      idempotencyKey: 'k',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict',
    );
  });

  it('answers 409 to a duplicate key while the first request is still running, then completes it', async () => {
    const g = gate();
    t = await startTestApp({ decorate: g.decorate });
    const u = t.client();
    const id = await u.newConversation();
    const first = u.turn(id, 'Hello', 'dup');
    await until(() => count(t!.app.db, 'turns', "status = 'running'") === 1);

    const dup = await u.request('POST', `/api/conversations/${id}/turns`, {
      text: 'Hello',
      idempotencyKey: 'dup',
    });
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { error: { code: string; turnId: string } };
    expect(body.error.code).toBe('turn_in_progress');
    expect(body.error.turnId).toMatch(/^trn_/);

    // a different key in the same conversation is refused too: one running turn per conversation
    const other = await u.request('POST', `/api/conversations/${id}/turns`, {
      text: 'Another',
      idempotencyKey: 'other',
    });
    expect(other.status).toBe(409);

    g.release();
    const done = await first;
    expect(eventNames(done.events).at(-1)).toBe('turn.completed');
    expect(count(t.app.db, 'messages')).toBe(2);
  });
});

describe('client disconnect and heartbeats', () => {
  it('a client that disconnects mid-stream does not stop the turn: it persists', async () => {
    const g = gate();
    t = await startTestApp({ decorate: g.decorate });
    const u = t.client();
    const id = await u.newConversation();
    const abort = new AbortController();
    const res = await fetch(`${t.base}/api/conversations/${id}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u.cookie! },
      body: JSON.stringify({ text: 'What does Acme cost?', idempotencyKey: 'gone' }),
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value as Uint8Array);
    expect(first).toContain('event: turn.started');
    abort.abort(); // the browser goes away while the turn is still analysing
    await reader.cancel().catch(() => undefined);

    g.release();
    await until(() => count(t!.app.db, 'turns', "status = 'running'") === 0);
    const turn = t.app.db.prepare('SELECT status, assistant_message_id FROM turns').get() as {
      status: string;
      assistant_message_id: string | null;
    };
    expect(turn.status).toBe('complete');
    expect(turn.assistant_message_id).not.toBeNull();
    // nothing was acknowledged by a client that never saw it
    const msg = t.app.db
      .prepare('SELECT streamed_through, rendered_through FROM messages WHERE role = ?')
      .get('assistant') as { streamed_through: number; rendered_through: number };
    expect(msg.streamed_through).toBeGreaterThanOrEqual(0);
    expect(msg.rendered_through).toBe(-1);

    // and the answer is there when the user returns
    const back = await u.json<{
      messages: Array<{ sentences: Array<{ delivery: string }> | null }>;
    }>('GET', `/api/conversations/${id}/messages`);
    const assistant = back.body.messages.find((m) => m.sentences !== null);
    expect(assistant?.sentences?.every((s) => s.delivery === 'streamed_unacknowledged')).toBe(true);
  });

  it('writes heartbeat comments while a turn is quiet', async () => {
    const g = gate();
    t = await startTestApp({ decorate: g.decorate, heartbeatMs: 15 });
    const u = t.client();
    const id = await u.newConversation();
    const res = await fetch(`${t.base}/api/conversations/${id}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: u.cookie! },
      body: JSON.stringify({ text: 'Hello', idempotencyKey: 'hb' }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': heartbeat')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array);
    }
    expect(text).toContain(': heartbeat\n\n');
    g.release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array);
    }
    const { events, comments } = parseSse(text);
    expect(events.at(-1)?.event).toBe('turn.completed');
    expect(comments.length).toBeGreaterThan(0);
  });
});

describe('acknowledgement errors', () => {
  it('maps ack failures: 400 beyond the streamed extent, 400 wrong complete flag, 409 before the answer exists', async () => {
    const g = gate();
    t = await startTestApp({ decorate: g.decorate });
    const u = t.client();
    const id = await u.newConversation();
    const running = u.turn(id, 'Hello', 'k');
    await until(() => count(t!.app.db, 'turns', "status = 'running'") === 1);
    const turnId = (t.app.db.prepare('SELECT id FROM turns').get() as { id: string }).id;

    const early = await u.json<{ error: { code: string } }>('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: 0,
      complete: false,
    });
    expect([early.status, early.body.error.code]).toEqual([409, 'turn_not_finished']);

    g.release();
    const done = await running;
    const completed = done.events.find((e) => e.event === 'answer.completed')?.data as {
      sentences: unknown[];
    };
    const last = completed.sentences.length - 1;

    const beyond = await u.json<{ error: { code: string; reason: string } }>(
      'POST',
      `/api/turns/${turnId}/ack`,
      { renderedThrough: last + 1, complete: false },
    );
    expect([beyond.status, beyond.body.error.code, beyond.body.error.reason]).toEqual([
      400,
      'invalid_ack',
      'beyond_streamed_extent',
    ]);
    const mismatch = await u.json<{ error: { reason: string } }>(
      'POST',
      `/api/turns/${turnId}/ack`,
      {
        renderedThrough: 0,
        complete: true,
      },
    );
    expect([mismatch.status, mismatch.body.error.reason]).toEqual([400, 'complete_flag_mismatch']);

    const malformed = await u.json('POST', `/api/turns/${turnId}/ack`, { renderedThrough: 'x' });
    expect(malformed.status).toBe(400);

    // monotonic: a lower acknowledgement after a higher one changes nothing
    await u.json('POST', `/api/turns/${turnId}/ack`, { renderedThrough: last, complete: true });
    const lower = await u.json('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: 0,
      complete: false,
    });
    expect(lower).toEqual({ status: 200, body: { renderedThrough: last, newlyPresented: 0 } });
  });
});

describe('clarification flow', () => {
  it('offers day options, and choosing one sends it as the next message', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    await u.turn(id, 'Remember this about HubSpot', 'a');
    t.clock.advance(24 * 3600_000);
    await u.turn(id, 'And this about HubSpot', 'b');

    t.clock.advance(7 * 24 * 3600_000); // the week after: both messages are in "last week"
    const ask = await u.turn(id, 'What did I ask last week?', 'c');
    const clar = ask.events.find((e) => e.event === 'clarification')?.data as {
      question: string;
      options: Array<{ label: string; ref: string }>;
    };
    expect(clar.options.map((o) => o.label)).toEqual(['2026-11-11', '2026-11-12']);
    expect((ask.events.at(-1)?.data as { status: string }).status).toBe('clarify');

    // the stored message carries the options for a reload
    const stored = await u.json<{
      messages: Array<{ clarification: { options: unknown[] } | null }>;
    }>('GET', `/api/conversations/${id}/messages`);
    expect(stored.body.messages.at(-1)?.clarification?.options).toHaveLength(2);

    // the choice goes in as an ordinary message
    const chosen = await u.turn(id, clar.options[0]!.label, 'd');
    const text = chosen.events
      .filter((e) => e.event === 'answer.delta')
      .map((e) => (e.data as { text: string }).text)
      .join(' ');
    expect(text).toContain('Remember this about HubSpot');
  });
});

describe('streamed sentences', () => {
  it('delivers each sentence as one whole delta followed by its sentence_end', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    const run = await u.turn(id, 'What does Acme cost?', 'k');
    const seq = run.events.filter(
      (e) => e.event.startsWith('answer.') && e.event !== 'answer.completed',
    );
    seq.forEach((e, i) =>
      expect(e.event).toBe(i % 2 === 0 ? 'answer.delta' : 'answer.sentence_end'),
    );
    const indexes = seq
      .filter((e) => e.event === 'answer.delta')
      .map((e) => (e.data as { sentenceIndex: number }).sentenceIndex);
    expect(indexes).toEqual(indexes.map((_, i) => i));
  });
});
