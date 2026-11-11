import { describe, expect, it } from 'vitest';
import { SqliteMemoryRetriever } from '../../../src/app/memory-adapter.js';
import { LoaderBaselineSource, MessageWindowReader } from '../../../src/app/store-adapters.js';
import type { Db } from '../../../src/db/index.js';
import {
  newId,
  type ConversationId,
  type MessageId,
  type UserId,
} from '../../../src/shared/ids.js';
import { insertEntity, openTestDb, seedConversation, T0 } from '../../helpers/db.js';

function addDecision(
  db: Db,
  p: {
    userId: UserId;
    conversationId: ConversationId;
    messageId: MessageId;
    kind: 'shortlist' | 'constraint' | 'preference' | 'choice';
    payload: object;
    at?: number;
    supersedes?: string;
    version?: number;
  },
): string {
  const id = newId('dec');
  db.prepare(
    `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote,
       version, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'q', ?, ?, ?)`,
  ).run(
    id,
    p.userId,
    p.conversationId,
    p.messageId,
    p.kind,
    JSON.stringify(p.payload),
    p.version ?? 1,
    p.supersedes ?? null,
    p.at ?? T0,
  );
  return id;
}

function setup() {
  const t = openTestDb('real');
  const alice = t.users.create();
  const bob = t.users.create();
  const a = seedConversation(t, alice);
  const b = seedConversation(t, bob);
  return { t, alice, bob, a, b, memory: new SqliteMemoryRetriever(t.db) };
}

const DAY = 24 * 3600_000;
const interval = (startMs: number, endMs: number) => ({
  startMs,
  endMs,
  localDate: 'd',
  tz: 'UTC',
});

describe('SqliteMemoryRetriever.decisions', () => {
  it('returns the user decisions with payload and linked entities, never another user', () => {
    const { t, alice, bob, a, b, memory } = setup();
    const ent = insertEntity(t.db, { userId: alice, norm: 'acme' });
    const mine = addDecision(t.db, {
      userId: alice,
      conversationId: a.conversationId,
      messageId: a.userMessageId,
      kind: 'shortlist',
      payload: { kind: 'shortlist', entities: ['Acme'], label: 'L' },
    });
    t.db
      .prepare('INSERT INTO decision_entities (decision_id, entity_id) VALUES (?, ?)')
      .run(mine, ent);
    addDecision(t.db, {
      userId: bob,
      conversationId: b.conversationId,
      messageId: b.userMessageId,
      kind: 'shortlist',
      payload: { kind: 'shortlist', entities: ['Secret'] },
    });

    const got = memory.decisions(alice, null, null);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: mine,
      payload: { kind: 'shortlist', entities: ['Acme'], label: 'L' },
      entityIds: [ent],
      messageId: a.userMessageId,
      version: 1,
    });
    expect(memory.decisions(bob, null, null)[0]?.payload.entities).toEqual(['Secret']);
  });

  it('filters by kind and by interval, and leaves out a superseded decision', () => {
    const { t, alice, a, memory } = setup();
    const base = { userId: alice, conversationId: a.conversationId, messageId: a.userMessageId };
    const old = addDecision(t.db, {
      ...base,
      kind: 'constraint',
      payload: { kind: 'constraint' },
      at: T0 - 5 * DAY,
    });
    const current = addDecision(t.db, {
      ...base,
      kind: 'constraint',
      payload: { kind: 'constraint', label: 'new' },
      at: T0,
      supersedes: old,
      version: 2,
    });
    addDecision(t.db, { ...base, kind: 'preference', payload: { kind: 'preference' }, at: T0 });

    expect(memory.decisions(alice, 'constraint', null).map((d) => d.id)).toEqual([current]);
    expect(memory.decisions(alice, null, null)).toHaveLength(2);
    expect(memory.decisions(alice, null, [interval(T0 - DAY, T0 + DAY)])).toHaveLength(2);
    expect(memory.decisions(alice, null, [interval(T0 + DAY, T0 + 2 * DAY)])).toEqual([]);
    expect(memory.decisions(alice, null, [])).toEqual([]);
  });

  it('is safe against a hostile kind or interval values (parameterised)', () => {
    const { alice, memory } = setup();
    expect(memory.decisions(alice, "x' OR '1'='1" as never, [interval(0, 1)])).toEqual([]);
  });
});

