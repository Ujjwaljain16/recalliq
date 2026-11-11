import { resolveRecall } from '../../memory/recall.js';
import type { ConversationId } from '../../shared/ids.js';
import type { Baseline } from '../../shared/memory.js';
import { TURN_LIMITS } from '../config.js';
import type { UnverifiedClaim } from '../ports.js';
import {
  ambiguousEntityOutcome,
  candidateAsHit,
  clarifyOutcome,
  emitContext,
  emptyContext,
  localTimeOf,
  resolveEntities,
  resolveTemporal,
} from './common.js';
import { runResearch } from './research-core.js';
import type { LaneHandler, RecallTexts } from './types.js';

/**
 * Audit lane: "is what you told me on 3 November still right?".
 *
 *  - Which earlier conversation is meant is decided like recall: an explicit date goes through
 *    `resolveRecall` (several candidates: clarify; no record: a fixed reply), otherwise the current
 *    conversation is the one audited.
 *  - Baselines are loaded through the injected port, eligible claims only (ADR-38) and only for the entities
 *    asked about. Claims that were presented but are not eligible are never baselines: they reach synthesis
 *    as quoted history labelled "not verified", so the answer says what the user saw, not that it was true.
 *  - With neither eligible nor unverified claims there is nothing to audit: a fixed reply says so, it does
 *    not invent a baseline.
 *  - The research itself is the injected ResearchService, with the baselines inside the context.
 */
export const auditLane: LaneHandler = async (input, deps) => {
  const base = { ...emptyContext('audit'), temporal: resolveTemporal(input, deps) };

  const named = resolveEntities(input, deps, input.analysis.entities);
  const ambiguous = ambiguousEntityOutcome(input, base, named);
  if (ambiguous) return ambiguous;

  let conversationIds: ConversationId[] = [input.conversationId];
  let hits = base.memoryHits;
  const asksAboutADay = input.analysis.temporal.some((t) => t.role === 'reference_conversation');
  if (asksAboutADay) {
    const found = resolveRecall(
      { resolver: deps.resolver, memory: deps.memory },
      {
        userId: input.userId,
        mentions: input.analysis.temporal,
        topicTerms: input.analysis.topicTerms,
        tz: input.tz,
        now: input.now,
      },
    );
    if (found.kind === 'clarify') {
      emitContext(input, base);
      return clarifyOutcome(input, base, found.reason, found.question, found.options);
    }
    if (found.kind === 'none') {
      emitContext(input, base);
      return {
        kind: 'reply',
        lane: 'audit',
        ctx: base,
        reason: 'no_record',
        sentences: [
          `I have no record of a conversation on ${found.localDates.join(' or ')}, so I have nothing earlier to check.`,
          'If you want, I can look up the current state on the web instead.',
        ],
      };
    }
    conversationIds = found.conversationIds as ConversationId[];
    hits = found.hits;
  }

  const query = { userId: input.userId, currentTurnId: input.turnId, conversationIds };
  const wanted = new Set(named.entities.map((e) => e.id));
  const eligible: Baseline[] = deps.baselines
    .eligible(query)
    .filter((b) => wanted.size === 0 || wanted.has(b.entityId));
  const unverified: UnverifiedClaim[] = deps.baselines
    .unverified(query)
    .slice(0, TURN_LIMITS.maxUnverifiedClaims);

  if (eligible.length === 0 && unverified.length === 0) {
    const ctx = { ...base, memoryHits: hits };
    emitContext(input, ctx);
    return {
      kind: 'reply',
      lane: 'audit',
      ctx,
      reason: 'no_prior_claims',
      sentences: [
        'I have no earlier claim of mine on this that I can compare against.',
        'If you want, I can look up the current state on the web instead.',
      ],
    };
  }

  const recall: RecallTexts = new Map(
    hits.map((h) => [h.messageId, { text: h.excerpt, localTime: h.localTime }]),
  );
  const claimHits = unverified.map((c) => {
    const localTime = localTimeOf(c.presentedAt, input.tz);
    const text = `[not verified] ${c.renderedText}`;
    recall.set(c.messageId, { text, localTime });
    return candidateAsHit(
      {
        conversationId: c.conversationId,
        messageId: c.messageId,
        turnId: c.turnId,
        createdAt: c.presentedAt,
      },
      localTime,
      text,
    );
  });

  const ctx = {
    ...base,
    entities: named.entities,
    baselines: eligible,
    memoryHits: [...hits, ...claimHits],
  };
  emitContext(input, ctx);
  const outcome = await runResearch(input, deps, ctx, 'audit');
  return outcome.kind === 'synthesize' ? { ...outcome, recall } : outcome;
};
