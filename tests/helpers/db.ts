import type { AppMode } from '../../src/config/env.js';
import {
  AssertionRepository,
  ConversationRepository,
  IN_MEMORY,
  initializeDatabase,
  loadMigrations,
  MessageRepository,
  openDatabase,
  SqliteTurnRepository,
  UserRepository,
  type BeliefRebuilder,
  type Db,
} from '../../src/db/index.js';
import type { PersistedSentence } from '../../src/shared/answer.js';
import {
  newId,
  type AssertionId,
  type ConversationId,
  type EntityId,
  type EvidenceId,
  type FindingId,
  type MessageId,
  type Ms,
  type SnapshotId,
  type TurnId,
  type UserId,
} from '../../src/shared/ids.js';
import { FixedClock } from '../../src/temporal/clock.js';

/** 2026-11-11T10:00:00Z, the date this project was designed on. */
export const T0: Ms = Date.UTC(2026, 10, 11, 10, 0, 0);

export interface TestDb {
  db: Db;
  clock: FixedClock;
  users: UserRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  turns: SqliteTurnRepository;
  assertions: AssertionRepository;
}

/** Stands in for the belief resolver, which does not exist until milestone 4. */
export const noopRebuilder: BeliefRebuilder = {
  rebuild() {
    /* nothing to rebuild: no beliefs are written yet */
  },
};

/** Repositories over a migrated database, wherever it lives (memory, or a file shared with other connections). */
export function reposFor(db: Db, clock: FixedClock): Omit<TestDb, 'db'> {
  return {
    clock,
    users: new UserRepository(db, clock),
    conversations: new ConversationRepository(db, clock),
    messages: new MessageRepository(db, clock),
    turns: new SqliteTurnRepository(db, clock, { beliefs: noopRebuilder }),
    assertions: new AssertionRepository(db),
  };
}

/**
 * A fresh in-memory database, migrated, in the given mode. `upToMigration` stops early, so a test can show
 * that one migration alone is what enforces an invariant (later triggers cannot mask its error message).
 */
export function openTestDb(mode: AppMode = 'real', upToMigration?: number): TestDb {
  const db = openDatabase(IN_MEMORY);
  const clock = new FixedClock(T0);
  const migrations = loadMigrations();
  initializeDatabase(db, {
    mode,
    clock,
    migrations: upToMigration === undefined ? migrations : migrations.slice(0, upToMigration),
  });
  return { db, ...reposFor(db, clock) };
}

/** A migrated database in a file, for tests that need several connections (worker threads) to share it. */
export function openTestDbAt(file: string, mode: AppMode = 'real'): TestDb {
  const db = openDatabase(file);
  const clock = new FixedClock(T0);
  initializeDatabase(db, { mode, clock });
  return { db, ...reposFor(db, clock) };
}

/**
 * Raw fixture inserts for tables whose repositories arrive in later milestones. They go straight
 * to SQL on purpose: the tests that use them verify database constraints, which a repository would
 * only get in the way of.
 */

