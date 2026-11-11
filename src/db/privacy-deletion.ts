import { z } from 'zod';
import type { ConversationId, UserId } from '../shared/ids.js';
import type { Db } from './connection.js';
import { NotFoundError } from './errors.js';
import { queryAll, queryOne } from './sql.js';

/**
 * Beliefs and belief history are derived data. After evidence is deleted, they must be recomputed
 * for the affected keys: delete the rows for `keys`, then replay the remaining `pass` evidence.
 * The resolver lives in the evidence/belief milestone, so the procedure takes it as a dependency
 * rather than leaving derived state silently stale.
 */
export interface BeliefRebuilder {
  /** Called inside the deletion transaction; throwing rolls the whole deletion back. */
  rebuild(userId: UserId, keys: readonly string[]): void;
}

export interface DeletionResult {
  /** Belief keys whose evidence came from the deleted conversation, handed to the rebuilder. */
  affectedBeliefKeys: string[];
}

const idRow = z.object({ id: z.string() });
const keyRow = z.object({ k: z.string() });
const oneRow = z.object({ one: z.literal(1) });

/**
 * Privacy deletion (contracts §1.1). Deliberately explicit rather than a chain of foreign-key
 * cascades, because evidence can outlive the conversation that produced it: web evidence that an
 * assertion in another conversation still cites must survive, while nothing derived from the
 * user's own messages may.
 *
 * Every statement is also scoped by `user_id`; the contract's SQL is a subset of that.
 */
export function deleteConversation(
  db: Db,
  deps: { beliefs: BeliefRebuilder },
  userId: UserId,
  conversationId: ConversationId,
): DeletionResult {
  return db
    .transaction((): DeletionResult => {
      const owned = queryOne(
        db,
        'SELECT 1 AS one FROM conversations WHERE id = ? AND user_id = ?',
        oneRow,
        [conversationId, userId],
      );
      if (!owned) throw new NotFoundError('conversation');

      // 1. D: the turns of this conversation, kept as JSON so the later statements stay
      //    parameterised and independent of SQLite's bound-variable limit.
      const turnIds = queryAll(
        db,
        'SELECT id FROM turns WHERE conversation_id = ? AND user_id = ?',
        idRow,
        [conversationId, userId],
      ).map((r) => r.id);
      const turnIdsJson = JSON.stringify(turnIds);

      // 2. K: belief keys touched by this conversation's evidence.
      const affectedBeliefKeys = queryAll(
        db,
        `SELECT DISTINCT belief_key AS k FROM evidence_statements
         WHERE user_id = ? AND belief_key IS NOT NULL
           AND turn_id IN (SELECT value FROM json_each(?))`,
        keyRow,
        [userId, turnIdsJson],
      ).map((r) => r.k);

      // 3. The conversation. Cascades to messages, message_search (and the FTS triggers), turns,
      //    search_requests, search_results, findings, assertions and their evidence links/events,
      //    and decisions.
      db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(
        conversationId,
        userId,
      );

      // 4. This conversation's evidence, except what an assertion elsewhere still cites. This runs
      //    after step 3 on purpose: this conversation's own assertion links are already gone.
      db.prepare(
        `DELETE FROM evidence_statements
         WHERE user_id = ?
           AND turn_id IN (SELECT value FROM json_each(?))
           AND id NOT IN (SELECT evidence_id FROM assertion_evidence)`,
      ).run(userId, turnIdsJson);

      // 5. Snapshots nothing references any more.
      db.prepare(
        `DELETE FROM source_snapshots
         WHERE user_id = ?
           AND id NOT IN (SELECT snapshot_id FROM evidence_statements)
           AND id NOT IN (SELECT snapshot_id FROM search_results)`,
      ).run(userId);

      // 6. Entities with no evidence, no decision and no remaining tag mention. A tag mention is
      //    the entity's normalised name appearing as a whole space-delimited run in some message's
      //    tags (the contract does not define the match; this is the conservative reading).
      db.prepare(
        `DELETE FROM entities
         WHERE user_id = ?
           AND id NOT IN (SELECT entity_id FROM evidence_statements)
           AND id NOT IN (SELECT entity_id FROM decision_entities)
           AND NOT EXISTS (
             SELECT 1 FROM message_search ms
             WHERE ms.user_id = entities.user_id
               AND instr(' ' || ms.tags || ' ', ' ' || entities.norm || ' ') > 0
           )`,
      ).run(userId);

      // 7. Recompute derived beliefs for the affected keys.
      if (affectedBeliefKeys.length > 0) deps.beliefs.rebuild(userId, affectedBeliefKeys);

      return { affectedBeliefKeys };
    })
    .immediate();
}
