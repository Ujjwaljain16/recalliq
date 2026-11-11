import { z } from 'zod';
import type { NormalizedValue } from '../../shared/evidence.js';
import {
  parseId,
  type AssertionId,
  type ConversationId,
  type EvidenceId,
  type FindingId,
  type MessageId,
  type Ms,
  type TurnId,
  type UserId,
} from '../../shared/ids.js';
import type { Db } from '../connection.js';
import { normalizedValueSchema, persistedSentencesSchema } from '../schemas.js';
import { queryAll } from '../sql.js';

/**
 * Which stored assertions may be recalled, and which may serve as a historical baseline (ADR-38).
 *
 * Two separate questions:
 *   - recall ("what did you tell me?"): any assertion the user was shown (`presented_at` set). Streamed but
 *     unacknowledged and never-streamed assertions are never returned, by either method.
 *   - baseline (the earlier claim an audit compares against): presented, AND all of
 *       1. from an earlier turn than the current one;
 *       2. placeholder exactly `F<n>` (not :baseline, :verdict, :derived:<k>);
 *       3. its sentence status in `messages.sentences_json` is `verified`;
 *       4. `belief_key` and a valid `value_json` are both set;
 *       5. at least one linked evidence statement, and every linked statement has verification_status 'pass'.
 *
 * `loadBaselines` returns only the eligible claims. `recallUnverified` returns the presented claims that are
 * NOT eligible, each labelled `verification: 'unverified'` with the reasons, so a caller can say what the user
 * saw without presenting it as a verified fact. The two results never overlap. Both are scoped to one user.
 */

export type IneligibleReason =
  | 'sentence_not_verified'
  | 'placeholder_not_current_value'
  | 'missing_belief_key'
  | 'missing_or_invalid_value'
  | 'no_evidence'
  | 'evidence_not_passed';

export interface PresentedClaim {
  assertionId: AssertionId;
  messageId: MessageId;
  turnId: TurnId;
  conversationId: ConversationId;
  findingId: FindingId;
  sentenceIndex: number;
  placeholder: string;
  renderedText: string;
  presentedAt: Ms;
  beliefKey: string | null;
  value: NormalizedValue | null;
  evidenceIds: EvidenceId[];
  /** The sentence status stored with the message, or null if it could not be read. */
  sentenceStatus: string | null;
}

/** A claim that passes every ADR-38 rule: its belief key and value are certainly present. */
export interface BaselineClaim extends PresentedClaim {
  beliefKey: string;
  value: NormalizedValue;
}

/** A presented claim that is not a baseline. It is what the user saw, and it was not verified. */
export interface RecalledClaim extends PresentedClaim {
  verification: 'unverified';
  reasons: IneligibleReason[];
}

