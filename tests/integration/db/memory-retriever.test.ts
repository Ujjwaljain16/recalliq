import { describe, expect, it } from 'vitest';
import {
  SqliteMessageMemory,
  sanitizeTerms,
} from '../../../src/db/repositories/memory-retriever.js';
import type { ConversationId, MessageId, Ms, UserId } from '../../../src/shared/ids.js';
import type { DayInterval } from '../../../src/shared/temporal.js';
import { openTestDb, type TestDb } from '../../helpers/db.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOV3 = Date.UTC(2026, 10, 3);
const NOV4 = NOV3 + DAY;

function day(startMs: Ms, endMs: Ms, localDate: string, tz = 'UTC'): DayInterval {
  return { startMs, endMs, localDate, tz };
}
const nov3 = day(NOV3, NOV4, '2026-11-03');
const nov4 = day(NOV4, NOV4 + DAY, '2026-11-04');

/**
 * Assumed population by the write-time enricher: one message_search row per user message with
 * body = the message text and tags = space-separated normalized entity names (may be empty).
 */
function setup() {
  const t = openTestDb('real');
  const alice = t.users.create();
  const bob = t.users.create();
  const memory = new SqliteMessageMemory(t.db);

  function say(
    userId: UserId,
    at: Ms,
    text: string,
    o: { conversationId?: ConversationId; tags?: string; indexed?: boolean; tz?: string } = {},
  ): { messageId: MessageId; conversationId: ConversationId } {
    t.clock.set(at);
    const conversationId = o.conversationId ?? t.conversations.create({ userId }).id;
    const m = t.messages.insert({
      userId,
      conversationId,
      role: 'user',
      content: text,
      tz: o.tz ?? 'UTC',
    });
    if (o.indexed !== false) index(t, m.id, userId, at, text, o.tags ?? '');
    return { messageId: m.id, conversationId };
  }
  return { t, alice, bob, memory, say };
}

function index(t: TestDb, id: MessageId, userId: UserId, at: Ms, body: string, tags: string): void {
  t.db
    .prepare(
      'INSERT INTO message_search (message_id, user_id, created_at, body, tags) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, userId, at, body, tags);
}

describe('SqliteMessageMemory.messagesInIntervals without terms', () => {
  it('lists every user message in the interval, oldest first, even when unindexed', () => {
    const { alice, memory, say } = setup();
    const b = say(alice, NOV3 + 2 * HOUR, 'second', { indexed: false });
    const a = say(alice, NOV3 + HOUR, 'first');
    say(alice, NOV4 + HOUR, 'next day');
    const got = memory.messagesInIntervals(alice, [nov3], []);
    expect(got.map((c) => c.messageId)).toEqual([a.messageId, b.messageId]);
    expect(got.map((c) => c.excerpt)).toEqual(['first', 'second']);
    expect(got[0]).toMatchObject({ score: 0, matchedTerms: [], intervalIndex: 0, turnId: null });
    expect(got[0]?.localTime).toBe('2026-11-03 01:00');
  });

  it('excludes assistant messages', () => {
    const { t, alice, memory, say } = setup();
    const u = say(alice, NOV3 + HOUR, 'question');
    t.clock.set(NOV3 + 2 * HOUR);
    t.messages.insert({
      userId: alice,
      conversationId: u.conversationId,
      role: 'assistant',
      content: 'answer',
      template: 'answer',
      sentences: [],
      status: 'complete',
      streamedThrough: -1,
      tz: 'UTC',
    });
    expect(memory.messagesInIntervals(alice, [nov3], []).map((c) => c.excerpt)).toEqual([
      'question',
    ]);
  });

  it('treats whitespace-only and punctuation-only terms as no terms, and no intervals as empty', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'hello');
    expect(memory.messagesInIntervals(alice, [nov3], ['', '   ', '*()"'])).toHaveLength(1);
    expect(memory.messagesInIntervals(alice, [], ['hello'])).toEqual([]);
  });

  it('never returns another user’s messages', () => {
    const { alice, bob, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'mine pricing');
    say(bob, NOV3 + 2 * HOUR, 'theirs pricing');
    expect(memory.messagesInIntervals(alice, [nov3], []).map((c) => c.excerpt)).toEqual([
      'mine pricing',
    ]);
    expect(memory.messagesInIntervals(alice, [nov3], ['pricing']).map((c) => c.excerpt)).toEqual([
      'mine pricing',
    ]);
    expect(memory.searchAll(bob, ['pricing'], 8).map((c) => c.excerpt)).toEqual(['theirs pricing']);
  });

  it('does not leak a message whose search row claims another owner', () => {
    const { t, alice, bob, memory, say } = setup();
    const m = say(bob, NOV3 + HOUR, 'bob secret', { indexed: false });
    index(t, m.messageId, alice, NOV3 + HOUR, 'bob secret', '');
    expect(memory.messagesInIntervals(alice, [nov3], ['secret'])).toEqual([]);
    expect(memory.messagesInIntervals(bob, [nov3], ['secret'])).toEqual([]);
  });
});

