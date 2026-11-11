import type { Lane, TurnAnalysis } from '../shared/understanding.js';

export type RouteReason = 'hint' | 'recall_asks_still_correct' | 'research_without_subject';

export interface Route {
  lane: Lane;
  reason: RouteReason;
}

/**
 * Deterministic lane decision (architecture section 4, "Lane rules"). `laneHint` is advisory: the rules
 * below override it, and nothing else does. Referents that cannot be resolved turn a lane into `clarify`
 * later, inside the lane handlers, because only they hold the stored data.
 *
 *  - recall + asksStillCorrect       -> audit (the user wants the earlier claim re-checked)
 *  - research with no entity and no query -> chat (nothing to search for, and nothing may be invented)
 *  - otherwise the hint
 */
export function routeTurn(analysis: TurnAnalysis): Route {
  const hint = analysis.laneHint;
  if (hint === 'recall' && analysis.asksStillCorrect) {
    return { lane: 'audit', reason: 'recall_asks_still_correct' };
  }
  if (hint === 'research' && analysis.entities.length === 0 && analysis.queries.length === 0) {
    return { lane: 'chat', reason: 'research_without_subject' };
  }
  return { lane: hint, reason: 'hint' };
}
