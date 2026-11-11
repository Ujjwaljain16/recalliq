import { z } from 'zod';
import type { PersistedSentence } from '../../shared/answer.js';
import type { Clock } from '../../shared/infrastructure.js';
import {
  newId,
  parseId,
  type ConversationId,
  type IanaTz,
  type MessageId,
  type Ms,
  type Origin,
  type TurnId,
  type UserId,
} from '../../shared/ids.js';
import type { Db } from '../connection.js';
import { NotFoundError } from '../errors.js';
import { persistedSentencesSchema } from '../schemas.js';
import { queryAll, queryOne } from '../sql.js';

export interface StoredMessage {
  id: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  turnId: TurnId | null;
  /** Position within the conversation, assigned by the repository starting at 1. */
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  /** Assistant only: the synthesis template with placeholders. */
  contentTemplate: string | null;
  sentences: PersistedSentence[] | null;
  status: 'complete' | 'interrupted';
  /** Assistant only: highest sentence index fully written to the stream, -1 for none. */
  streamedThrough: number | null;
  /** Highest sentence index the browser acknowledged as rendered, -1 for none. */
  renderedThrough: number;
  lastAckAt: Ms | null;
  tz: IanaTz;
  origin: Origin;
  createdAt: Ms;
}

interface NewMessageBase {
  userId: UserId;
  conversationId: ConversationId;
  tz: IanaTz;
  turnId?: TurnId | null;
  origin?: Origin;
}

export type NewMessage =
  | (NewMessageBase & { role: 'user'; content: string })
  | (NewMessageBase & {
      role: 'assistant';
      content: string;
      template: string;
      sentences: PersistedSentence[];
      status: 'complete' | 'interrupted';
      streamedThrough: number;
    });

const messageRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  turn_id: z.string().nullable(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  content_template: z.string().nullable(),
  sentences_json: z.string().nullable(),
  status: z.enum(['complete', 'interrupted']),
  streamed_through: z.number().int().nullable(),
  rendered_through: z.number().int(),
  last_ack_at: z.number().nullable(),
  tz: z.string(),
  origin: z.enum(['live', 'recorded', 'synthetic']),
  created_at: z.number(),
});

const COLUMNS =
  'id, conversation_id, user_id, turn_id, seq, role, content, content_template, sentences_json, ' +
  'status, streamed_through, rendered_through, last_ack_at, tz, origin, created_at';

function toMessage(row: z.output<typeof messageRow>): StoredMessage {
  return {
    id: parseId('msg', row.id),
    conversationId: parseId('cnv', row.conversation_id),
    userId: parseId('usr', row.user_id),
    turnId: row.turn_id === null ? null : parseId('trn', row.turn_id),
    seq: row.seq,
    role: row.role,
    content: row.content,
    contentTemplate: row.content_template,
    sentences:
      row.sentences_json === null
        ? null
        : persistedSentencesSchema.parse(JSON.parse(row.sentences_json)),
    status: row.status,
    streamedThrough: row.streamed_through,
    renderedThrough: row.rendered_through,
    lastAckAt: row.last_ack_at,
    tz: row.tz,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

/**
 * Messages are immutable once written (triggers enforce it), so this repository deliberately has
 * no update, delete or replace method: deleting and re-inserting a row under the same id would
 * sidestep the immutability triggers (contracts §1, T-DB-04). Whole conversations are removed only
 * through the privacy-deletion procedure. Acknowledgement fields are written by the turn
 * repository in the conversation-lifecycle milestone.
 */
export class MessageRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Throws NotFoundError if the conversation is not owned by `msg.userId`. */
  insert(msg: NewMessage): StoredMessage {
    const id = newId('msg');
    const now = this.clock.now();
    const sentencesJson =
      msg.role === 'assistant'
        ? JSON.stringify(persistedSentencesSchema.parse(msg.sentences))
        : null;

    this.db
      .transaction(() => {
        const owned = queryOne(
          this.db,
          'SELECT 1 AS one FROM conversations WHERE id = ? AND user_id = ?',
          z.object({ one: z.literal(1) }),
          [msg.conversationId, msg.userId],
        );
        if (!owned) throw new NotFoundError('conversation');

        const next = queryOne(
          this.db,
          'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?',
          z.object({ seq: z.number().int() }),
          [msg.conversationId],
        );
        if (!next) throw new Error('seq query returned no row');

        this.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, user_id, turn_id, seq, role, content,
               content_template, sentences_json, status, streamed_through, tz, origin, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            msg.conversationId,
            msg.userId,
            msg.turnId ?? null,
            next.seq,
            msg.role,
            msg.content,
            msg.role === 'assistant' ? msg.template : null,
            sentencesJson,
            msg.role === 'assistant' ? msg.status : 'complete',
            msg.role === 'assistant' ? msg.streamedThrough : null,
            msg.tz,
            msg.origin ?? 'live',
            now,
          );
        this.db
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
          .run(now, msg.conversationId, msg.userId);
      })
      .immediate();

    const stored = this.getOwned(msg.userId, id);
    if (!stored) throw new Error('message vanished immediately after insert');
    return stored;
  }

  getOwned(userId: UserId, id: MessageId): StoredMessage | null {
    const row = queryOne(
      this.db,
      `SELECT ${COLUMNS} FROM messages WHERE id = ? AND user_id = ?`,
      messageRow,
      [id, userId],
    );
    return row ? toMessage(row) : null;
  }

  /** In conversation order. Empty (not an error) for a conversation the user does not own. */
  listByConversation(userId: UserId, conversationId: ConversationId): StoredMessage[] {
    return queryAll(
      this.db,
      `SELECT ${COLUMNS} FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY seq`,
      messageRow,
      [conversationId, userId],
    ).map(toMessage);
  }
}
