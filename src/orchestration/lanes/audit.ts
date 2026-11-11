import type { ConversationId } from '../../shared/ids.js';
import type { Baseline, DecisionRecord, MemoryCandidate } from '../../shared/memory.js';
import type { DayInterval } from '../../shared/temporal.js';
import type { EntityMention } from '../../shared/understanding.js';
import { TURN_LIMITS } from '../config.js';
import type { UnverifiedClaim } from '../ports.js';
import {
  ambiguousEntityOutcome,
  askedSentences,
  changeNotEstablishedSentence,
  candidateAsHit,
  dayOf,
  emitContext,
  emitEntityCap,
  emptyContext,
  FIRST_CONVERSATION,
  isFirstConversation,
  localTimeOf,
  NO_EARLIER_ANSWER_TO_COMPARE,
  NO_VERIFIED_EARLIER_ANSWER,
  noRecordSentence,
  resolveEntities,
  resolveShortlist,
  resolveTemporal,
  TELL_ME_WHAT_YOU_ASKED,
  unknownShortlistOutcome,
} from './common.js';
import { deriveFromRecall, listNames, recallDay, severalConversations } from './recall-context.js';
import { runResearch } from './research-core.js';
import { researchTurn } from './research.js';
import type { LaneHandler, RecallTexts } from './types.js';

const OFFER = 'If you want, I can look up the current state on the web instead.';

/**
 * Audit lane: "is what you told me on 3 November still right?".
 *
 *  - Which earlier conversation is meant is decided like recall: an explicit date goes through
 *    `resolveRecall` (several candidates: clarify), otherwise the current conversation is the one audited.
 *  - Nothing stored on that day: one code-written sentence names the day in words. A set of companies nobody
 *    named and nothing stored names is a question (which ones, and what will be checked); a stated subject
 *    continues in the research lane in the same turn behind that sentence; no subject is a fixed reply that
 *    invites the user to say what was asked. When the date reference found stored messages of the user, the reply
 *    opens with a sentence written in code that says what was asked and when, quoted as stored.
 *  - Who is researched: the entities the user named; when none were named and the user refers to a set of
 *    companies ("the 5 CRM tools"), the entities of the one shortlist stored on the day pointed at. Two stored
 *    shortlists on that day are a clarifying question, never a pick.
 *  - Baselines are loaded through the injected port, eligible claims only (ADR-38) and only for the entities
 *    asked about. Claims that were presented but are not eligible are never baselines: they reach synthesis
 *    as quoted history labelled "not verified", so the answer says what the user saw, not that it was true.
 *  - With no eligible baseline and companies to research, the research still runs and the answer opens with a
 *    code-written statement that nothing earlier can be compared against, so no change since then can be
 *    established; then come the current findings (or their unable_to_verify state). With nothing to research,
 *    a fixed reply says so and offers a web lookup; it never invents a baseline.
 *  - The research itself is the injected ResearchService, with the baselines inside the context.
 */
