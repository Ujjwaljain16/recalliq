import { afterEach, describe, expect, it } from 'vitest';
import { eventNames, startTestApp, type TestApp } from './harness.js';

/**
 * A real user interaction over HTTP: real server on an ephemeral port, real SQLite and migrations, the real
 * orchestrator, and the SCRIPTED components. It proves the application surface (routing, streaming,
 * acknowledgement, scoping), not that research works.
 */

let t: TestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

interface MessagesBody {
  messages: Array<{
    role: string;
    content: string;
    turnId: string | null;
    streamedThrough: number | null;
    renderedThrough: number;
    sentences: Array<{ index: number; delivery: string; status: string; text: string }> | null;
    sources: Array<{ n: number; url: string }>;
  }>;
}

describe('a full user journey', () => {
  it('creates a conversation, streams a research answer, acknowledges it, reloads it, and recalls it', async () => {
    t = await startTestApp();
    const user = t.client();
    const conversationId = await user.newConversation();
    expect(user.cookie).toMatch(/^recalliq_session=usr_/);

    const first = await user.turn(conversationId, 'What does HubSpot cost?', 'k-1');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const names = eventNames(first.events);
    expect(names[0]).toBe('turn.started');
    expect(names.at(-1)).toBe('turn.completed');
    // ordering guarantees: source and finding before the deltas, sentence_end after its deltas, completed last
    const at = (n: string) => names.indexOf(n);
    expect(at('finding')).toBeLessThan(at('answer.delta'));
    expect(at('answer.delta')).toBeLessThan(at('answer.sentence_end'));
    expect(at('answer.completed')).toBeGreaterThan(names.lastIndexOf('answer.sentence_end'));
    expect(at('answer.completed')).toBeLessThan(at('turn.completed'));
    // ids are increasing integers
    expect(first.events.map((e) => Number(e.id))).toEqual(first.events.map((_, i) => i + 1));

    const completed = first.events.find((e) => e.event === 'answer.completed')?.data as {
      assistantMessageId: string;
      sentences: unknown[];
      citations: string[];
    };
    expect(completed.sentences.length).toBeGreaterThanOrEqual(2);
    expect(completed.citations).toHaveLength(1);
    const turnId = (first.events[0]?.data as { turnId: string }).turnId;

    // before any acknowledgement the sentences were streamed but not presented
    const before = await user.json<MessagesBody>(
      'GET',
      `/api/conversations/${conversationId}/messages`,
    );
    const assistantBefore = before.body.messages.find((m) => m.role === 'assistant');
    expect(assistantBefore?.sentences?.map((s) => s.delivery)).toEqual(
      completed.sentences.map(() => 'streamed_unacknowledged'),
    );
    expect(assistantBefore?.sources).toHaveLength(1);
    expect(assistantBefore?.sources[0]?.url).toContain('scripted.example');

    // acknowledge the first sentence only: that sentence is presented, the rest are not
    const partial = await user.json('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: 0,
      complete: false,
    });
    expect(partial).toEqual({ status: 200, body: { renderedThrough: 0, newlyPresented: 1 } });
    const last = completed.sentences.length - 1;
    const full = await user.json('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: last,
      complete: true,
    });
    expect(full.status).toBe(200);
    // idempotent: the same acknowledgement again changes nothing
    const again = await user.json('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: last,
      complete: true,
    });
    expect(again.body).toEqual({ renderedThrough: last, newlyPresented: 0 });

    const after = await user.json<MessagesBody>(
      'GET',
      `/api/conversations/${conversationId}/messages`,
    );
    const assistant = after.body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.renderedThrough).toBe(last);
    expect(new Set(assistant?.sentences?.map((s) => s.delivery))).toEqual(new Set(['presented']));
    expect(after.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // the next day: a recall question finds the earlier message
    t.clock.advance(24 * 60 * 60 * 1000);
    const recall = await user.turn(
      conversationId,
      'What did I ask yesterday about HubSpot?',
      'k-2',
    );
    expect(recall.status).toBe(200);
    const context = recall.events.find((e) => e.event === 'context')?.data as {
      lane: string;
      memoryHits: Array<{ excerpt: string }>;
    };
    expect(context.lane).toBe('recall');
    expect(context.memoryHits.map((h) => h.excerpt)).toContain('What does HubSpot cost?');
    const deltas = recall.events
      .filter((e) => e.event === 'answer.delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(deltas).toContain('"What does HubSpot cost?" (Wed 11 Nov, 10:00)');

    // the conversation list shows it, newest first
    const list = await user.json<{ conversations: Array<{ id: string; preview: string }> }>(
      'GET',
      '/api/conversations',
    );
    expect(list.body.conversations[0]).toMatchObject({
      id: conversationId,
      preview: 'What does HubSpot cost?',
    });
  });

  it('shows an unable_to_verify finding as a partial turn with an honest sentence', async () => {
    t = await startTestApp();
    const user = t.client();
    const conversationId = await user.newConversation();
    const res = await user.turn(
      conversationId,
      'What does Zeta cost? The search is offline.',
      'k-1',
    );
    const names = eventNames(res.events);
    expect(names).toContain('warning');
    const text = res.events
      .filter((e) => e.event === 'answer.delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text).toContain("couldn't be checked this time (search unavailable)");
    expect((res.events.at(-1)?.data as { status: string }).status).toBe('partial');
  });

  it('answers small talk, and asks which day when a recall has no date', async () => {
    t = await startTestApp();
    const user = t.client();
    const conversationId = await user.newConversation();
    const hello = await user.turn(conversationId, 'Hello there', 'k-1');
    expect((hello.events.at(-1)?.data as { status: string }).status).toBe('complete');
    const clarify = await user.turn(conversationId, 'What did I ask?', 'k-2');
    expect(eventNames(clarify.events)).toContain('clarification');
    expect((clarify.events.at(-1)?.data as { status: string }).status).toBe('clarify');
  });
});
