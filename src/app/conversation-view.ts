import { z } from 'zod';
import type { ConversationRepository, Db, MessageRepository } from '../db/index.js';
import { queryAll, queryOne } from '../db/sql.js';
import { citationsOf } from '../orchestration/prepare.js';
import type { PersistedSentence } from '../shared/answer.js';
import { deliveryState } from '../shared/delivery.js';
import type { Finding, FindingSet } from '../shared/findings.js';
import { parseId, type ConversationId, type TurnId, type UserId } from '../shared/ids.js';
import type { SseEvent } from '../shared/sse.js';
import type {
  ConversationSummary,
  ConversationView,
  MessageView,
  SentenceView,
  SourceView,
} from '../server/types.js';

const PREVIEW_CHARS = 80;

const turnRow = z.object({
  id: z.string(),
  status: z.enum(['running', 'complete', 'partial', 'clarify', 'interrupted', 'failed']),
  lane: z.enum(['chat', 'recall', 'research', 'audit', 'clarify']).nullable(),
  error_code: z.string().nullable(),
  assistant_message_id: z.string().nullable(),
});
const eventsRow = z.object({
  events_json: z.string().nullable(),
  assistant_message_id: z.string().nullable(),
});
const previewRow = z.object({ conversation_id: z.string(), content: z.string() });
const oneRow = z.object({ one: z.literal(1) });

function isEvent(value: unknown): value is SseEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof value.event === 'string' &&
    'data' in value
  );
}

function parseEvents(json: string | null): SseEvent[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  } catch {
    return [];
  }
}

function sourcesOf(events: SseEvent[]): SourceView[] {
  const out: SourceView[] = [];
  for (const e of events) {
    if (e.event !== 'source') continue;
    out.push({
      n: out.length + 1,
      sourceId: e.data.sourceId,
      url: e.data.url,
      domain: e.data.domain,
      title: e.data.title,
      tier: e.data.tier,
    });
  }
  return out;
}

interface TurnExtras {
  sources: SourceView[];
  clarification: MessageView['clarification'];
}

function clarificationOf(events: SseEvent[]): MessageView['clarification'] {
  for (const e of events) {
    if (e.event === 'clarification') {
      return { question: e.data.question, options: e.data.options };
    }
  }
  return null;
}

/**
 * Read models for the HTTP layer, built from stored rows only. Each query is parameterised and filtered by
 * `user_id`; the stored `events_json` of a turn is the source of the `[n]` source links shown on reload.
 */
export class SqliteConversationView implements ConversationView {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationRepository,
    private readonly messageRepo: MessageRepository,
  ) {}

  list(userId: UserId, limit: number): ConversationSummary[] {
    const list = this.conversations.listByUser(userId, limit);
    if (list.length === 0) return [];
    const previews = queryAll(
      this.db,
      `SELECT m.conversation_id, m.content FROM messages m
        WHERE m.user_id = ? AND m.role = 'user'
          AND m.seq = (SELECT MIN(f.seq) FROM messages f WHERE f.conversation_id = m.conversation_id AND f.role = 'user')`,
      previewRow,
      [userId],
    );
    const byConversation = new Map(previews.map((p) => [p.conversation_id, p.content]));
    return list.map((c) => {
      const first = byConversation.get(c.id);
      return {
        id: c.id,
        title: c.title,
        preview:
          first === undefined
            ? null
            : Array.from(first.replace(/\s+/g, ' ').trim()).slice(0, PREVIEW_CHARS).join(''),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }

  messages(userId: UserId, conversationId: ConversationId): MessageView[] | null {
    if (!this.conversations.getOwned(userId, conversationId)) return null;
    const turns = queryAll(
      this.db,
      `SELECT id, status, lane, error_code, assistant_message_id FROM turns
        WHERE conversation_id = ? AND user_id = ?`,
      turnRow,
      [conversationId, userId],
    );
    const turnById = new Map(turns.map((t) => [t.id, t]));
    const eventCache = new Map<string, TurnExtras>();
    const extrasFor = (turnId: string): TurnExtras => {
      const cached = eventCache.get(turnId);
      if (cached) return cached;
      const row = queryOne(
        this.db,
        'SELECT events_json, assistant_message_id FROM turns WHERE id = ? AND user_id = ?',
        eventsRow,
        [turnId, userId],
      );
      const events = parseEvents(row?.events_json ?? null);
      const extras: TurnExtras = {
        sources: sourcesOf(events),
        clarification: clarificationOf(events),
      };
      eventCache.set(turnId, extras);
      return extras;
    };

    return this.messageRepo.listByConversation(userId, conversationId).map((m): MessageView => {
      const turn = m.turnId === null ? undefined : turnById.get(m.turnId);
      const sentences: SentenceView[] | null =
        m.sentences === null
          ? null
          : m.sentences.map((s) => ({
              index: s.index,
              text: s.text,
              status: s.status,
              issues: s.issues,
              ...(s.kind ? { kind: s.kind } : {}),
              delivery: deliveryState(s.index, m),
            }));
      const extras = m.role === 'assistant' && m.turnId !== null ? extrasFor(m.turnId) : undefined;
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt,
        turnId: m.turnId,
        streamedThrough: m.streamedThrough,
        renderedThrough: m.renderedThrough,
        sentences,
        sources: extras?.sources ?? [],
        clarification: extras?.clarification ?? null,
        turn: turn ? { status: turn.status, lane: turn.lane, errorCode: turn.error_code } : null,
      };
    });
  }

  hasRunningTurn(userId: UserId, conversationId: ConversationId): boolean {
    return (
      queryOne(
        this.db,
        "SELECT 1 AS one FROM turns WHERE conversation_id = ? AND user_id = ? AND status = 'running' LIMIT 1",
        oneRow,
        [conversationId, userId],
      ) !== null
    );
  }

  /**
   * The stored events of a finished turn plus the `answer.completed` that is never stored (it is built from
   * the stored message), so an idempotent retry of a finished turn receives the same story the first call did.
   */
  replay(userId: UserId, turnId: TurnId): SseEvent[] | null {
    const row = queryOne(
      this.db,
      'SELECT events_json, assistant_message_id FROM turns WHERE id = ? AND user_id = ? AND status <> ?',
      eventsRow,
      [turnId, userId, 'running'],
    );
    if (!row) return null;
    const stored = parseEvents(row.events_json);
    const last = stored.at(-1);
    const completed = last?.event === 'turn.completed' ? last : null;
    const body = completed ? stored.slice(0, -1) : stored;
    if (row.assistant_message_id !== null) {
      const message = this.messageRepo.getOwned(userId, parseId('msg', row.assistant_message_id));
      if (message?.sentences) {
        const findings = body.flatMap((e): Finding[] => (e.event === 'finding' ? [e.data] : []));
        const set = {
          turnId,
          createdAt: message.createdAt,
          findings,
          sources: {},
        } satisfies FindingSet;
        body.push({
          event: 'answer.completed',
          data: {
            assistantMessageId: message.id,
            sentences: message.sentences.map((s: PersistedSentence) => ({
              index: s.index,
              status: s.status,
              issues: s.issues,
              ...(s.kind ? { kind: s.kind } : {}),
            })),
            citations: citationsOf(message.sentences, set),
          },
        });
      }
    }
    if (completed) body.push(completed);
    return body;
  }
}
