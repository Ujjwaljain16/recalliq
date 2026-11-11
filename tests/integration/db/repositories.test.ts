import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/db/index.js';
import type { PersistedSentence } from '../../../src/shared/answer.js';
import { newId } from '../../../src/shared/ids.js';
import { openTestDb, T0 } from '../../helpers/db.js';

describe('UserRepository', () => {
  it('creates users and reports existence', () => {
    const t = openTestDb();
    const id = t.users.create();
    expect(t.users.exists(id)).toBe(true);
    expect(t.users.exists(newId('usr'))).toBe(false);
  });
});

describe('ConversationRepository: user scoping', () => {
  it('returns a conversation only to its owner', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conv = t.conversations.create({ userId: alice, title: 'CRM shortlist' });
    expect(t.conversations.getOwned(alice, conv.id)?.title).toBe('CRM shortlist');
    expect(t.conversations.getOwned(bob, conv.id)).toBeNull();
  });

  it('lists only the caller’s conversations, most recently updated first', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const older = t.conversations.create({ userId: alice });
    t.clock.advance(1000);
    const newer = t.conversations.create({ userId: alice });
    t.conversations.create({ userId: bob });
    expect(t.conversations.listByUser(alice).map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(t.conversations.listByUser(bob)).toHaveLength(1);
  });

  it('uses the injected clock for timestamps', () => {
    const t = openTestDb();
    const conv = t.conversations.create({ userId: t.users.create() });
    expect(conv.createdAt).toBe(T0);
    expect(conv.updatedAt).toBe(T0);
  });
});

describe('MessageRepository', () => {
  it('assigns consecutive seq numbers per conversation, starting at 1', () => {
    const t = openTestDb();
    const user = t.users.create();
    const a = t.conversations.create({ userId: user });
    const b = t.conversations.create({ userId: user });
    const send = (conversationId: typeof a.id, content: string) =>
      t.messages.insert({ userId: user, conversationId, role: 'user', content, tz: 'UTC' });
    expect(send(a.id, 'one').seq).toBe(1);
    expect(send(a.id, 'two').seq).toBe(2);
    expect(send(b.id, 'other').seq).toBe(1);
    expect(t.messages.listByConversation(user, a.id).map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('refuses to write into a conversation the user does not own, without leaking whether it exists', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conv = t.conversations.create({ userId: alice });
    const attempt = (conversationId: typeof conv.id) =>
      t.messages.insert({ userId: bob, conversationId, role: 'user', content: 'x', tz: 'UTC' });
    expect(() => attempt(conv.id)).toThrow(NotFoundError);
    expect(() => attempt(newId('cnv'))).toThrow(NotFoundError);
    expect(t.messages.listByConversation(alice, conv.id)).toEqual([]);
  });

  it('does not show one user’s messages to another', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const conv = t.conversations.create({ userId: alice });
    const message = t.messages.insert({
      userId: alice,
      conversationId: conv.id,
      role: 'user',
      content: 'private',
      tz: 'UTC',
    });
    expect(t.messages.getOwned(bob, message.id)).toBeNull();
    expect(t.messages.listByConversation(bob, conv.id)).toEqual([]);
    expect(t.messages.getOwned(alice, message.id)?.content).toBe('private');
  });

  it('round-trips an assistant message with its sentences and delivery fields', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conv = t.conversations.create({ userId: user });
    const sentences: PersistedSentence[] = [
      {
        index: 0,
        text: 'HubSpot is $90 per user per month [1].',
        template: 'HubSpot is [[F1]].',
        status: 'verified',
        issues: [],
        placeholders: [
          { token: '[[F1]]', findingId: 'fnd_abc', rendered: '$90 per user per month [1]' },
        ],
      },
      {
        index: 1,
        text: 'Partial',
        template: 'Partial',
        status: 'truncated',
        issues: [],
        placeholders: [],
      },
    ];
    const stored = t.messages.insert({
      userId: user,
      conversationId: conv.id,
      role: 'assistant',
      content: sentences.map((s) => s.text).join(' '),
      template: 'HubSpot is [[F1]]. Partial',
      sentences,
      status: 'interrupted',
      streamedThrough: 1,
      tz: 'UTC',
    });
    const read = t.messages.getOwned(user, stored.id);
    expect(read?.sentences).toEqual(sentences);
    expect(read?.status).toBe('interrupted');
    expect(read?.streamedThrough).toBe(1);
    expect(read?.renderedThrough).toBe(-1);
    expect(read?.contentTemplate).toContain('[[F1]]');
  });

  it('validates sentence JSON before writing it', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conv = t.conversations.create({ userId: user });
    const bad = [
      { index: 0, text: 'x', template: 'x', status: 'confirmed', issues: [], placeholders: [] },
    ];
    expect(() =>
      t.messages.insert({
        userId: user,
        conversationId: conv.id,
        role: 'assistant',
        content: 'x',
        template: 'x',
        sentences: bad as unknown as PersistedSentence[],
        status: 'complete',
        streamedThrough: 0,
        tz: 'UTC',
      }),
    ).toThrow();
    expect(t.messages.listByConversation(user, conv.id)).toEqual([]);
  });

  it('bumps the conversation’s updated_at when a message is added', () => {
    const t = openTestDb();
    const user = t.users.create();
    const conv = t.conversations.create({ userId: user });
    t.clock.advance(5000);
    t.messages.insert({
      userId: user,
      conversationId: conv.id,
      role: 'user',
      content: 'hi',
      tz: 'UTC',
    });
    expect(t.conversations.getOwned(user, conv.id)?.updatedAt).toBe(T0 + 5000);
  });
});
