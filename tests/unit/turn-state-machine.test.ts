import { describe, expect, it } from 'vitest';
import { deliveryState } from '../../src/shared/delivery.js';
import {
  canTransition,
  isFinalState,
  TURN_STATES,
  TURN_TRANSITIONS,
} from '../../src/shared/turn-state-machine.js';

describe('turn state machine (architecture §4)', () => {
  it('has the fourteen states of the contract', () => {
    expect([...TURN_STATES].sort()).toEqual(
      [
        'RECEIVED',
        'ANALYZING',
        'RESOLVING_CONTEXT',
        'CLARIFYING',
        'PLANNING',
        'SEARCHING',
        'EXTRACTING',
        'VERIFYING',
        'RESOLVING_BELIEFS',
        'SYNTHESIZING',
        'POST_VERIFYING',
        'PERSISTING',
        'COMPLETED',
        'FAILED',
      ].sort(),
    );
  });

  it('has exactly the nineteen edges of the diagram', () => {
    const edges = TURN_STATES.flatMap((from) =>
      TURN_TRANSITIONS[from].map((to) => `${from}>${to}`),
    );
    expect(edges.sort()).toEqual(
      [
        'RECEIVED>ANALYZING',
        'ANALYZING>RESOLVING_CONTEXT',
        'ANALYZING>PERSISTING',
        'RESOLVING_CONTEXT>CLARIFYING',
        'RESOLVING_CONTEXT>SYNTHESIZING',
        'RESOLVING_CONTEXT>PLANNING',
        'CLARIFYING>PERSISTING',
        'PLANNING>SEARCHING',
        'SEARCHING>EXTRACTING',
        'SEARCHING>RESOLVING_BELIEFS',
        'EXTRACTING>VERIFYING',
        'VERIFYING>SEARCHING',
        'VERIFYING>RESOLVING_BELIEFS',
        'RESOLVING_BELIEFS>SYNTHESIZING',
        'SYNTHESIZING>POST_VERIFYING',
        'SYNTHESIZING>PERSISTING',
        'POST_VERIFYING>PERSISTING',
        'PERSISTING>COMPLETED',
        'PERSISTING>FAILED',
      ].sort(),
    );
  });

  it('canTransition agrees with the table for every one of the 196 ordered pairs', () => {
    for (const from of TURN_STATES) {
      for (const to of TURN_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          TURN_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it('allows no self-transitions and no way back out of a final state', () => {
    for (const state of TURN_STATES) expect(canTransition(state, state)).toBe(false);
    expect(isFinalState('COMPLETED')).toBe(true);
    expect(isFinalState('FAILED')).toBe(true);
    expect(TURN_STATES.filter(isFinalState).sort()).toEqual(['COMPLETED', 'FAILED']);
  });

  it('every non-final state can reach a final state (no dead ends)', () => {
    for (const start of TURN_STATES) {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length > 0) {
        const state = queue.shift();
        if (!state) break;
        for (const next of TURN_TRANSITIONS[state]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].some(isFinalState), `from ${start}`).toBe(true);
    }
  });

  it('every state is reachable from RECEIVED', () => {
    const seen = new Set(['RECEIVED']);
    const queue = ['RECEIVED' as (typeof TURN_STATES)[number]];
    while (queue.length > 0) {
      const state = queue.shift();
      if (!state) break;
      for (const next of TURN_TRANSITIONS[state]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...TURN_STATES].sort());
  });
});

describe('deliveryState: streamed extent and rendered extent are distinct', () => {
  const msg = (renderedThrough: number, streamedThrough: number | null) => ({
    renderedThrough,
    streamedThrough,
  });

  it('a sentence at or below the rendered extent is presented', () => {
    expect(deliveryState(0, msg(0, 5))).toBe('presented');
    expect(deliveryState(3, msg(3, 5))).toBe('presented');
    expect(deliveryState(2, msg(3, 5))).toBe('presented');
  });

  it('a streamed sentence beyond the rendered extent is streamed_unacknowledged, never presented', () => {
    expect(deliveryState(4, msg(3, 5))).toBe('streamed_unacknowledged');
    expect(deliveryState(5, msg(3, 5))).toBe('streamed_unacknowledged');
    expect(deliveryState(0, msg(-1, 5))).toBe('streamed_unacknowledged');
  });

  it('a sentence beyond the streamed extent is not_streamed', () => {
    expect(deliveryState(6, msg(3, 5))).toBe('not_streamed');
    expect(deliveryState(0, msg(-1, -1))).toBe('not_streamed');
  });

  it('a message that was never streamed (a user message) has nothing presented or streamed', () => {
    expect(deliveryState(0, msg(-1, null))).toBe('not_streamed');
  });

  it('is exhaustive and ordered: presented < streamed_unacknowledged < not_streamed as the index grows', () => {
    const states = Array.from({ length: 8 }, (_, i) => deliveryState(i, msg(2, 5)));
    expect(states).toEqual([
      'presented',
      'presented',
      'presented',
      'streamed_unacknowledged',
      'streamed_unacknowledged',
      'streamed_unacknowledged',
      'not_streamed',
      'not_streamed',
    ]);
  });

  it('throws on an impossible extent pair instead of guessing', () => {
    expect(() => deliveryState(0, msg(4, 2))).toThrow(RangeError);
    expect(() => deliveryState(0, msg(0, null))).toThrow(RangeError);
  });

  it('rejects a negative or fractional sentence index', () => {
    expect(() => deliveryState(-1, msg(-1, 3))).toThrow(RangeError);
    expect(() => deliveryState(1.5, msg(-1, 3))).toThrow(RangeError);
  });
});
