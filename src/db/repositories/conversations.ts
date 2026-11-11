import { z } from 'zod';
import type { Clock } from '../../shared/infrastructure.js';
import {
  newId,
  parseId,
  type ConversationId,
  type Ms,
  type Origin,
  type UserId,
} from '../../shared/ids.js';
import type { Db } from '../connection.js';
import { queryAll, queryOne } from '../sql.js';

export interface Conversation {
  id: ConversationId;
  userId: UserId;
  title: string | null;
  origin: Origin;
  createdAt: Ms;
  updatedAt: Ms;
}

const conversationRow = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string().nullable(),
  origin: z.enum(['live', 'recorded', 'synthetic']),
  created_at: z.number(),
  updated_at: z.number(),
});

function toConversation(row: z.output<typeof conversationRow>): Conversation {
  return {
    id: parseId('cnv', row.id),
    userId: parseId('usr', row.user_id),
    title: row.title,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'id, user_id, title, origin, created_at, updated_at';

export class ConversationRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: { userId: UserId; title?: string | null; origin?: Origin }): Conversation {
    const id = newId('cnv');
    const now = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO conversations (id, user_id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.userId, input.title ?? null, input.origin ?? 'live', now, now);
    const created = this.getOwned(input.userId, id);
    if (!created) throw new Error('conversation vanished immediately after insert');
    return created;
  }

  /** Returns null both when the conversation does not exist and when it belongs to someone else. */
  getOwned(userId: UserId, id: ConversationId): Conversation | null {
    const row = queryOne(
      this.db,
      `SELECT ${COLUMNS} FROM conversations WHERE id = ? AND user_id = ?`,
      conversationRow,
      [id, userId],
    );
    return row ? toConversation(row) : null;
  }

  /** Most recently updated first. */
  listByUser(userId: UserId, limit = 50): Conversation[] {
    return queryAll(
      this.db,
      `SELECT ${COLUMNS} FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
      conversationRow,
      [userId, limit],
    ).map(toConversation);
  }
}