describe('interval boundaries and DST', () => {
  it('is half-open: start inclusive, end exclusive', () => {
    const { alice, memory, say } = setup();
    const atStart = say(alice, NOV3, 'at start');
    say(alice, NOV3 - 1, 'just before');
    say(alice, NOV4, 'at end');
    const lastMs = say(alice, NOV4 - 1, 'last ms');
    const got = memory.messagesInIntervals(alice, [nov3], []);
    expect(got.map((c) => c.messageId)).toEqual([atStart.messageId, lastMs.messageId]);
    expect(memory.messagesInIntervals(alice, [nov3], ['end']).map((c) => c.excerpt)).toEqual([]);
  });

  it('honours a 23-hour spring-forward day (Europe/London 2026-03-29)', () => {
    const { alice, memory, say } = setup();
    const start = Date.UTC(2026, 2, 29, 0, 0);
    const end = Date.UTC(2026, 2, 29, 23, 0); // local midnight is 23:00Z after the clock change
    const iv = day(start, end, '2026-03-29', 'Europe/London');
    const inside = say(alice, end - 1, 'late evening', { tz: 'Europe/London' });
    say(alice, end, 'already the 30th local', { tz: 'Europe/London' });
    const got = memory.messagesInIntervals(alice, [iv], []);
    expect(got.map((c) => c.messageId)).toEqual([inside.messageId]);
    expect(got[0]?.localTime).toBe('2026-03-29 23:59');
  });

  it('honours a 25-hour fall-back day (Europe/London 2026-10-25)', () => {
    const { alice, memory, say } = setup();
    const start = Date.UTC(2026, 9, 24, 23, 0); // local midnight under BST
    const end = Date.UTC(2026, 9, 26, 0, 0);
    const iv = day(start, end, '2026-10-25', 'Europe/London');
    const lateNight = say(alice, Date.UTC(2026, 9, 25, 23, 30), 'repeat hour', {
      tz: 'Europe/London',
    });
    say(alice, end, 'next day');
    const got = memory.messagesInIntervals(alice, [iv], []);
    expect(got.map((c) => c.messageId)).toEqual([lateNight.messageId]);
    expect(got[0]?.localTime).toBe('2026-10-25 23:30');
  });

  it('formats localTime in the interval tz, not UTC', () => {
    const { alice, memory, say } = setup();
    const start = Date.UTC(2026, 10, 3, 5, 0); // New York midnight (EST, UTC-5)
    const iv = day(start, start + DAY, '2026-11-03', 'America/New_York');
    say(alice, start + 90 * 60_000, 'early');
    expect(memory.messagesInIntervals(alice, [iv], [])[0]?.localTime).toBe('2026-11-03 01:30');
  });

  it('handles two candidate days (last <weekday>) with the right intervalIndex', () => {
    const { alice, memory, say } = setup();
    const a = say(alice, NOV3 + HOUR, 'budget on day one');
    const b = say(alice, NOV4 + HOUR, 'budget on day two');
    say(alice, NOV4 + DAY + HOUR, 'budget on day three');
    const got = memory.messagesInIntervals(alice, [nov3, nov4], ['budget']);
    expect(got).toHaveLength(2);
    const byId = new Map(got.map((c) => [c.messageId, c.intervalIndex]));
    expect(byId.get(a.messageId)).toBe(0);
    expect(byId.get(b.messageId)).toBe(1);
    const none = memory.messagesInIntervals(alice, [nov3, nov4], []);
    expect(none.map((c) => c.intervalIndex)).toEqual([0, 1]);
  });

  it('rejects malformed intervals', () => {
    const { alice, memory } = setup();
    expect(() => memory.messagesInIntervals(alice, [day(NOV4, NOV3, 'x')], [])).toThrow();
    expect(() => memory.messagesInIntervals(alice, [day(NOV3, NOV3, 'x')], [])).toThrow();
    expect(() => memory.messagesInIntervals(alice, [day(NaN, NOV3, 'x')], [])).toThrow();
  });
});

