import { resolveRecall } from '../../memory/recall.js';
import { topicalRecall, topicalTerms } from './recall-topical.js';
import {
  clarifyOutcome,
  dayOf,
  emitContext,
  emptyContext,
  FIRST_CONVERSATION,
  isFirstConversation,
  noRecordSentence,
  resolveTemporal,
  TELL_ME_WHAT_YOU_ASKED,
} from './common.js';
import type { LaneDeps, LaneHandler, LaneInput, LaneOutcome, RecallTexts } from './types.js';

/** How many of the conversation's latest user messages a recall without a day hands to the answer. */
export const MAX_CONVERSATION_RECALL = 8;

/**
 * Recall lane: "what did I ask last Tuesday?", "what have we talked about so far?".
 *
 *  - No day named but a subject (topic terms, entities): topical recall across all earlier conversations (see
 *    `topicalRecall`).
 *  - No day and no subject: the user means this conversation. Its latest user messages (never the question being answered)
 *    are retrieved and handed to the answer as recall records, quoted by code; an opening sentence written in code
 *    says how many there were and how many other conversations are on record. An empty conversation is a fixed
 *    reply that says so. Never a "which day?" question.
 *  - A day named: the decision (answer, clarify or no record) is the pure `resolveRecall` over the temporal
 *    resolver and the message retriever. Several candidate days or conversations, or an unresolved date, are a
 *    clarifying question, never a pick. Nothing stored is a fixed "no record" reply that names one day, the most
 *    recent past one, in words. No model writes it, so it cannot claim a conversation took place, and the
 *    retrieved records handed to synthesis are exactly the stored ones.
 */
export const recallLane: LaneHandler = (input, deps) => {
  if (!input.analysis.temporal.some((t) => t.role === 'reference_conversation')) {
    const terms = input.analysis.recallScope === 'conversation' ? [] : topicalTerms(input.analysis);
    return terms.length > 0 ? topicalRecall(input, deps, terms) : conversationRecall(input, deps);
  }
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
    const day =
      dayOf(input, base.temporal, 'reference_conversation') ?? outcome.localDates[0] ?? '';
    const about =
      outcome.searchedTerms.length > 0 ? ` about ${outcome.searchedTerms.join(', ')}` : '';
    return {
      kind: 'reply',
      lane: 'recall',
      ctx: base,
      reason: 'no_record',
      sentences: [
        noRecordSentence(day, about),
        ...(isFirstConversation(input, deps) ? [FIRST_CONVERSATION] : []),
        about === ''
          ? TELL_ME_WHAT_YOU_ASKED
          : 'If you want, I can look it up on the web now instead.',
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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Sentences written in code that open a recall of this conversation. */
function conversationOpening(shown: number, total: number, others: number): string[] {
  const sent = `You have sent me ${plural(total, 'message', 'messages')} in this conversation so far`;
  const out = [shown < total ? `${sent}; here are the last ${shown}.` : `${sent}.`];
  if (others > 0) {
    out.push(
      `There ${others === 1 ? 'is' : 'are'} also ${plural(others, 'earlier conversation', 'earlier conversations')} on record; name a day and I'll recall it.`,
    );
  }
  return out;
}

/** A recall that names no day: this conversation's latest user messages, through the recall records. */
function conversationRecall(input: LaneInput, deps: LaneDeps): LaneOutcome {
  const base = { ...emptyContext('recall'), temporal: resolveTemporal(input, deps) };
  const overview = deps.memory.conversationOverview(
    input.userId,
    input.conversationId,
    input.turnId,
    input.now,
    MAX_CONVERSATION_RECALL,
    input.tz,
  );
  if (overview.hits.length === 0) {
    emitContext(input, base);
    const others = overview.otherConversations;
    return {
      kind: 'reply',
      lane: 'recall',
      ctx: base,
      reason: 'no_record',
      sentences: [
        'There is nothing earlier in this conversation yet.',
        others > 0
          ? `You have ${plural(others, 'earlier conversation', 'earlier conversations')} with me on record; name a day and I'll recall it.`
          : FIRST_CONVERSATION,
        "Ask me about a company's prices or recent releases and I'll check current sources.",
      ],
    };
  }
  const ctx = { ...base, memoryHits: overview.hits };
  emitContext(input, ctx);
  const recall: RecallTexts = new Map(
    overview.hits.map((h) => [h.messageId, { text: h.excerpt, localTime: h.localTime }]),
  );
  return {
    kind: 'synthesize',
    lane: 'recall',
    ctx,
    findings: null,
    recall,
    lead: conversationOpening(overview.hits.length, overview.total, overview.otherConversations),
  };
}
