import type { Db } from '../../src/db/index.js';
import { newId } from '../../src/shared/ids.js';
import type { LongMemEvalItem } from './datasets.js';

/**
 * Writes a LongMemEval item's haystack into the application's database as the user's earlier history: one
 * conversation per haystack session, its user and assistant messages in order, each indexed in
 * `message_search` (and through its triggers in the FTS table) exactly as a committed turn indexes both of
 * its messages. Everything goes through plain INSERTs that the schema's triggers accept for a `real`
 * database (origin `live`, messages stored unrendered, an assistant message's streamed extent within its
 * sentences); assistant messages are then acknowledged as rendered, since the user saw them.
 *
 * What the schema cannot hold from the dataset, and what is therefore not represented:
 *   - a turn row per exchange (no analysis, lane, events or metrics ever existed for this history);
 *   - write-time enrichment (tags, entities, decisions) that a live turn would have extracted with the model;
 *   - per-message times: a session has one date, so its messages are spaced one second apart from it;
 *   - the dataset's `has_answer` flags (they are evaluation metadata, not conversation content).
 */

export interface SeedSummary {
  conversations: number;
  userMessages: number;
  assistantMessages: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** Spacing between consecutive messages of one session (the dataset gives one time per session). */
export const MESSAGE_SPACING_MS = 1000;

export function seedLongMemHistory(
  db: Db,
  userId: string,
  item: LongMemEvalItem,
  tz = 'UTC',
): SeedSummary {
  const summary: SeedSummary = {
    conversations: 0,
    userMessages: 0,
    assistantMessages: 0,
    firstAt: null,
    lastAt: null,
  };
  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, user_id, title, origin, created_at, updated_at)
     VALUES (?, ?, NULL, 'live', ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, conversation_id, user_id, turn_id, seq, role, content, content_template,
       sentences_json, status, streamed_through, tz, origin, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'complete', ?, ?, 'live', ?)`,
  );
  const acknowledge = db.prepare(
    'UPDATE messages SET rendered_through = 0, last_ack_at = ? WHERE id = ? AND user_id = ?',
  );
  // As writeEnrichment does: the search row copies user, time and body from the message row itself.
  const index = db.prepare(
    `INSERT INTO message_search (message_id, user_id, created_at, body, tags)
     SELECT id, user_id, created_at, content, '' FROM messages WHERE id = ? AND user_id = ?`,
  );

  const sessions = [...item.sessions].sort((a, b) => a.at - b.at);
  db.transaction(() => {
    for (const session of sessions) {
      if (session.turns.length === 0) continue;
      const conversationId = newId('cnv');
      const lastAt = session.at + (session.turns.length - 1) * MESSAGE_SPACING_MS;
      insertConversation.run(conversationId, userId, session.at, lastAt);
      summary.conversations += 1;
      session.turns.forEach((turn, k) => {
        const at = session.at + k * MESSAGE_SPACING_MS;
        const id = newId('msg');
        if (turn.role === 'user') {
          insertMessage.run(
            id,
            conversationId,
            userId,
            k + 1,
            'user',
            turn.content,
            null,
            null,
            null,
            tz,
            at,
          );
          summary.userMessages += 1;
        } else {
          // One sentence carrying the whole reply: it was never validated by this application, so `unchecked`.
          const sentences = [
            {
              index: 0,
              text: turn.content,
              template: turn.content,
              status: 'unchecked',
              issues: [],
              placeholders: [],
            },
          ];
          insertMessage.run(
            id,
            conversationId,
            userId,
            k + 1,
            'assistant',
            turn.content,
            turn.content,
            JSON.stringify(sentences),
            0,
            tz,
            at,
          );
          acknowledge.run(at, id, userId);
          summary.assistantMessages += 1;
        }
        index.run(id, userId);
        summary.firstAt = summary.firstAt === null ? at : Math.min(summary.firstAt, at);
        summary.lastAt = summary.lastAt === null ? at : Math.max(summary.lastAt, at);
      });
    }
  }).immediate();
  return summary;
}

/** The only user of a fresh database (the one the harness created through the API). */
export function soleUserId(db: Db): string {
  const rows = db.prepare('SELECT id FROM users').all() as Array<{ id: string }>;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(
      `expected exactly one user in a fresh benchmark database, found ${rows.length}`,
    );
  }
  return rows[0].id;
}