describe('with topic terms', () => {
  it('returns only FTS matches inside the interval, best bm25 first, ties by time then id', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'unrelated chatter');
    const weak = say(alice, NOV3 + 2 * HOUR, 'one mention of notion among many other words here');
    const strong = say(alice, NOV3 + 3 * HOUR, 'notion notion notion');
    say(alice, NOV4 + HOUR, 'notion outside the interval');
    const got = memory.messagesInIntervals(alice, [nov3], ['notion']);
    expect(got.map((c) => c.messageId)).toEqual([strong.messageId, weak.messageId]);
    expect(got[0]?.score).toBeGreaterThan(got[1]?.score ?? Infinity);
    expect(got[0]?.matchedTerms).toEqual(['notion']);
  });

  it('breaks equal scores by createdAt then message id', () => {
    const { alice, memory, say } = setup();
    const later = say(alice, NOV3 + 5 * HOUR, 'airtable pricing');
    const earlier = say(alice, NOV3 + 4 * HOUR, 'airtable pricing');
    const got = memory.messagesInIntervals(alice, [nov3], ['airtable']);
    expect(got.map((c) => c.messageId)).toEqual([earlier.messageId, later.messageId]);
    expect(got[0]?.score).toBe(got[1]?.score);
  });

  it('breaks identical score and timestamp by message id', () => {
    const { alice, memory, say } = setup();
    const ids = Array.from({ length: 7 }, () => say(alice, NOV3 + HOUR, 'zapier plans').messageId);
    const got = memory.messagesInIntervals(alice, [nov3], ['zapier']).map((c) => c.messageId);
    expect(got).toEqual([...ids].sort());
  });

  it('matches stems (porter) and indexed tags', () => {
    const { alice, memory, say } = setup();
    const m = say(alice, NOV3 + HOUR, 'comparing plans', { tags: 'hubspot' });
    expect(memory.messagesInIntervals(alice, [nov3], ['plan']).map((c) => c.messageId)).toEqual([
      m.messageId,
    ]);
    expect(memory.messagesInIntervals(alice, [nov3], ['hubspot'])).toHaveLength(1);
  });

  it('caps results at 8', () => {
    const { alice, memory, say } = setup();
    for (let i = 0; i < 12; i++) say(alice, NOV3 + i * 60_000, `slack pricing ${i}`);
    expect(memory.messagesInIntervals(alice, [nov3], ['slack'])).toHaveLength(8);
    expect(memory.messagesInIntervals(alice, [nov3], [])).toHaveLength(8);
    expect(memory.searchAll(alice, ['slack'], 100)).toHaveLength(8);
    expect(memory.searchAll(alice, ['slack'], 3)).toHaveLength(3);
  });

  it('keeps the cap deterministic: the 8 best, not the 8 first', () => {
    const { alice, memory, say } = setup();
    for (let i = 0; i < 8; i++)
      say(alice, NOV3 + i * 60_000, 'asana mentioned once in a long sentence');
    const best = say(alice, NOV3 + 9 * HOUR, 'asana asana asana');
    const got = memory.messagesInIntervals(alice, [nov3], ['asana']);
    expect(got).toHaveLength(8);
    expect(got[0]?.messageId).toBe(best.messageId);
  });

  it('bounds the excerpt to 300 characters', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, `pricing ${'x'.repeat(2000)}`);
    const [c] = memory.messagesInIntervals(alice, [nov3], ['pricing']);
    expect(Array.from(c?.excerpt ?? '').length).toBe(300);
  });

  it('does not match terms that are absent', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'hello world');
    expect(memory.messagesInIntervals(alice, [nov3], ['missing'])).toEqual([]);
  });

  it('leaves nothing after the conversation is deleted', () => {
    const { t, alice, memory, say } = setup();
    const m = say(alice, NOV3 + HOUR, 'secret roadmap');
    expect(memory.messagesInIntervals(alice, [nov3], ['roadmap'])).toHaveLength(1);
    t.db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(m.conversationId, alice);
    expect(memory.messagesInIntervals(alice, [nov3], ['roadmap'])).toEqual([]);
    expect(memory.messagesInIntervals(alice, [nov3], [])).toEqual([]);
    expect(memory.searchAll(alice, ['roadmap'], 8)).toEqual([]);
  });
});

