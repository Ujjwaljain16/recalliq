import type { Db, MessageRepository } from '../db/index.js';
import { decodePriceKey } from '../belief/belief-key.js';
import { DEFAULT_BELIEF_POLICY } from '../belief/resolver.js';
import { BaselineLoader } from '../db/index.js';
import { EvidenceRepository } from '../evidence/repository.js';
import type { PriceBeliefKey } from '../shared/belief.js';
import type { VerifiedEvidence } from '../shared/evidence.js';
import type { Baseline } from '../shared/memory.js';
import type {
  BaselineSource,
  ConversationWindowReader,
  UnverifiedClaim,
} from '../orchestration/ports.js';

/** The last messages of a conversation, oldest first, excluding the turn's own user message. */
export class MessageWindowReader implements ConversationWindowReader {
  constructor(private readonly messages: Pick<MessageRepository, 'listByConversation'>) {}

  recent(
    userId: Parameters<ConversationWindowReader['recent']>[0],
    conversationId: Parameters<ConversationWindowReader['recent']>[1],
    exceptMessageId: Parameters<ConversationWindowReader['recent']>[2],
    limit: number,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (limit <= 0) return [];
    return this.messages
      .listByConversation(userId, conversationId)
      .filter((m) => m.id !== exceptMessageId)
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.content }));
  }
}

/**
 * Baselines for an audit (ADR-38). `eligible` completes each claim the baseline loader accepts into a shared
 * Baseline: the belief key is decoded (the key names its entity), the entity must still exist for the user,
 * the claim's own stored evidence is loaded, and `evidenceStatusAtT0` is computed:
 *
 *   missing       no linked evidence could be loaded
 *   weak          some loaded statement is not a `pass`
 *   pass_current  every statement passes and one was a fresh fetch no more than the price freshness window
 *                 (30 days, the belief policy) before the answer was presented
 *   pass_stale    every statement passes, but none was a fresh fetch within that window
 *
 * A claim whose key cannot be decoded is skipped: nothing is invented in its place.
 * `unverified` is the loader's `recallUnverified` (what the user was shown, never a verified fact).
 */
export class LoaderBaselineSource implements BaselineSource {
  private readonly loader: BaselineLoader;
  private readonly evidence: EvidenceRepository;

  constructor(
    private readonly db: Db,
    private readonly freshnessMs: number = DEFAULT_BELIEF_POLICY.freshnessMs.price,
  ) {
    this.loader = new BaselineLoader(db);
    this.evidence = new EvidenceRepository(db);
  }

  eligible(q: Parameters<BaselineSource['eligible']>[0]): Baseline[] {
    const out: Baseline[] = [];
    for (const conversationId of q.conversationIds) {
      for (const claim of this.loader.loadBaselines(q.userId, q.currentTurnId, {
        conversationId,
      })) {
        let key: PriceBeliefKey;
        try {
          key = decodePriceKey(claim.beliefKey);
        } catch {
          continue;
        }
        const owned = this.db
          .prepare('SELECT 1 FROM entities WHERE id = ? AND user_id = ?')
          .pluck()
          .get(key.entityId, q.userId);
        if (owned === undefined) continue;
        const evidence = this.evidence.getMany(q.userId, claim.evidenceIds);
        out.push({
          assertionId: claim.assertionId,
          beliefKey: claim.beliefKey,
          key,
          entityId: key.entityId,
          value: claim.value,
          presentedAt: claim.presentedAt,
          evidence,
          evidenceStatusAtT0: this.statusAtT0(evidence, claim.presentedAt),
        });
      }
    }
    return out;
  }

  private statusAtT0(
    evidence: VerifiedEvidence[],
    presentedAt: number,
  ): Baseline['evidenceStatusAtT0'] {
    if (evidence.length === 0) return 'missing';
    if (evidence.some((e) => e.verification.status !== 'pass')) return 'weak';
    const current = evidence.some(
      (e) => e.freshFetch && presentedAt - e.observedAt <= this.freshnessMs,
    );
    return current ? 'pass_current' : 'pass_stale';
  }

  unverified(q: Parameters<BaselineSource['unverified']>[0]): UnverifiedClaim[] {
    return q.conversationIds.flatMap((conversationId) =>
      this.loader.recallUnverified(q.userId, q.currentTurnId, { conversationId }).map((c) => ({
        assertionId: c.assertionId,
        messageId: c.messageId,
        conversationId: c.conversationId,
        turnId: c.turnId,
        presentedAt: c.presentedAt,
        renderedText: c.renderedText,
        reasons: c.reasons,
      })),
    );
  }
}
