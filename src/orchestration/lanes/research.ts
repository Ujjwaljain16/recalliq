import type { DayInterval } from '../../shared/temporal.js';
import type { EntityMention } from '../../shared/understanding.js';
import { TURN_LIMITS } from '../config.js';
import {
  ambiguousEntityOutcome,
  askedSentences,
  changeNotEstablishedSentence,
  clarifyOutcome,
  emitContext,
  emitEntityCap,
  emptyContext,
  resolveEntities,
  resolveShortlist,
  resolveTemporal,
} from './common.js';
import { deriveFromRecall, listNames, recallDay, severalConversations } from './recall-context.js';
import { runResearch } from './research-core.js';
import type { LaneHandler } from './types.js';

/**
 * Research lane: "what does X cost now?", "did Y launch anything since Monday?".
 *
 *  1. entities are looked up in memory (one read); a mention matching several stored entities is a
 *     clarifying question, not a pick;
 *  2. a reference to a stored decision or shortlist ("the shortlist since Monday") is read from memory; if
 *     nothing is stored and no entity was named, the user is asked which companies they mean;
 *  3. a day the user points at ("last Tuesday I asked ...") is recalled like the audit lane does; when no company
 *     was named, the companies come from the earlier message itself (its tags and the stored entities it
 *     names), several candidate conversations being a question and never a pick. What was asked opens the answer;
 *  4. the plan is built in code and executed by the injected ResearchService.
 */
export const researchLane: LaneHandler = async (input, deps) => {
  const base = { ...emptyContext('research'), temporal: resolveTemporal(input, deps) };

  const named = resolveEntities(input, deps, input.analysis.entities);
  const ambiguous = ambiguousEntityOutcome(input, base, named);
  if (ambiguous) return ambiguous;

  // The day the user points at, recalled like the audit lane does. No record there changes nothing here.
  const recalled = recallDay(input, deps, base);
  if (recalled.kind === 'clarify') return recalled.outcome;
  const hits = recalled.kind === 'found' ? recalled.hits : [];
  const withHits = { ...base, memoryHits: hits };

  let entities = named.entities;
  let capped = named.capped;
  const wantsStored = input.analysis.references.some(
    (r) => r.kind === 'decision' || r.kind === 'entity_set',
  );
  let decisions = base.decisions;
  let unresolved: EntityMention[] = [];
  // The user points at a day they talked ('On Monday we shortlisted 5 tools'): the one shortlist stored on that
  // day names the companies. Several shortlists on it are a question, not a pick.
  const referenceDays = base.temporal
    .filter((t) => t.mention.role === 'reference_conversation')
    .flatMap((t) => t.candidates);
  const asksAboutASet = input.analysis.references.some((r) => r.kind === 'entity_set');
  let fromReferenceDay = false;
  if (
    asksAboutASet &&
    referenceDays.length > 0 &&
    entities.length === 0 &&
    input.analysis.entities.length === 0
  ) {
    const shortlist = resolveShortlist(input, deps, base, referenceDays);
    if (shortlist.kind === 'clarify') return shortlist.outcome;
    if (shortlist.kind === 'found') {
      fromReferenceDay = true;
      entities = shortlist.entities;
      unresolved = shortlist.unresolved;
      decisions = shortlist.decisions;
      capped = shortlist.capped;
    }
  }
  if (wantsStored && !fromReferenceDay) {
    const intervals: DayInterval[] = base.temporal
      .filter((t) => t.mention.role !== 'reference_conversation')
      .flatMap((t) => t.candidates);
    const kind = input.analysis.references.some((r) => r.kind === 'entity_set')
      ? 'shortlist'
      : null;
    decisions = deps.memory.decisions(input.userId, kind, intervals.length > 0 ? intervals : null);

    const known = new Set([
      ...input.analysis.entities.map((e) => e.normalized),
      ...entities.map((e) => deps.normalize(e.name)),
    ]);
    const stored: EntityMention[] = decisions
      .flatMap((d) => d.payload.entities ?? [])
      .map((text) => ({ text, normalized: deps.normalize(text) }))
      .filter((m) => !known.has(m.normalized));
    if (stored.length > 0) {
      const more = resolveEntities(input, deps, stored);
      const ambiguousStored = ambiguousEntityOutcome(input, base, more);
      if (ambiguousStored) return ambiguousStored;
      const merged = new Map([...entities, ...more.entities].map((e) => [e.id, e]));
      entities = [...merged.values()].slice(0, TURN_LIMITS.maxEntities);
      capped = capped || more.capped;
    }
    if (
      decisions.length === 0 &&
      entities.length === 0 &&
      input.analysis.entities.length === 0 &&
      hits.length === 0
    ) {
      emitContext(input, base);
      return clarifyOutcome(
        input,
        base,
        'missing_referent',
        'I do not have a saved shortlist or decision to go on. Which companies do you mean?',
        [],
      );
    }
  }

  // Nobody was named and no shortlist gave companies: take them from the earlier message the user pointed at.
  const lead = askedSentences(hits);
  if (
    hits.length > 0 &&
    entities.length === 0 &&
    unresolved.length === 0 &&
    input.analysis.entities.length === 0
  ) {
    const several = severalConversations(input, base, hits);
    if (several) return several;
    const derived = deriveFromRecall(input, deps, hits);
    if (derived.entities.length === 0 && derived.unresolved.length === 0) {
      const ctx = { ...withHits, decisions };
      emitContext(input, ctx);
      return clarifyOutcome(
        input,
        ctx,
        'missing_referent',
        [
          ...lead,
          'I could not tell which company you mean from it. Which company or product should I look into?',
        ].join(' '),
        [],
      );
    }
    entities = derived.entities;
    unresolved = derived.unresolved;
    capped = derived.capped;
    lead.push(
      `I took the companies from that earlier message: ${listNames([...entities.map((e) => e.name), ...unresolved.map((m) => m.text)])}.`,
    );
  }

  const ctx = { ...withHits, entities, decisions };
  emitContext(input, ctx);
  if (capped) emitEntityCap(input);
  const researchInput =
    unresolved.length > 0
      ? {
          ...input,
          analysis: { ...input.analysis, entities: [...input.analysis.entities, ...unresolved] },
        }
      : input;
  const outcome = await runResearch(researchInput, deps, ctx, 'research');
  if (outcome.kind !== 'synthesize') return outcome;
  const unproven = changeNotEstablishedSentence(input, ctx, outcome.findings, hits);
  const opening = unproven === null ? lead : [...lead, unproven];
  return opening.length > 0 ? { ...outcome, lead: opening } : outcome;
};
