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
 * The part research and audit share: plan, hand the plan to the injected ResearchService with the turn's own
 * budget, check what comes back, and advance the turn.
 *
 * The coordinator does not see the service's inner stages, so the extraction and verification states are
 * entered after the service returns, and only when it returned sources. That keeps every transition on one of
 * the 19 existing edges (no failure edge is invented: what a mid-pipeline failure should do is an open design question).
 *
 * `ResearchService.run` does not throw for provider, extraction or deadline failure (those arrive as
 * `unable_to_verify` findings). Anything it does throw is therefore a persistence failure or a defect, and
 * propagates from here untouched. It is never converted into a result.
 */
export async function runResearch(
  input: LaneInput,
  deps: LaneDeps,
  ctx: ResolvedContext,
  lane: 'research' | 'audit',
): Promise<LaneOutcome> {
  const plan = deps.planner.plan(ctx, input.analysis, input.now);
  if (plan.specs.length === 0) {
    return clarifyOutcome(
      input,
      ctx,
      'nothing_to_research',
      'Which company or product should I look into?',
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
  });
  assertFindingSetConsistent(findings, input.turnId);

  if (Object.keys(findings.sources).length > 0) {
    input.progress('EXTRACTING', 'Reading the sources');
    input.progress('VERIFYING', 'Checking the evidence');
  }
  input.progress('RESOLVING_BELIEFS', 'Comparing with what is known');

  return { kind: 'synthesize', lane, ctx, findings, recall: new Map() };
}