describe('FTS syntax in terms is inert', () => {
  const hostile = [
    '"',
    '"unterminated',
    'NEAR(a b)',
    'a NEAR b',
    '*',
    'pri*',
    'body:secret',
    '{body tags}: x',
    '(a OR (b',
    'a AND b',
    'a OR b NOT c',
    '^start',
    '-minus',
    "'; DROP TABLE messages; --",
    '\\',
  ];

  it('never throws for hostile input and never lists a message it should not', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'a plain message about pricing');
    for (const term of hostile) {
      expect(() => memory.messagesInIntervals(alice, [nov3], [term])).not.toThrow();
      expect(() => memory.searchAll(alice, [term], 8)).not.toThrow();
    }
    expect(memory.searchAll(alice, ['*'], 8)).toEqual([]);
    expect(memory.searchAll(alice, ['"'], 8)).toEqual([]);
    expect(memory.searchAll(alice, ['pri*'], 8)).toEqual([]);
  });

  it('treats AND, OR, NEAR and NOT as literal words, not operators', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'alpha only');
    say(alice, NOV3 + 2 * HOUR, 'beta only');
    // As operators "alpha AND beta" would match nothing; as literals (OR-ed words) it matches both
    // and "AND" itself appears in no message.
    expect(memory.messagesInIntervals(alice, [nov3], ['alpha AND beta'])).toHaveLength(2);
    say(alice, NOV3 + 3 * HOUR, 'the word near appears here');
    expect(
      memory
        .searchAll(alice, ['NEAR(alpha beta)'], 8)
        .map((c) => c.excerpt)
        .sort(),
    ).toEqual(['alpha only', 'beta only', 'the word near appears here']);
  });

  it('a column-filter style term cannot reach another column or user', () => {
    const { alice, bob, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'nothing here', { tags: 'internal' });
    say(bob, NOV3 + HOUR, 'bob has internal notes', {});
    const got = memory.searchAll(alice, ['tags:internal'], 8);
    expect(got.map((c) => c.excerpt)).toEqual(['nothing here']); // matched as plain words, own rows only
  });

  it('sanitizeTerms keeps only bounded letter/digit tokens', () => {
    expect(sanitizeTerms(['Foo*', 'a:b', '"x y"', '', '  ', 'foo'])).toEqual([
      'foo',
      'a',
      'b',
      'x',
      'y',
    ]);
    expect(sanitizeTerms([])).toEqual([]);
    expect(sanitizeTerms(['z'.repeat(65)])).toEqual([]);
    expect(() => sanitizeTerms(new Array<string>(17).fill('a'))).toThrow();
  });
});

describe('searchAll', () => {
  it('searches all time with intervalIndex -1 and the message tz', () => {
    const { alice, memory, say } = setup();
    const old = say(alice, Date.UTC(2026, 0, 5, 12, 0), 'hubspot cost', { tz: 'Asia/Kolkata' });
    const got = memory.searchAll(alice, ['hubspot'], 5);
    expect(got.map((c) => c.messageId)).toEqual([old.messageId]);
    expect(got[0]?.intervalIndex).toBe(-1);
    expect(got[0]?.localTime).toBe('2026-01-05 17:30');
  });

  it('returns nothing for empty terms or a zero limit, and rejects bad limits', () => {
    const { alice, memory, say } = setup();
    say(alice, NOV3 + HOUR, 'hello');
    expect(memory.searchAll(alice, [], 5)).toEqual([]);
    expect(memory.searchAll(alice, ['  '], 5)).toEqual([]);
    expect(memory.searchAll(alice, ['hello'], 0)).toEqual([]);
    expect(() => memory.searchAll(alice, ['hello'], -1)).toThrow();
    expect(() => memory.searchAll(alice, ['hello'], 1.5)).toThrow();
  });
});
