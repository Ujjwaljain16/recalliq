import type { ConversationId, MessageId, Ms, TurnId, UserId } from '../shared/ids.js';
import type { Baseline } from '../shared/memory.js';
import type { TurnRepository } from '../shared/repositories.js';
import type { TurnStatus } from '../shared/turn.js';

/**
 * Ports the coordinator needs beyond the frozen shared interfaces. Each is small, synchronous where the
 * underlying SQLite call is, and satisfied by an adapter over a real implementation (mapping in the module
 * report). None of them contains logic the coordinator relies on for correctness other than what is stated.
 */

/**
 * TurnRepository plus the two methods the coordinator needs and the shared interface omits:
 * `fail` (PERSISTING to FAILED, only when persistence itself failed) and `get` (to read the stored
 * assistant message id after `complete`, which returns void).
 *
 * `SqliteTurnRepository` satisfies this structurally.
 */
export interface TurnStore extends TurnRepository {
  fail(userId: UserId, turnId: TurnId, errorCode: string): void;
  get(
    userId: UserId,
    turnId: TurnId,
  ): { assistantMessageId: MessageId | null; status: TurnStatus } | null;
}

/** The last messages of a conversation, oldest first, excluding the current turn's own user message. */
export interface ConversationWindowReader {
  recent(
    userId: UserId,
    conversationId: ConversationId,
    exceptMessageId: MessageId,
    limit: number,
  ): Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** A presented claim that is not an eligible baseline: what the user saw, never a verified fact (ADR-38). */
export interface UnverifiedClaim {
  assertionId: string;
  messageId: MessageId;
  conversationId: ConversationId;
  turnId: TurnId;
  presentedAt: Ms;
  renderedText: string;
  reasons: readonly string[];
}

export interface BaselineQuery {
  userId: UserId;
  /** The running turn: only claims from earlier turns are eligible. */
  currentTurnId: TurnId;
  conversationIds: ConversationId[];
}

/**
 * What an audit may compare against. `eligible` returns ADR-38 baselines only. `unverified` returns presented
 * claims that failed an eligibility rule, to be shown as unverified. The two never overlap.
 *
 * Mapping from `SqliteBaselineLoader`-style classes (src/db/repositories/baseline-loader.ts):
 *   eligible   = for each conversation: loadBaselines(userId, currentTurnId, { conversationId }) with each
 *                BaselineClaim completed to a shared `Baseline` (key parsed from beliefKey, entityId, stored
 *                evidence, evidenceStatusAtT0);
 *   unverified = for each conversation: recallUnverified(userId, currentTurnId, { conversationId }),
 *                which already has the UnverifiedClaim shape.
 */
export interface BaselineSource {
  eligible(q: BaselineQuery): Baseline[];
  unverified(q: BaselineQuery): UnverifiedClaim[];
}
