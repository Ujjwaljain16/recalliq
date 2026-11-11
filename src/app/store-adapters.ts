import type { Db, MessageRepository } from '../db/index.js';
import { BaselineLoader } from '../db/index.js';
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
 * INTEGRATION POINT: the belief-key decoder.
 *
 * An eligible baseline (src/shared/memory.ts `Baseline`) needs a parsed `PriceBeliefKey` and an entity id,
 * which come from decoding the stored `belief_key` string. That decoder belongs to the belief module and does
 * not exist yet, so this adapter returns NO eligible baselines: an audit has nothing to compare against and
 * says so. Nothing is invented in its place.
 *
 * `unverified` is real: it is the existing baseline loader's `recallUnverified`, which already has the
 * UnverifiedClaim shape (what the user was shown, never presented as a verified fact, ADR-38).
 *
 * To wire the real thing, replace `eligible` with the mapping described on `BaselineSource` in
 * src/orchestration/ports.ts: loadBaselines(...) for each conversation, each claim completed with the decoded
 * key, entity id, stored evidence and evidence status at T0.
 */
export class LoaderBaselineSource implements BaselineSource {
  private readonly loader: BaselineLoader;

  constructor(db: Db) {
    this.loader = new BaselineLoader(db);
  }

  eligible(): never[] {
    return [];
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
