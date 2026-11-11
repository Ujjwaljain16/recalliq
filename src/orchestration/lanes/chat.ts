import { emitContext, emptyContext } from './common.js';
import type { LaneHandler } from './types.js';

/**
 * Chat lane: small talk and follow-ups that need nothing from outside the turn.
 * It makes no search call and reads nothing from the database: the only stored data a chat turn touches
 * is the turn itself, which the orchestrator already persists.
 */
export const chatLane: LaneHandler = (input) => {
  const ctx = emptyContext('chat');
  emitContext(input, ctx);
  return { kind: 'synthesize', lane: 'chat', ctx, findings: null, recall: new Map() };
};