export interface ClaimFilter {
  /** Only claims about these belief keys. */
  beliefKeys?: readonly string[];
  /** Only claims made in this conversation. */
  conversationId?: ConversationId;
  /** Maximum number returned, newest first. Default 50, at most 200. */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const row = z.object({
  id: z.string(),
  message_id: z.string(),
  turn_id: z.string(),
  conversation_id: z.string(),
  finding_id: z.string(),
  sentence_index: z.number().int(),
  placeholder: z.string(),
  rendered_text: z.string(),
  presented_at: z.number(),
  belief_key: z.string().nullable(),
  value_json: z.string().nullable(),
  sentences_json: z.string().nullable(),
  evidence_count: z.number().int(),
  evidence_not_passed: z.number().int(),
});
const evidenceRow = z.object({ assertion_id: z.string(), evidence_id: z.string() });

function parseValue(json: string | null): NormalizedValue | null {
  if (json === null) return null;
  try {
    const parsed = normalizedValueSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function sentenceStatus(json: string | null, index: number): string | null {
  if (json === null) return null;
  try {
    const sentences = persistedSentencesSchema.safeParse(JSON.parse(json));
    if (!sentences.success) return null;
    return sentences.data.find((s) => s.index === index)?.status ?? null;
  } catch {
    return null;
  }
}

export class BaselineLoader {
  constructor(private readonly db: Db) {}

  /** The presented claims of this user that are eligible baselines for an audit running as `currentTurnId`. */
  loadBaselines(userId: UserId, currentTurnId: TurnId, filter: ClaimFilter = {}): BaselineClaim[] {
    return this.classify(userId, currentTurnId, filter)
      .filter((c) => c.reasons.length === 0)
      .flatMap(({ claim }) =>
        claim.beliefKey !== null && claim.value !== null
          ? [{ ...claim, beliefKey: claim.beliefKey, value: claim.value }]
          : [],
      )
      .slice(0, limitOf(filter));
  }

  /**
   * The presented claims of this user that are NOT eligible baselines, for historical recall. Each is labelled
   * unverified and carries why it is not a baseline.
   */
  recallUnverified(
    userId: UserId,
    currentTurnId: TurnId,
    filter: ClaimFilter = {},
  ): RecalledClaim[] {
    return this.classify(userId, currentTurnId, filter)
      .filter((c) => c.reasons.length > 0)
      .map(({ claim, reasons }) => ({ ...claim, verification: 'unverified' as const, reasons }))
      .slice(0, limitOf(filter));
  }

  private classify(
    userId: UserId,
    currentTurnId: TurnId,
    filter: ClaimFilter,
  ): Array<{ claim: PresentedClaim; reasons: IneligibleReason[] }> {
    const params: Array<string | number> = [userId, currentTurnId];
    let where = '';
    if (filter.conversationId !== undefined) {
      where += ' AND m.conversation_id = ?';
      params.push(filter.conversationId);
    }
    if (filter.beliefKeys !== undefined) {
      if (filter.beliefKeys.length === 0) return [];
      where += ` AND a.belief_key IN (${filter.beliefKeys.map(() => '?').join(', ')})`;
      params.push(...filter.beliefKeys);
    }

    // Rule 1 (presented, earlier turn) and the user scope are enforced in SQL; the rest are judged below so
    // that recall can say which rule a claim failed.
    const rows = queryAll(
      this.db,
      `SELECT a.id, a.message_id, a.turn_id, m.conversation_id, a.finding_id, a.sentence_index, a.placeholder,
              a.rendered_text, a.presented_at, a.belief_key, a.value_json, m.sentences_json,
              (SELECT count(*) FROM assertion_evidence ae WHERE ae.assertion_id = a.id) AS evidence_count,
              (SELECT count(*) FROM assertion_evidence ae
                 JOIN evidence_statements e ON e.id = ae.evidence_id
                WHERE ae.assertion_id = a.id AND e.verification_status <> 'pass') AS evidence_not_passed
         FROM assertions a
         JOIN messages m ON m.id = a.message_id AND m.user_id = a.user_id
        WHERE a.user_id = ? AND a.presented_at IS NOT NULL AND a.turn_id <> ?${where}
        ORDER BY a.presented_at DESC, a.id`,
      row,
      params,
    );

    const links = new Map<string, EvidenceId[]>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const link of queryAll(
          this.db,
          `SELECT assertion_id, evidence_id FROM assertion_evidence
            WHERE assertion_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY evidence_id`,
          evidenceRow,
          chunk,
        )) {
          const list = links.get(link.assertion_id) ?? [];
          list.push(parseId('ev', link.evidence_id));
          links.set(link.assertion_id, list);
        }
      }
    }

    return rows.map((r) => {
      const value = parseValue(r.value_json);
      const status = sentenceStatus(r.sentences_json, r.sentence_index);
      const reasons: IneligibleReason[] = [];
      if (status !== 'verified') reasons.push('sentence_not_verified');
      if (!/^F\d+$/.test(r.placeholder)) reasons.push('placeholder_not_current_value');
      if (r.belief_key === null) reasons.push('missing_belief_key');
      if (value === null) reasons.push('missing_or_invalid_value');
      if (r.evidence_count === 0) reasons.push('no_evidence');
      else if (r.evidence_not_passed > 0) reasons.push('evidence_not_passed');
      return {
        claim: {
          assertionId: parseId('asr', r.id),
          messageId: parseId('msg', r.message_id),
          turnId: parseId('trn', r.turn_id),
          conversationId: parseId('cnv', r.conversation_id),
          findingId: parseId('fnd', r.finding_id),
          sentenceIndex: r.sentence_index,
          placeholder: r.placeholder,
          renderedText: r.rendered_text,
          presentedAt: r.presented_at,
          beliefKey: r.belief_key,
          value,
          evidenceIds: links.get(r.id) ?? [],
          sentenceStatus: status,
        },
        reasons,
      };
    });
  }
}

function limitOf(filter: ClaimFilter): number {
  return Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}
