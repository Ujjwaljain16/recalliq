import type { Lane, TurnAnalysis } from '../shared/understanding.js';

export type RouteReason =
  | 'hint'
  | 'recall_asks_still_correct'
  | 'research_asks_still_correct'
  | 'research_without_subject'
  | 'conversation_recall';

export interface Route {
  lane: Lane;
  reason: RouteReason;
}

/**
 * Deterministic lane decision (architecture section 4, "Lane rules"). `laneHint` is advisory: the rules
 * below override it, and nothing else does. Referents that cannot be resolved turn a lane into `clarify`
 * later, inside the lane handlers, because only they hold the stored data.
 *
 *  - recall + asksStillCorrect or a change_since mention -> audit (the user wants the earlier claim re-checked)
 *  - research + asksStillCorrect -> audit ("is the price you gave me still correct?" is about our own answer;
 *    the model often hints research for it, and only the audit lane looks for that answer)
 *  - research with no entity and no query -> chat (nothing to search for, and nothing may be invented)
 *  - a recall of this conversation (`recallScope`) hinted as chat or clarify -> recall: "what have we talked about
 *    so far?" is answered from the stored messages, never with a question about the day
 *  - otherwise the hint
 */
export function routeTurn(analysis: TurnAnalysis): Route {
  const hint = analysis.laneHint;
  // A recall that also asks what changed since then wants the current state checked: the audit lane.
  const asksWhatChanged = analysis.temporal.some((t) => t.role === 'change_since');
  if (hint === 'recall' && (analysis.asksStillCorrect || asksWhatChanged)) {
    return { lane: 'audit', reason: 'recall_asks_still_correct' };
  }
  // Only when no earlier day is named: a question about a recalled day is the research lane's own case.
  const namesADay = analysis.temporal.some((t) => t.role === 'reference_conversation');
  if (hint === 'research' && analysis.asksStillCorrect && !namesADay) {
    return { lane: 'audit', reason: 'research_asks_still_correct' };
  }
  if (hint === 'research' && analysis.entities.length === 0 && analysis.queries.length === 0) {
    return { lane: 'chat', reason: 'research_without_subject' };
  }
  if (analysis.recallScope === 'conversation' && (hint === 'chat' || hint === 'clarify')) {
    return { lane: 'recall', reason: 'conversation_recall' };
  }
  return { lane: hint, reason: 'hint' };
}
