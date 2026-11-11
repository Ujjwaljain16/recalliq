import type { TurnState } from './turn.js';

/**
 * The turn state machine, exactly as drawn in docs/architecture.md §4 (19 edges).
 *
 * This table is the application-level source of truth. Migration 004 enforces the same table in the
 * database; tests/integration/db/turn-lifecycle.test.ts checks every (from, to) pair against both.
 *
 * Meaning of the final states: COMPLETED = persistence succeeded (the turn's *status* carries the outcome:
 * complete, partial, clarify, interrupted or failed); FAILED = persistence itself failed.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  RECEIVED: ['ANALYZING'],
  ANALYZING: ['RESOLVING_CONTEXT', 'PERSISTING'],
  RESOLVING_CONTEXT: ['CLARIFYING', 'SYNTHESIZING', 'PLANNING'],
  CLARIFYING: ['PERSISTING'],
  PLANNING: ['SEARCHING'],
  SEARCHING: ['EXTRACTING', 'RESOLVING_BELIEFS'],
  EXTRACTING: ['VERIFYING'],
  VERIFYING: ['SEARCHING', 'RESOLVING_BELIEFS'],
  RESOLVING_BELIEFS: ['SYNTHESIZING'],
  SYNTHESIZING: ['POST_VERIFYING', 'PERSISTING'],
  POST_VERIFYING: ['PERSISTING'],
  PERSISTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export const TURN_STATES = Object.keys(TURN_TRANSITIONS) as TurnState[];

export function canTransition(from: TurnState, to: TurnState): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export function isFinalState(state: TurnState): boolean {
  return TURN_TRANSITIONS[state].length === 0;
}
