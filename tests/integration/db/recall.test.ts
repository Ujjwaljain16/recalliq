import { describe, expect, it } from 'vitest';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { resolveRecall } from '../../../src/memory/recall.js';
import type { ConversationId, Ms, UserId } from '../../../src/shared/ids.js';
import type { TemporalExpression } from '../../../src/shared/understanding.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { openTestDb } from '../../helpers/db.js';

const HOUR = 3_600_000;
// Wednesday 11 November 2026, 15:00 UTC
const NOW = Date.UTC(2026, 10, 11, 15);

function setup() {
  const t = openTestDb('real');
  const alice = t.users.create();
  const bob = t.users.create();
  const deps = { resolver: new DefaultTemporalResolver(), memory: new SqliteMessageMemory(t.db) };

  function say(userId: UserId, at: Ms, text: string, conversationId?: ConversationId) {
    t.clock.set(at);
    const conv = conversationId ?? t.conversations.create({ userId }).id;
    const m = t.messages.insert({
      userId,
      conversationId: conv,
      role: 'user',
      content: text,
      tz: 'UTC',
    });
    t.db
      .prepare(
        'INSERT INTO message_search (message_id, user_id, created_at, body, tags) VALUES (?, ?, ?, ?, ?)',
      )
      .run(m.id, userId, at, text, '');
    return { conversationId: conv, messageId: m.id };
  }

  function ask(userId: UserId, expr: TemporalExpression, topicTerms: string[] = [], tz = 'UTC') {
    return resolveRecall(deps, {
      userId,
      mentions: [{ text: JSON.stringify(expr), expr, role: 'reference_conversation' }],
      topicTerms,
      tz,
      now: NOW,
    });
  }
  return { t, alice, bob, deps, say, ask };
}

const tuesdayLast: TemporalExpression = { kind: 'weekday', weekday: 2, modifier: 'last' };

describe('recall lane: answer, clarify or no record', () => {
  it('one match on a resolved day is an answer that states the resolved date', () => {
    const { alice, say, ask } = setup();
    const m = say(alice, Date.UTC(2026, 10, 10, 9), 'which crm should we pick');
    const out = ask(alice, { kind: 'yesterday' });
    expect(out.kind).toBe('answer');
    if (out.kind !== 'answer') return;
    expect(out.localDate).toBe('2026-11-10');
    expect(out.conversationIds).toEqual([m.conversationId]);
    expect(out.hits.map((h) => h.messageId)).toEqual([m.messageId]);
    expect(out.truncated).toBe(false);
  });

  it('with no topic terms every user message of the day is listed, across conversations, with no question', () => {
    const { alice, say, ask } = setup();
    say(alice, Date.UTC(2026, 10, 10, 9), 'first topic');
    say(alice, Date.UTC(2026, 10, 10, 10), 'second topic');
    const out = ask(alice, { kind: 'yesterday' });
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.hits).toHaveLength(2);
  });

  it('nothing stored is an honest "none", naming the dates searched', () => {
    const { alice, ask } = setup();
    const out = ask(alice, { kind: 'yesterday' }, ['pricing']);
    expect(out).toEqual({ kind: 'none', localDates: ['2026-11-10'], searchedTerms: ['pricing'] });
  });

  it('last Tuesday: data on only one of the two candidate days decides', () => {
    const { alice, say, ask } = setup();
    say(alice, Date.UTC(2026, 10, 3, 9), 'pricing of acme'); // the Tuesday a week earlier
    const out = ask(alice, tuesdayLast, ['pricing']);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.localDate).toBe('2026-11-03');
  });

  it('last Tuesday: matches on both candidate days is a question, never a pick', () => {
    const { alice, say, ask } = setup();
    say(alice, Date.UTC(2026, 10, 10, 9), 'pricing of acme');
    say(alice, Date.UTC(2026, 10, 3, 9), 'pricing of globex');
    const out = ask(alice, tuesdayLast, ['pricing']);
    expect(out.kind).toBe('clarify');
    if (out.kind !== 'clarify') return;
    expect(out.reason).toBe('ambiguous_day');
    expect(out.options.map((o) => o.ref)).toEqual(['day:2026-11-10', 'day:2026-11-03']);
  });

  it('with topic terms, two matching conversations on the day is a question', () => {
    const { alice, say, ask } = setup();
    say(alice, Date.UTC(2026, 10, 10, 9), 'pricing of acme');
    say(alice, Date.UTC(2026, 10, 10, 11), 'pricing of globex');
    const out = ask(alice, { kind: 'yesterday' }, ['pricing']);
    expect(out.kind).toBe('clarify');
    if (out.kind !== 'clarify') return;
    expect(out.reason).toBe('ambiguous_conversation');
    expect(out.options).toHaveLength(2);
    expect(out.options.every((o) => o.ref.startsWith('conv:'))).toBe(true);
  });

  it('two matching messages in the same conversation are one answer, not a question', () => {
    const { alice, say, ask } = setup();
    const a = say(alice, Date.UTC(2026, 10, 10, 9), 'pricing of acme');
    say(alice, Date.UTC(2026, 10, 10, 10), 'pricing again', a.conversationId);
    const out = ask(alice, { kind: 'yesterday' }, ['pricing']);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.conversationIds).toEqual([a.conversationId]);
  });

  it("another user's messages are never recalled", () => {
    const { alice, bob, say, ask } = setup();
    say(bob, Date.UTC(2026, 10, 10, 9), 'pricing of acme');
    expect(ask(alice, { kind: 'yesterday' }, ['pricing']).kind).toBe('none');
    expect(ask(alice, { kind: 'yesterday' }).kind).toBe('none');
  });

  it('a date that cannot be worked out is a question about the date', () => {
    const { alice, ask } = setup();
    const out = ask(alice, { kind: 'calendar_date', day: 31, month: 2 });
    expect(out.kind).toBe('clarify');
    if (out.kind === 'clarify') expect(out.reason).toBe('unresolved_date');
  });

  it('no date mention at all asks which day', () => {
    const { alice, deps } = setup();
    const out = resolveRecall(deps, {
      userId: alice,
      mentions: [],
      topicTerms: [],
      tz: 'UTC',
      now: NOW,
    });
    expect(out).toMatchObject({ kind: 'clarify', reason: 'no_date' });
  });

  it("the user's time zone decides which messages belong to the day", () => {
    const { alice, say, ask } = setup();
    // NOW is already 12 Nov in Tokyo, so Tokyo's "yesterday" is 11 Nov and 08:00 UTC on 10 Nov is not in it.
    say(alice, Date.UTC(2026, 10, 10, 8), 'morning message');
    expect(ask(alice, { kind: 'yesterday' }, [], 'UTC').kind).toBe('answer');
    expect(ask(alice, { kind: 'yesterday' }, [], 'Asia/Tokyo').kind).toBe('none');
  });

  it('reports truncation when the retriever returned its maximum', () => {
    const { alice, say, ask } = setup();
    for (let i = 0; i < 9; i += 1) say(alice, Date.UTC(2026, 10, 10, i + 1), `message ${i}`);
    const out = ask(alice, { kind: 'yesterday' });
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      expect(out.hits).toHaveLength(8);
      expect(out.truncated).toBe(true);
    }
    expect(HOUR).toBe(3_600_000);
  });
});
