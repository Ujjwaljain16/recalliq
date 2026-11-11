import { clarifyOutcome, emitContext, emptyContext, resolveTemporal } from './common.js';
import type { LaneHandler } from './types.js';

/**
 * Clarify lane, reached when the analysis itself asks for a clarification. The question is typed and
 * built in code from what the analysis could not resolve; it never names a guess as if it were the answer.
 * Other lanes reach a clarification through `clarifyOutcome` with a more specific reason.
 */
export const clarifyLane: LaneHandler = (input, deps) => {
  const ctx = { ...emptyContext('clarify'), temporal: resolveTemporal(input, deps) };
  emitContext(input, ctx);
  const ref = input.analysis.references[0];
  const question =
    ref === undefined
      ? 'Could you say which conversation, date or company you mean?'
      : `I'm not sure what you mean by "${ref.text}". Could you say which ${labelOf(ref.kind)} you mean?`;
  return clarifyOutcome(input, ctx, 'analysis_requested', question, []);
};

function labelOf(kind: 'previous_answer' | 'decision' | 'conversation' | 'entity_set'): string {
  switch (kind) {
    case 'previous_answer':
      return 'earlier answer';
    case 'decision':
      return 'decision';
    case 'conversation':
      return 'conversation';
    case 'entity_set':
      return 'set of companies';
  }
}