describe('SqliteMemoryRetriever.entitiesByAlias', () => {
  it('finds an entity by name or alias with aliases, plans and domains, user-scoped', () => {
    const { t, alice, bob, memory } = setup();
    const ent = insertEntity(t.db, { userId: alice, norm: 'hubspot' });
    t.db
      .prepare(
        "INSERT INTO entity_aliases (entity_id, alias_norm, source) VALUES (?, 'hub spot', 'user')",
      )
      .run(ent);
    t.db.prepare("INSERT INTO entity_plans (entity_id, plan_norm) VALUES (?, 'pro')").run(ent);
    t.db
      .prepare(
        "INSERT INTO entity_domains (entity_id, domain, basis) VALUES (?, 'hubspot.com', 'user')",
      )
      .run(ent);
    insertEntity(t.db, { userId: bob, norm: 'hubspot' });

    const byName = memory.entitiesByAlias(alice, ['hubspot']);
    expect(byName).toEqual([
      {
        id: ent,
        name: 'hubspot',
        aliases: ['hub spot'],
        plans: ['pro'],
        officialDomains: ['hubspot.com'],
      },
    ]);
    expect(memory.entitiesByAlias(alice, ['hub spot']).map((e) => e.id)).toEqual([ent]);
    expect(memory.entitiesByAlias(alice, ['unknown'])).toEqual([]);
    expect(memory.entitiesByAlias(alice, [])).toEqual([]);
    // bob's own entity is a different row
    expect(memory.entitiesByAlias(bob, ['hubspot'])[0]?.id).not.toBe(ent);
  });

  it('is safe against hostile input (parameterised)', () => {
    const { alice, memory } = setup();
    expect(memory.entitiesByAlias(alice, ["' OR 1=1 --"])).toEqual([]);
  });
});

describe('message memory is composed in', () => {
  it('finds a stored user message through the message retriever, scoped to the user', () => {
    const { t, alice, bob, memory } = setup();
    const conv = t.conversations.create({ userId: alice });
    const msg = t.messages.insert({
      userId: alice,
      conversationId: conv.id,
      role: 'user',
      content: 'tell me about zebra pricing',
      tz: 'UTC',
    });
    t.db
      .prepare(
        'INSERT INTO message_search (message_id, user_id, created_at, body, tags) VALUES (?, ?, ?, ?, ?)',
      )
      .run(msg.id, alice, msg.createdAt, msg.content, '');
    expect(memory.searchAll(alice, ['zebra'], 5).map((h) => h.messageId)).toEqual([msg.id]);
    expect(memory.searchAll(bob, ['zebra'], 5)).toEqual([]);
  });
});

describe('MessageWindowReader', () => {
  it('returns the latest messages oldest first, without the current one, scoped to the user', () => {
    const { t, alice, bob } = setup();
    const conv = t.conversations.create({ userId: alice });
    const ids: MessageId[] = [];
    for (const [i, role] of (['user', 'user', 'user'] as const).entries()) {
      ids.push(
        t.messages.insert({
          userId: alice,
          conversationId: conv.id,
          role,
          content: `m${i}`,
          tz: 'UTC',
        }).id,
      );
    }
    const reader = new MessageWindowReader(t.messages);
    expect(reader.recent(alice, conv.id, ids[2]!, 5)).toEqual([
      { role: 'user', content: 'm0' },
      { role: 'user', content: 'm1' },
    ]);
    expect(reader.recent(alice, conv.id, ids[2]!, 1)).toEqual([{ role: 'user', content: 'm1' }]);
    expect(reader.recent(alice, conv.id, ids[2]!, 0)).toEqual([]);
    expect(reader.recent(bob, conv.id, ids[2]!, 5)).toEqual([]);
  });
});

describe('LoaderBaselineSource', () => {
  it('returns no eligible baselines and no unverified claims when nothing was presented', () => {
    const { t, alice, a } = setup();
    const source = new LoaderBaselineSource(t.db);
    expect(source.eligible()).toEqual([]);
    expect(
      source.unverified({
        userId: alice,
        currentTurnId: a.turnId,
        conversationIds: [a.conversationId],
      }),
    ).toEqual([]);
  });
});
