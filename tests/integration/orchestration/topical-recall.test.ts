import { describe, expect, it } from 'vitest';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { newId, type ConversationId, type Ms, type UserId } from '../../../src/shared/ids.js';
import { insertMessageSearch, openTestDb } from '../../helpers/db.js';
import { analysis, mention } from '../../unit/orchestration/fakes.js';
import { MONDAY, NOW, world } from './scenario-world.js';

const DAY = 24 * 60 * 60_000;
const FERRARI = 'I started the Ferrari model kit last spring and finished the engine bay in May.';
const PORSCHE = 'I began the Porsche 991 Turbo S model in September, after the Ferrari one.';
const ASK = 'Which project did I start first, the Ferrari or the Porsche?';

const topical = (terms: string[], over = {}) =>
  analysis({ laneHint: 'recall', intents: ['general'], topicTerms: terms, ...over });

describe('topical recall: a recall with no day searches all earlier conversations', () => {
  it('quotes the earlier messages by code and hands them to the answer (a)', async () => {
    const w = world(topical(['ferrari', 'porsche']));
    w.message(w.seedConversation(), FERRARI, NOW - 200 * DAY);
    w.message(w.seedConversation(), PORSCHE, NOW - 60 * DAY);
    w.message(
      w.seedConversation(),
      'Which Italian restaurants are open on Sundays?',
      NOW - 30 * DAY,
    );

    const { reply } = await w.ask(ASK);
    expect(w.log).toContain('topical');
    expect(w.log).not.toContain('overview');
    expect(w.log).not.toContain('research');
    expect(reply.startsWith('I found 2 earlier messages about ferrari, porsche:')).toBe(true);
    const recall = [...(w.answer.calls[0]?.recall.values() ?? [])].map((r) => r.text);
    expect(recall).toEqual([FERRARI, PORSCHE]);
    expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([FERRARI, PORSCHE]);
  });

  it('says in code that nothing was found, and does not search the web (b)', async () => {
    const w = world(topical(['ferrari']));
    w.message(w.seedConversation(), 'Which Italian restaurants are open on Sundays?', NOW - DAY);
    const { reply } = await w.ask(ASK);
    expect(reply).toContain(
      "I couldn't find anything about ferrari in your earlier conversations.",
    );
    expect(w.log).toContain('topical');
    expect(w.log).not.toContain('research');
    expect(w.answer.calls).toHaveLength(0);
  });

  it("never returns the turn's own message (d)", async () => {
    const w = world(topical(['ferrari']));
    // nothing else is stored: the question itself mentions the Ferrari but must not answer itself
    const { reply } = await w.ask(ASK);
    expect(reply).toContain("I couldn't find anything about ferrari");
    expect(w.answer.calls).toHaveLength(0);
  });

  it('leaves a dateless recall without topic terms as it was (g)', async () => {
    const w = world(analysis({ laneHint: 'recall', recallScope: 'conversation' }));
    w.message(w.seedConversation(), FERRARI, NOW - DAY);
    const { reply } = await w.ask('What have we talked about so far?');
    expect(w.log).toContain('overview');
    expect(w.log).not.toContain('topical');
    expect(reply).toContain('There is nothing earlier in this conversation yet.');
    expect(reply).toContain('1 earlier conversation');
  });

  it('keeps recall scope "conversation" on this conversation even when terms are present (g)', async () => {
    const w = world(topical(['ferrari'], { recallScope: 'conversation' }));
    await w.ask('What have we talked about so far?');
    expect(w.log).toContain('overview');
    expect(w.log).not.toContain('topical');
  });

  it('leaves a recall with a day on the day lookup (h)', async () => {
    const w = world(
      topical(['crm'], {
        temporal: [
          {
            text: 'Monday',
            expr: { kind: 'weekday', weekday: 1, modifier: 'last' },
            role: 'reference_conversation',
          },
        ],
      }),
    );
    w.seedMonday();
    await w.ask('What did I say about CRM on Monday?');
    expect(w.log).toContain('recall');
    expect(w.log).not.toContain('topical');
    const recall = [...(w.answer.calls[0]?.recall.values() ?? [])].map((r) => r.text);
    expect(recall.join(' ')).toContain('Shortlist for the 20-person sales team');
  });

  it("labels a shown assistant answer as the assistant's earlier answer", async () => {
    const w = world(topical(['ferrari']));
    const conv = w.seedConversation();
    w.t.clock.set(NOW - DAY);
    const m = w.t.messages.insert({
      userId: w.userId,
      conversationId: conv,
      role: 'assistant',
      content: 'Try the Ferrari 250 GTO kit.',
      tz: 'UTC',
      template: 'Try the Ferrari 250 GTO kit.',
      sentences: [
        {
          index: 0,
          text: 'Try the Ferrari 250 GTO kit.',
          template: 'Try the Ferrari 250 GTO kit.',
          status: 'no_claims',
          issues: [],
          placeholders: [],
        },
      ],
      status: 'complete',
      streamedThrough: 0,
    });
    w.t.db
      .prepare('UPDATE messages SET rendered_through = 0, last_ack_at = ? WHERE id = ?')
      .run(NOW - DAY, m.id);
    insertMessageSearch(w.t.db, {
      messageId: m.id,
      userId: w.userId,
      body: 'Try the Ferrari 250 GTO kit.',
    });
    await w.ask('What did you recommend for the Ferrari?');
    const recall = [...(w.answer.calls[0]?.recall.values() ?? [])].map((r) => r.text);
    expect(recall).toEqual(['My earlier answer: Try the Ferrari 250 GTO kit.']);
  });

  it('uses entity names when there are no topic terms', async () => {
    const w = world(topical([], { entities: [mention('CITGO')] }));
    w.message(w.seedConversation(), 'CITGO runs three refineries in the United States.', MONDAY);
    const { reply } = await w.ask('Remind me what I said about CITGO earlier.');
    expect(reply).toContain('I found 1 earlier message about citgo:');
  });
});

