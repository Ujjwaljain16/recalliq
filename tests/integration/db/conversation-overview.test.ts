import { describe, expect, it } from 'vitest';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import {
  newId,
  type ConversationId,
  type Ms,
  type TurnId,
  type UserId,
} from '../../../src/shared/ids.js';
import { openTestDb } from '../../helpers/db.js';

const MINUTE = 60_000;
// Thursday 12 November 2026, 10:00 UTC
const NOW: Ms = Date.UTC(2026, 10, 12, 10);

function setup() {
  const t = openTestDb('real');
  const alice = t.users.create();
  const bob = t.users.create();
  const memory = new SqliteMessageMemory(t.db);
  const say = (
    userId: UserId,
    conversationId: ConversationId,
    at: Ms,
    text: string,
    turnId: TurnId = newId('trn'),
  ) => {
    t.clock.set(at);
    return t.messages.insert({
      userId,
      conversationId,
      role: 'user',
      content: text,
      tz: 'UTC',
      turnId,
    });
  };
  const reply = (userId: UserId, conversationId: ConversationId, at: Ms, text: string) => {
    t.clock.set(at);
    t.messages.insert({
      userId,
      conversationId,
      role: 'assistant',
      content: text,
      tz: 'UTC',
      template: text,
      sentences: [],
      status: 'complete',
      streamedThrough: -1,
    });
  };
  return { t, alice, bob, memory, say, reply };
}

describe('conversation overview: the user messages of one conversation', () => {
  it('returns the latest user messages oldest first, leaves out the current turn and assistant messages', () => {
    const { t, alice, memory, say, reply } = setup();
    const conv = t.conversations.create({ userId: alice }).id;
    say(alice, conv, NOW - 30 * MINUTE, 'first');
    reply(alice, conv, NOW - 29 * MINUTE, 'an answer');
    say(alice, conv, NOW - 20 * MINUTE, 'second');
    say(alice, conv, NOW - 10 * MINUTE, 'third');
    const current = newId('trn');
    say(alice, conv, NOW, 'what have we talked about?', current);

    const out = memory.conversationOverview(alice, conv, current, NOW, 8, 'Europe/London');
    expect(out.hits.map((h) => h.excerpt)).toEqual(['first', 'second', 'third']);
    expect(out.total).toBe(3);
    expect(out.otherConversations).toBe(0);
    expect(out.hits[0]?.localTime).toBe('2026-11-12 09:30');

    const limited = memory.conversationOverview(alice, conv, current, NOW, 2, 'UTC');
    expect(limited.hits.map((h) => h.excerpt)).toEqual(['second', 'third']);
    expect(limited.total).toBe(3);
  });

  it("counts the user's other conversations, never another user's, and nothing after the turn started", () => {
    const { t, alice, bob, memory, say } = setup();
    const conv = t.conversations.create({ userId: alice }).id;
    const other = t.conversations.create({ userId: alice }).id;
    const later = t.conversations.create({ userId: alice }).id;
    const bobs = t.conversations.create({ userId: bob }).id;
    say(alice, other, NOW - 2 * 24 * 60 * MINUTE, 'older question');
    say(alice, later, NOW + MINUTE, 'written after this turn started');
    say(bob, bobs, NOW - MINUTE, 'not yours');

    const out = memory.conversationOverview(alice, conv, newId('trn'), NOW, 8, 'UTC');
    expect(out).toEqual({ hits: [], total: 0, otherConversations: 1 });
    expect(memory.conversationOverview(bob, conv, newId('trn'), NOW, 8, 'UTC').hits).toEqual([]);
  });
});
