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
  noRecordConsequence,
  nothingToSearchOutcome,
  resolveEntities,
  resolveShortlist,
  resolveTemporal,
  unknownShortlistOutcome,
} from './common.js';
import { deriveFromRecall, listNames, recallDay, severalConversations } from './recall-context.js';
import { runResearch } from './research-core.js';
import type { LaneDeps, LaneHandler, LaneInput, LaneOutcome } from './types.js';

export interface ResearchOptions {
  /**
   * Set when the audit lane found nothing stored for the day the user pointed at and hands the turn over: that
   * day, in words. A code-written sentence naming it opens the answer (or the question, when nothing can be
   * searched), the day is not recalled a second time, and the "no change can be established" sentence is not
   * added, because the opening one already says it.
   */
  noRecordDay?: string;
}

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
 *  4. the plan is built in code and executed by the injected ResearchService. A plan with no search (only a
 *     category was given) is a question about which companies to check, never a guessed search.
 *
 * The audit lane hands a turn over through `researchTurn` when nothing is stored for the day the user pointed at.
 */
export const researchLane: LaneHandler = (input, deps) => researchTurn(input, deps);

export async function researchTurn(
  input: LaneInput,
  deps: LaneDeps,
  options: ResearchOptions = {},
): Promise<LaneOutcome> {
  const base = { ...emptyContext('research'), temporal: resolveTemporal(input, deps) };

  const named = resolveEntities(input, deps, input.analysis.entities);
  const ambiguous = ambiguousEntityOutcome(input, base, named);
  if (ambiguous) return ambiguous;

  // The day the user points at, recalled like the audit lane does. No record there changes nothing here.
  const recalled =
    options.noRecordDay === undefined
      ? recallDay(input, deps, base)
      : ({ kind: 'not_referenced' } as const);
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
      if (asksAboutASet) {
        return unknownShortlistOutcome(input, deps, base, {
          noRecordDay: options.noRecordDay ?? null,
          asked: [],
        });
      }
      emitContext(input, base);
      return clarifyOutcome(
        input,
        base,
        'missing_referent',
        "I don't have a saved decision on record to go on, so I can't tell which companies you mean. Which companies should I look into? I'll check their current pricing and recent releases.",
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
          "I could not tell which company you mean from it, and I won't guess. Which company or product should I look into? I'll check its current pricing and recent releases.",
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
  const researchInput =
    unresolved.length > 0
      ? {
          ...input,
          analysis: { ...input.analysis, entities: [...input.analysis.entities, ...unresolved] },
        }
      : input;
  const noRecord = (findings: boolean): string[] =>
    options.noRecordDay === undefined
      ? []
      : [noRecordConsequence(input, options.noRecordDay, findings)];
  // Only a category was given ("Postgres hosting"): nothing the planner can search for. Ask, saying why.
  if (deps.planner.plan(ctx, researchInput.analysis, input.now).specs.length === 0) {
    return nothingToSearchOutcome(input, ctx, [...noRecord(false), ...lead]);
  }
  emitContext(input, ctx);
  if (capped) emitEntityCap(input);
  // The quick sourced answer follows the sentences written in code that are known before the search (what was
  // recalled): the quick section releases them first. A sentence that can be written only once the findings
  // are known comes after it.
  let leadSent = false;
  const quickInput =
    lead.length > 0 && researchInput.onSourcesReady
      ? {
          ...researchInput,
          onSourcesReady: (ready: Parameters<NonNullable<typeof input.onSourcesReady>>[0]) => {
            leadSent = true;
            input.onSourcesReady?.({ ...ready, lead: [...lead] });
          },
        }
      : researchInput;
  const outcome = await runResearch(quickInput, deps, ctx, 'research', {
    quick: options.noRecordDay === undefined,
  });
  if (outcome.kind !== 'synthesize') return outcome;
  const unproven =
    options.noRecordDay === undefined
      ? changeNotEstablishedSentence(input, ctx, outcome.findings, hits)
      : null;
  const opening = [
    ...noRecord(true),
    ...(leadSent ? [] : lead),
    ...(unproven === null ? [] : [unproven]),
  ];
  return opening.length > 0 ? { ...outcome, lead: opening } : outcome;
}