describe('topical recall: the retriever', () => {
  function setup() {
    const t = openTestDb('real');
    const alice = t.users.create();
    const bob = t.users.create();
    const memory = new SqliteMessageMemory(t.db);
    const say = (userId: UserId, conv: ConversationId, text: string, at: Ms) => {
      t.clock.set(at);
      const m = t.messages.insert({
        userId,
        conversationId: conv,
        role: 'user',
        content: text,
        tz: 'UTC',
      });
      insertMessageSearch(t.db, { messageId: m.id, userId, body: text });
      return m;
    };
    /** An assistant message of `texts` sentences, of which those up to `shown` were acknowledged. */
    const reply = (
      userId: UserId,
      conv: ConversationId,
      texts: string[],
      shown: number,
      at: Ms,
    ) => {
      t.clock.set(at);
      const m = t.messages.insert({
        userId,
        conversationId: conv,
        role: 'assistant',
        content: texts.join(' '),
        tz: 'UTC',
        template: texts.join(' '),
        sentences: texts.map((text, index) => ({
          index,
          text,
          template: text,
          status: 'no_claims' as const,
          issues: [],
          placeholders: [],
        })),
        status: 'complete',
        streamedThrough: texts.length - 1,
      });
      if (shown >= 0) {
        t.db
          .prepare('UPDATE messages SET rendered_through = ?, last_ack_at = ? WHERE id = ?')
          .run(shown, at, m.id);
      }
      insertMessageSearch(t.db, { messageId: m.id, userId, body: texts.join(' ') });
      return m;
    };
    const opts = (over = {}) => ({
      excludeTurn: newId('trn'),
      limit: 8,
      tz: 'UTC',
      roles: 'both' as const,
      ...over,
    });
    return { t, alice, bob, memory, say, reply, opts };
  }

  it("never returns another user's messages (c)", () => {
    const { t, alice, bob, memory, say, opts } = setup();
    say(bob, t.conversations.create({ userId: bob }).id, 'Bob restores a Ferrari.', NOW - DAY);
    say(
      alice,
      t.conversations.create({ userId: alice }).id,
      'Alice builds a Ferrari kit.',
      NOW - DAY,
    );
    const mine = memory.topicalRecall(alice, ['ferrari'], opts());
    expect(mine.map((h) => h.excerpt)).toEqual(['Alice builds a Ferrari kit.']);
    expect(memory.topicalRecall(bob, ['ferrari'], opts()).map((h) => h.excerpt)).toEqual([
      'Bob restores a Ferrari.',
    ]);
  });

  it('leaves out the message of the excluded turn (d)', () => {
    const { t, alice, memory, say, opts } = setup();
    const conv = t.conversations.create({ userId: alice }).id;
    const turn = newId('trn');
    say(alice, conv, 'old Ferrari note', NOW - DAY);
    t.clock.set(NOW);
    const own = t.messages.insert({
      userId: alice,
      conversationId: conv,
      role: 'user',
      content: 'which Ferrari note',
      tz: 'UTC',
      turnId: turn,
    });
    insertMessageSearch(t.db, { messageId: own.id, userId: alice, body: 'which Ferrari note' });
    const hits = memory.topicalRecall(alice, ['ferrari'], opts({ excludeTurn: turn }));
    expect(hits.map((h) => h.excerpt)).toEqual(['old Ferrari note']);
  });

  it('returns only the assistant sentences the user was shown (e)', () => {
    const { t, alice, memory, reply, opts } = setup();
    const conv = t.conversations.create({ userId: alice }).id;
    reply(
      alice,
      conv,
      ['I recommend the Ferrari 250 GTO kit.', 'Secret Ferrari sentence never shown.'],
      0,
      NOW - 2 * DAY,
    );
    reply(alice, conv, ['Ferrari advice that was never acknowledged.'], -1, NOW - DAY);
    const hits = memory.topicalRecall(alice, ['ferrari'], opts());
    expect(hits.map((h) => [h.role, h.excerpt])).toEqual([
      ['assistant', 'I recommend the Ferrari 250 GTO kit.'],
    ]);
    // text only the undelivered sentence matches: no hit at all
    expect(memory.topicalRecall(alice, ['secret'], opts())).toEqual([]);
    // the role filter is configurable
    expect(memory.topicalRecall(alice, ['ferrari'], opts({ roles: 'user' }))).toEqual([]);
  });

  it('takes the best matches, caps at 8, and presents them oldest first; hostile syntax is harmless (f)', () => {
    const { t, alice, memory, say, opts } = setup();
    const conv = t.conversations.create({ userId: alice }).id;
    for (let i = 0; i < 12; i++) {
      say(alice, conv, `note ${i} about the Ferrari ${'filler '.repeat(i)}`, NOW - (20 - i) * DAY);
    }
    say(alice, conv, 'Ferrari Ferrari Ferrari', NOW - 100 * DAY);
    const hits = memory.topicalRecall(alice, ['ferrari'], opts());
    expect(hits).toHaveLength(8);
    const times = hits.map((h) => h.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(hits[0]?.excerpt).toBe('Ferrari Ferrari Ferrari');
    const hostile = [
      '"ferrari" NEAR(a b) *',
      'ferrari" OR "',
      'AND NOT (',
      'body:ferrari',
      '^ferrari',
    ];
    expect(() => memory.topicalRecall(alice, hostile, opts())).not.toThrow();
    expect(memory.topicalRecall(alice, hostile, opts()).length).toBeGreaterThan(0);
    expect(memory.topicalRecall(alice, ['"', '*', 'NEAR('], opts())).toEqual([]);
  });

  it('quotes up to 600 characters of a message', () => {
    const { t, alice, memory, say, opts } = setup();
    const long = `ferrari ${'word '.repeat(200)}`;
    say(alice, t.conversations.create({ userId: alice }).id, long, NOW - DAY);
    const [hit] = memory.topicalRecall(alice, ['ferrari'], opts());
    expect(Array.from(hit?.excerpt ?? '').length).toBe(600);
  });
});
