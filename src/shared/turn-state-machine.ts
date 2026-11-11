import type { TurnState } from './turn.js';

/**
 * The turn state machine: the 19 edges of docs/architecture.md section 4 plus the 7 failure edges of ADR-39
 * (26 edges). Every non-final state can reach PERSISTING, so a turn that cannot continue can always be finalised.
 *
 * This table is the application-level source of truth. Migration 010 enforces the same table in the database
 * (it replaces the trigger of migration 004); tests/integration/db/turn-lifecycle.test.ts checks every
 * (from, to) pair against both.
 *
 * Meaning of the final states: COMPLETED = persistence succeeded (the turn's *status* carries the outcome:
 * complete, partial, clarify, interrupted or failed); FAILED = persistence itself failed.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  RECEIVED: ['ANALYZING', 'PERSISTING'],
  ANALYZING: ['RESOLVING_CONTEXT', 'PERSISTING'],
  RESOLVING_CONTEXT: ['CLARIFYING', 'SYNTHESIZING', 'PLANNING', 'PERSISTING'],
  CLARIFYING: ['PERSISTING'],
  PLANNING: ['SEARCHING', 'PERSISTING'],
  SEARCHING: ['EXTRACTING', 'RESOLVING_BELIEFS', 'PERSISTING'],
  EXTRACTING: ['VERIFYING', 'PERSISTING'],
  VERIFYING: ['SEARCHING', 'RESOLVING_BELIEFS', 'PERSISTING'],
  RESOLVING_BELIEFS: ['SYNTHESIZING', 'PERSISTING'],
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
