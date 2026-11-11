import { z } from 'zod';
import { deliveryState, type DeliveryState } from '../../shared/delivery.js';
import type { NormalizedValue } from '../../shared/evidence.js';
import {
  parseId,
  type AssertionId,
  type EvidenceId,
  type FindingId,
  type MessageId,
  type Ms,
  type TurnId,
  type UserId,
} from '../../shared/ids.js';
import type { Db } from '../connection.js';
import { normalizedValueSchema } from '../schemas.js';
import { queryAll, queryOne } from '../sql.js';

export interface StoredAssertionEvent {
  status: string;
  reason: string | null;
  turnId: TurnId | null;
  at: Ms;
}

export interface StoredAssertion {
  id: AssertionId;
  userId: UserId;
  messageId: MessageId;
  turnId: TurnId;
  findingId: FindingId;
  sentenceIndex: number;
  /** e.g. "F3" or "F3:baseline" */
  placeholder: string;
  beliefKey: string | null;
  renderedText: string;
  value: NormalizedValue | null;
  createdAt: Ms;
  /** Set once, by the browser's acknowledgement. Null means the claim was never presented. */
  presentedAt: Ms | null;
  evidenceIds: EvidenceId[];
  /** Derived from the message's streamed and rendered extents; always consistent with `presentedAt`. */
  delivery: DeliveryState;
  events: StoredAssertionEvent[];
}

const assertionRow = z.object({
  id: z.string(),
  user_id: z.string(),
  message_id: z.string(),
  turn_id: z.string(),
  finding_id: z.string(),
  sentence_index: z.number().int(),
  placeholder: z.string(),
  belief_key: z.string().nullable(),
  rendered_text: z.string(),
  value_json: z.string().nullable(),
  created_at: z.number(),
  presented_at: z.number().nullable(),
});
const extentRow = z.object({
  streamed_through: z.number().int().nullable(),
  rendered_through: z.number().int(),
});
const evidenceRow = z.object({ evidence_id: z.string() });
const eventRow = z.object({
  status: z.string(),
  reason: z.string().nullable(),
  turn_id: z.string().nullable(),
  at: z.number(),
});

/** Read side of the assertion layer (L3). Writes happen only in turn completion and acknowledgement. */
export class AssertionRepository {
  constructor(private readonly db: Db) {}

  /**
   * The assertions of one assistant message, in sentence order, with their delivery state.
   * Throws if the stored `presented_at` disagrees with the derived delivery state: that would be corruption,
   * and silently trusting either side could turn a never-seen claim into a baseline.
   */
  listForMessage(userId: UserId, messageId: MessageId): StoredAssertion[] {
    const extents = queryOne(
      this.db,
      'SELECT streamed_through, rendered_through FROM messages WHERE id = ? AND user_id = ?',
      extentRow,
      [messageId, userId],
    );
    if (!extents) return [];

    return queryAll(
      this.db,
      `SELECT id, user_id, message_id, turn_id, finding_id, sentence_index, placeholder, belief_key,
              rendered_text, value_json, created_at, presented_at
       FROM assertions WHERE message_id = ? AND user_id = ? ORDER BY sentence_index, placeholder`,
      assertionRow,
      [messageId, userId],
    ).map((row) => {
      const delivery = deliveryState(row.sentence_index, {
        renderedThrough: extents.rendered_through,
        streamedThrough: extents.streamed_through,
      });
      if ((delivery === 'presented') !== (row.presented_at !== null)) {
        throw new Error(
          `Assertion ${row.id} is inconsistent: delivery is ${delivery} but presented_at is ${String(row.presented_at)}`,
        );
      }
      return {
        id: parseId('asr', row.id),
        userId: parseId('usr', row.user_id),
        messageId: parseId('msg', row.message_id),
        turnId: parseId('trn', row.turn_id),
        findingId: parseId('fnd', row.finding_id),
        sentenceIndex: row.sentence_index,
        placeholder: row.placeholder,
        beliefKey: row.belief_key,
        renderedText: row.rendered_text,
        value:
          row.value_json === null ? null : normalizedValueSchema.parse(JSON.parse(row.value_json)),
        createdAt: row.created_at,
        presentedAt: row.presented_at,
        evidenceIds: queryAll(
          this.db,
          'SELECT evidence_id FROM assertion_evidence WHERE assertion_id = ? ORDER BY evidence_id',
          evidenceRow,
          [row.id],
        ).map((e) => parseId('ev', e.evidence_id)),
        delivery,
        events: queryAll(
          this.db,
          'SELECT status, reason, turn_id, at FROM assertion_events WHERE assertion_id = ? ORDER BY at, rowid',
          eventRow,
          [row.id],
        ).map((e) => ({
          status: e.status,
          reason: e.reason,
          turnId: e.turn_id === null ? null : parseId('trn', e.turn_id),
          at: e.at,
        })),
      };
    });
  }
}
