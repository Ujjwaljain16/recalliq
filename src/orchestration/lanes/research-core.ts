import type { FindingSet } from '../../shared/findings.js';
import type { ResolvedContext } from '../../shared/memory.js';
import { assertFindingSetConsistent } from '../findings-guard.js';
import { clarifyOutcome } from './common.js';
import type { LaneDeps, LaneInput, LaneOutcome } from './types.js';

function uniqueNames(input: LaneInput, deps: LaneDeps, ctx: ResolvedContext): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const all = [...ctx.entities.map((e) => e.name), ...input.analysis.entities.map((e) => e.text)];
  for (const name of all) {
    const key = deps.normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Every name a sentence about the question's companies may use: their names, aliases, and the first label of
 * their official domains ("freshworks" for Freshsales, whose page is freshworks.com).
 */
function namesAbout(input: LaneInput, deps: LaneDeps, ctx: ResolvedContext): string[] {
  const stems = ctx.entities.flatMap((e) =>
    [...e.officialDomains, ...(e.ownedDomains ?? [])]
      .map((d) => d.replace(/^www./, '').split('.')[0] ?? '')
      .filter((s) => s.length >= 4),
  );
  return [
    ...new Set([
      ...uniqueNames(input, deps, ctx),
      ...ctx.entities.flatMap((e) => e.aliases),
      ...stems,
    ]),
  ].filter((n) => n.trim() !== '');
}

/**
 * The part research and audit share: plan, hand the plan to the injected ResearchService with the turn's own
 * budget, check what comes back, and advance the turn.
 *
 * The coordinator does not see the service's inner stages, so the extraction and verification states are
 * entered after the service returns, and only when it returned sources and the plan asked for extraction (a plan
 * of general queries only is search and synthesis). The plan is empty only when the turn names no entity and the
 * analysis gave no query: then, and only then, the user is asked what to look into (routing normally sends that
 * case to chat; this is the backstop). Every transition is an edge of the state
 * machine table; an unexpected error from any step is finalised by the coordinator (ADR-39), not here.
 *
 * `ResearchService.run` does not throw for provider, extraction or deadline failure (those arrive as
 * `unable_to_verify` findings). Anything it does throw is therefore a persistence failure or a defect, and
 * propagates from here untouched, and the coordinator then finalises the turn as failed. It is never converted into a result.
 */
export async function runResearch(
  input: LaneInput,
  deps: LaneDeps,
  ctx: ResolvedContext,
  lane: 'research' | 'audit',
  options: { quick?: boolean } = {},
): Promise<LaneOutcome> {
  const plan = deps.planner.plan(ctx, input.analysis, input.now);
  if (plan.specs.length === 0) {
    return clarifyOutcome(
      input,
      ctx,
      'nothing_to_research',
      "I need something to look up: which company, product or topic should I search for? I'll check current sources and cite them.",
      [],
    );
  }

  input.progress('PLANNING', 'Planning the searches');
  input.emit({
    event: 'plan',
    data: {
      entities: uniqueNames(input, deps, ctx),
      intents: input.analysis.intents,
      plannedSearches: plan.specs.length,
    },
  });

  // The general research path runs no extraction, so it never enters the extraction and verification states.
  const extracted = [...plan.specs, ...plan.fallback].some((s) => s.intent !== 'general');
  const { onSourcesReady } = input;
  input.progress('SEARCHING', 'Searching');
  const findings = await deps.research.run({
    userId: input.userId,
    turnId: input.turnId,
    ctx,
    analysis: input.analysis,
    plan,
    now: input.now,
    budget: input.budget,
    emit: input.emit,
    ...(options.quick === true && extracted && onSourcesReady
      ? {
          onSourcesReady: (sources: FindingSet['sources']) =>
            onSourcesReady({ ctx, sources, entities: namesAbout(input, deps, ctx) }),
        }
      : {}),
  });
  assertFindingSetConsistent(findings, input.turnId);

  if (extracted && Object.keys(findings.sources).length > 0) {
    input.progress('EXTRACTING', 'Reading the sources');
    input.progress('VERIFYING', 'Checking the evidence');
  }
  input.progress('RESOLVING_BELIEFS', 'Comparing with what is known');

  return { kind: 'synthesize', lane, ctx, findings, recall: new Map() };
}
