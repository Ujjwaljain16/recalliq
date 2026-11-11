import { resolveRecall } from '../../memory/recall.js';
import { clarifyOutcome, emitContext, emptyContext, resolveTemporal } from './common.js';
import type { LaneHandler, RecallTexts } from './types.js';

/**
 * Recall lane: "what did I ask last Tuesday?". The decision (answer, clarify or no record) is the pure
 * `resolveRecall` over the temporal resolver and the message retriever. The lane adds only the typed outcome:
 *
 *  - several candidate days or conversations, an unresolved date: a clarifying question, never a pick;
 *  - nothing stored: a fixed "no record" reply. No model writes it, so it cannot claim a conversation took
 *    place, and the retrieved records handed to synthesis are exactly the stored ones.
 */
export const recallLane: LaneHandler = (input, deps) => {
  const outcome = resolveRecall(
    { resolver: deps.resolver, memory: deps.memory },
    {
      userId: input.userId,
      mentions: input.analysis.temporal,
      topicTerms: input.analysis.topicTerms,
      tz: input.tz,
      now: input.now,
    },
  );
  const base = { ...emptyContext('recall'), temporal: resolveTemporal(input, deps) };

  if (outcome.kind === 'clarify') {
    emitContext(input, base);
    return clarifyOutcome(input, base, outcome.reason, outcome.question, outcome.options);
  }
  if (outcome.kind === 'none') {
    emitContext(input, base);
    const dates = outcome.localDates.join(' or ');
    const about =
      outcome.searchedTerms.length > 0 ? ` about ${outcome.searchedTerms.join(', ')}` : '';
    return {
      kind: 'reply',
      lane: 'recall',
      ctx: base,
      reason: 'no_record',
      sentences: [
        `I have no record of a conversation${about} on ${dates}.`,
        'If you want, I can look it up on the web now instead.',
      ],
    };
  }

  const ctx = { ...base, memoryHits: outcome.hits };
  emitContext(input, ctx);
  const recall: RecallTexts = new Map(
    outcome.hits.map((h) => [h.messageId, { text: h.excerpt, localTime: h.localTime }]),
  );
  return { kind: 'synthesize', lane: 'recall', ctx, findings: null, recall };
};