export const auditLane: LaneHandler = async (input, deps) => {
  const base = { ...emptyContext('audit'), temporal: resolveTemporal(input, deps) };

  const named = resolveEntities(input, deps, input.analysis.entities);
  const ambiguous = ambiguousEntityOutcome(input, base, named);
  if (ambiguous) return ambiguous;

  let conversationIds: ConversationId[] = [input.conversationId];
  let hits: MemoryCandidate[] = base.memoryHits;
  const asksAboutADay = input.analysis.temporal.some((t) => t.role === 'reference_conversation');
  // Nothing stored on the day the user pointed at: the one day, in words, for the code-written sentences below.
  let noRecordDay: string | null = null;
  if (asksAboutADay) {
    const found = recallDay(input, deps, base);
    if (found.kind === 'clarify') return found.outcome;
    if (found.kind === 'none') {
      noRecordDay =
        dayOf(input, base.temporal, 'reference_conversation') ?? found.localDates[0] ?? '';
    }
    if (found.kind === 'found') {
      conversationIds = found.conversationIds;
      hits = found.hits;
    }
  }
  const recalledHits = asksAboutADay ? hits : [];

  // Companies to research: named ones, else the shortlist stored on the day the user pointed at.
  let entities = named.entities;
  let unresolved: EntityMention[] = [];
  let decisions: DecisionRecord[] = base.decisions;
  let capped = named.capped;
  let fromShortlist = false;
  const asksAboutASet = input.analysis.references.some((r) => r.kind === 'entity_set');
  if (asksAboutASet && entities.length === 0 && input.analysis.entities.length === 0) {
    const daysOf = (reference: boolean): DayInterval[] =>
      base.temporal
        .filter((t) => (t.mention.role === 'reference_conversation') === reference)
        .flatMap((t) => t.candidates);
    const referenced = daysOf(true);
    const shortlist = resolveShortlist(
      input,
      deps,
      { ...base, memoryHits: hits },
      referenced.length > 0 ? referenced : daysOf(false),
    );
    if (shortlist.kind === 'clarify') return shortlist.outcome;
    if (shortlist.kind === 'found') {
      fromShortlist = true;
      entities = shortlist.entities;
      unresolved = shortlist.unresolved;
      decisions = shortlist.decisions;
      capped = shortlist.capped;
    }
  }

  // Nobody named and no shortlist: the companies are those the recalled message names (same derivation as the
  // research lane). Several candidate conversations are a question; nothing derivable leaves the fixed reply.
  const took: string[] = [];
  if (
    recalledHits.length > 0 &&
    entities.length === 0 &&
    unresolved.length === 0 &&
    input.analysis.entities.length === 0
  ) {
    const several = severalConversations(input, base, recalledHits);
    if (several) return several;
    const derived = deriveFromRecall(input, deps, recalledHits);
    if (derived.entities.length > 0 || derived.unresolved.length > 0) {
      entities = derived.entities;
      unresolved = derived.unresolved;
      capped = derived.capped;
      took.push(
        `I took the companies from that earlier message: ${listNames([...entities.map((e) => e.name), ...unresolved.map((m) => m.text)])}.`,
      );
    }
  }

  // A set of companies the user points at that nothing stored names ("the 5 CRM tools", with no shortlist and no
  // earlier message found): ask which ones, never search for a guessed set.
  if (
    asksAboutASet &&
    recalledHits.length === 0 &&
    entities.length === 0 &&
    unresolved.length === 0 &&
    input.analysis.entities.length === 0
  ) {
    return unknownShortlistOutcome(
      input,
      deps,
      { ...base, memoryHits: hits, decisions },
      { noRecordDay, asked: [] },
    );
  }

  // Nothing stored on that day. With a subject to look up, the turn continues in the research lane (same turn,
  // same budget) behind one code-written sentence; without one, a fixed reply invites the user to say what it was.
  if (noRecordDay !== null && !fromShortlist) {
    const subject = input.analysis.entities.length > 0 || input.analysis.queries.length > 0;
    if (subject) {
      return researchTurn(input, deps, { noRecordDay });
    }
    emitContext(input, base);
    return {
      kind: 'reply',
      lane: 'audit',
      ctx: base,
      reason: 'no_record',
      sentences: [
        noRecordSentence(noRecordDay),
        ...(isFirstConversation(input, deps) ? [FIRST_CONVERSATION] : []),
        TELL_ME_WHAT_YOU_ASKED,
      ],
    };
  }

  const query = { userId: input.userId, currentTurnId: input.turnId, conversationIds };
  const wanted = new Set(entities.map((e) => e.id));
  const eligible: Baseline[] = deps.baselines
    .eligible(query)
    .filter((b) => wanted.size === 0 || wanted.has(b.entityId));
  const unverified: UnverifiedClaim[] = deps.baselines
    .unverified(query)
    .slice(0, TURN_LIMITS.maxUnverifiedClaims);

  const asked = askedSentences(recalledHits);
  const toResearch =
    entities.length > 0 || unresolved.length > 0 || input.analysis.entities.length > 0;

  if (eligible.length === 0 && unverified.length === 0 && !toResearch) {
    const ctx = { ...base, memoryHits: hits, decisions };
    emitContext(input, ctx);
    return {
      kind: 'reply',
      lane: 'audit',
      ctx,
      reason: 'no_prior_claims',
      sentences:
        asked.length > 0
          ? [
              ...asked,
              'I have no earlier answer of my own on record to check, so I cannot say whether it is still correct.',
              'If you want, I can look the question up now.',
            ]
          : ['I have no earlier claim of mine on this that I can compare against.', OFFER],
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
    entities,
    decisions,
    baselines: eligible,
    memoryHits: [...hits, ...claimHits],
  };
  emitContext(input, ctx);
  if (capped) emitEntityCap(input);
  // Shortlist names with no stored entity yet are researched by name, like any company the user named.
  const researchInput =
    unresolved.length > 0
      ? {
          ...input,
          analysis: { ...input.analysis, entities: [...input.analysis.entities, ...unresolved] },
        }
      : input;
  const outcome = await runResearch(researchInput, deps, ctx, 'audit');
  if (outcome.kind !== 'synthesize') return outcome;
  const noBaseline =
    eligible.length > 0
      ? []
      : [unverified.length > 0 ? NO_VERIFIED_EARLIER_ANSWER : NO_EARLIER_ANSWER_TO_COMPARE];
  // The no-baseline statement already says no change can be established; the sentence below covers the rest.
  const unproven =
    noBaseline.length > 0
      ? null
      : changeNotEstablishedSentence(input, ctx, outcome.findings, recalledHits);
  const lead = [...asked, ...took, ...noBaseline, ...(unproven === null ? [] : [unproven])];
  return { ...outcome, recall, ...(lead.length > 0 ? { lead } : {}) };
};