export function insertTurn(
  db: Db,
  p: {
    conversationId: ConversationId;
    userId: UserId;
    userMessageId: MessageId;
    idempotencyKey?: string;
    status?: 'running' | 'complete' | 'partial' | 'clarify' | 'interrupted' | 'failed';
    startedAt?: Ms;
  },
): TurnId {
  const id = newId('trn');
  const status = p.status ?? 'complete';
  const startedAt = p.startedAt ?? T0;
  // Migration 004: a running turn starts in RECEIVED unfinished; a finished one carries finished_at.
  db.prepare(
    `INSERT INTO turns (id, conversation_id, user_id, user_message_id, idempotency_key, state, status,
       deadline_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    p.conversationId,
    p.userId,
    p.userMessageId,
    p.idempotencyKey ?? newId('trn'),
    status === 'running' ? 'RECEIVED' : 'COMPLETED',
    status,
    startedAt + 60_000,
    startedAt,
    status === 'running' ? null : startedAt + 1_000,
  );
  return id;
}

/** `n` plain sentences with no placeholders. */
export function plainSentences(n: number): PersistedSentence[] {
  return Array.from({ length: n }, (_, index) => ({
    index,
    text: `Sentence ${index}.`,
    template: `Sentence ${index}.`,
    status: 'no_claims' as const,
    issues: [],
    placeholders: [],
  }));
}

/**
 * An assistant message bound to `turnId`, as turn completion would store it. Assertions must hang off one
 * (migration 005), and its streamed/rendered extents drive delivery state.
 */
export function insertAssistantMessage(
  t: TestDb,
  p: {
    userId: UserId;
    conversationId: ConversationId;
    turnId: TurnId;
    sentences?: number;
    streamedThrough?: number;
    status?: 'complete' | 'interrupted';
  },
): MessageId {
  const sentences = plainSentences(p.sentences ?? 3);
  return t.messages.insert({
    userId: p.userId,
    conversationId: p.conversationId,
    role: 'assistant',
    content: sentences.map((s) => s.text).join(' '),
    template: sentences.map((s) => s.template).join(' '),
    sentences,
    status: p.status ?? 'complete',
    streamedThrough: p.streamedThrough ?? sentences.length - 1,
    tz: 'UTC',
    turnId: p.turnId,
  }).id;
}

export function insertEntity(db: Db, p: { userId: UserId; norm: string }): EntityId {
  const id = newId('ent');
  db.prepare(
    'INSERT INTO entities (id, user_id, canonical, norm, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, p.userId, p.norm, p.norm, T0);
  return id;
}

export function insertSnapshot(
  db: Db,
  p: {
    userId: UserId;
    url?: string;
    origin?: 'live' | 'recorded' | 'synthetic';
    observedAt?: Ms;
    sha?: string;
  },
): SnapshotId {
  const id = newId('src');
  const url = p.url ?? `https://vendor.example/pricing/${id}`;
  db.prepare(
    `INSERT INTO source_snapshots (id, user_id, url, url_norm, domain, content_text, content_mode,
       content_sha256, provider, observed_at, fresh_fetch, crawl_status, origin)
     VALUES (?, ?, ?, ?, 'vendor.example', 'Pro $90 per user per month', 'text', ?, 'test', ?, 1, 'ok', ?)`,
  ).run(id, p.userId, url, url, p.sha ?? id, p.observedAt ?? T0, p.origin ?? 'live');
  return id;
}

export function insertEvidence(
  db: Db,
  p: {
    userId: UserId;
    snapshotId: SnapshotId;
    turnId: TurnId;
    entityId: EntityId;
    beliefKey?: string | null;
  },
): EvidenceId {
  const id = newId('ev');
  db.prepare(
    `INSERT INTO evidence_statements (id, user_id, snapshot_id, turn_id, entity_id, kind, belief_key,
       payload_json, quote, polarity, modality, displayed_at_basis, authority_tier,
       verification_status, verification_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'price', ?, '{}', 'Pro $90 per user per month', 'affirmed', 'current',
       'fresh_fetch', 'A1', 'pass', '{"status":"pass","checks":[]}', ?)`,
  ).run(
    id,
    p.userId,
    p.snapshotId,
    p.turnId,
    p.entityId,
    p.beliefKey === undefined ? `price:v1|e=${p.entityId}|test` : p.beliefKey,
    T0,
  );
  return id;
}

export function insertFinding(
  db: Db,
  p: { turnId: TurnId; entityId: EntityId; ord?: number },
): FindingId {
  const id = newId('fnd');
  db.prepare(
    `INSERT INTO findings (id, turn_id, ord, entity_id, intent, current_status, data_json)
     VALUES (?, ?, ?, ?, 'pricing', 'confirmed', '{}')`,
  ).run(id, p.turnId, p.ord ?? 1, p.entityId);
  return id;
}

export function insertAssertion(
  db: Db,
  p: {
    userId: UserId;
    messageId: MessageId;
    turnId: TurnId;
    findingId: FindingId;
    sentenceIndex?: number;
    evidenceIds?: EvidenceId[];
  },
): AssertionId {
  const id = newId('asr');
  db.prepare(
    `INSERT INTO assertions (id, user_id, message_id, turn_id, finding_id, sentence_index, placeholder,
       rendered_text, created_at) VALUES (?, ?, ?, ?, ?, ?, 'F1', '$90 per user per month [1]', ?)`,
  ).run(id, p.userId, p.messageId, p.turnId, p.findingId, p.sentenceIndex ?? 0, T0);
  for (const evidenceId of p.evidenceIds ?? []) {
    db.prepare('INSERT INTO assertion_evidence (assertion_id, evidence_id) VALUES (?, ?)').run(
      id,
      evidenceId,
    );
  }
  return id;
}

export function insertAssertionEvent(
  db: Db,
  p: { assertionId: AssertionId; status: string; at?: Ms },
): string {
  const id = newId('ev');
  db.prepare('INSERT INTO assertion_events (id, assertion_id, status, at) VALUES (?, ?, ?, ?)').run(
    id,
    p.assertionId,
    p.status,
    p.at ?? T0,
  );
  return id;
}

export function insertMessageSearch(
  db: Db,
  p: { messageId: MessageId; userId: UserId; body: string; tags?: string },
): void {
  db.prepare(
    'INSERT INTO message_search (message_id, user_id, created_at, body, tags) VALUES (?, ?, ?, ?, ?)',
  ).run(p.messageId, p.userId, T0, p.body, p.tags ?? '');
}

export function count(
  db: Db,
  table: string,
  where = '1=1',
  ...params: Array<string | number>
): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as
    { n: number } | undefined;
  return row?.n ?? 0;
}

/** A conversation with one user message and one turn, ready to hang evidence and assertions on. */
export function seedConversation(
  t: TestDb,
  userId: UserId,
  opts: { text?: string; idempotencyKey?: string } = {},
): { conversationId: ConversationId; userMessageId: MessageId; turnId: TurnId } {
  const conversation = t.conversations.create({ userId });
  const message = t.messages.insert({
    userId,
    conversationId: conversation.id,
    role: 'user',
    content: opts.text ?? 'What does HubSpot charge?',
    tz: 'Europe/London',
  });
  const turnId = insertTurn(t.db, {
    conversationId: conversation.id,
    userId,
    userMessageId: message.id,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
  return { conversationId: conversation.id, userMessageId: message.id, turnId };
}
