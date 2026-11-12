import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_BUDGET_CONFIG } from '../../../src/orchestration/config.js';
import {
  DeadlineExceededError,
  DeadlineTurnBudget,
  TurnShutdownError,
  type BudgetTimers,
} from '../../../src/orchestration/turn-budget.js';
import type { BudgetOp, BudgetStage } from '../../../src/shared/infrastructure.js';
import { FixedClock } from '../../../src/temporal/clock.js';

const T0 = 1_000_000;

class ManualTimers implements BudgetTimers {
  pending = new Map<number, { fn: () => void; ms: number }>();
  cleared = 0;
  private next = 1;
  set(fn: () => void, ms: number) {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown) {
    this.cleared += 1;
    this.pending.delete(handle as number);
  }
  fireAll() {
    for (const [id, t] of [...this.pending]) {
      this.pending.delete(id);
      t.fn();
    }
  }
}

function make(opts: { startOffset?: number; shutdown?: AbortSignal } = {}) {
  const clock = new FixedClock(T0);
  const timers = new ManualTimers();
  const timeoutControllers: Array<{ ms: number; controller: AbortController }> = [];
  const budget = new DeadlineTurnBudget({
    clock,
    deadline: T0 + 60_000 + (opts.startOffset ?? 0),
    timers,
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      timeoutControllers.push({ ms, controller });
      return controller.signal;
    },
    ...(opts.shutdown ? { shutdown: opts.shutdown } : {}),
  });
  return { clock, timers, budget, timeoutControllers };
}

describe('DeadlineTurnBudget: one absolute deadline', () => {
  it('uses the constants of architecture section 4', () => {
    expect(DEFAULT_TURN_BUDGET_CONFIG).toEqual({
      deadlineMs: 60_000,
      capMs: { analysis: 8_000, search: 9_000, extraction: 25_000, judge: 4_000, quick: 8_000 },
      reserveMs: {
        analysis: 0,
        search: 13_000,
        extraction: 14_000,
        judge: 500,
        synthesis: 0,
        quick: 13_000,
      },
      minDurationMs: {
        search_retry: 2_000,
        extraction_retry: 8_000,
        extraction_split: 8_000,
        fallback_round: 25_000,
        judge: 2_000,
      },
      synthCompactBelowMs: 12_000,
    });
  });

  it('exposes the deadline and counts down with the clock, never below zero', () => {
    const { budget, clock } = make();
    expect(budget.deadline).toBe(T0 + 60_000);
    expect(budget.remaining()).toBe(60_000);
    clock.advance(45_000);
    expect(budget.remaining()).toBe(15_000);
    clock.advance(999_999);
    expect(budget.remaining()).toBe(0);
    expect(budget.expired).toBe(true);
  });

  it('aborts its signal at the deadline, with a DeadlineExceededError reason', () => {
    const { budget, timers } = make();
    expect(budget.signal.aborted).toBe(false);
    expect([...timers.pending.values()][0]?.ms).toBe(60_000);
    timers.fireAll();
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(DeadlineExceededError);
  });

  it('is already aborted when created after its deadline', () => {
    const clock = new FixedClock(T0);
    const budget = new DeadlineTurnBudget({ clock, deadline: T0 - 1 });
    expect(budget.signal.aborted).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it('aborts on shutdown with a TurnShutdownError reason', () => {
    const shutdown = new AbortController();
    const { budget } = make({ shutdown: shutdown.signal });
    expect(budget.signal.aborted).toBe(false);
    shutdown.abort();
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(TurnShutdownError);
  });

  it('takes no client-disconnect input: its options have no such parameter and the signal stays live', () => {
    // A disconnect is simply not connected to the budget (ADR-17): nothing an SSE sink does can abort it.
    const { budget } = make();
    const sink = new AbortController();
    sink.abort();
    expect(budget.signal.aborted).toBe(false);
  });

  it('dispose clears the deadline timer', () => {
    const { budget, timers } = make();
    budget.dispose();
    expect(timers.cleared).toBe(1);
    expect(timers.pending.size).toBe(0);
  });
});

describe('DeadlineTurnBudget.timeoutFor: min(cap, remaining - reserve)', () => {
  const cases: Array<[BudgetStage, number, number]> = [
    // stage, cap, expected at 60 000 ms remaining
    ['analysis', 8_000, 8_000],
    ['search', 9_000, 9_000],
    ['extraction', 25_000, 25_000],
    ['judge', 4_000, 4_000],
    ['synthesis', 60_000, 60_000],
  ];
  it.each(cases)('%s with a full budget gives its cap', (stage, cap, expected) => {
    expect(make().budget.timeoutFor(stage, cap)).toBe(expected);
  });

  it('subtracts the stage reserve: search keeps 13 s back for synthesis and persistence', () => {
    const { budget, clock } = make();
    clock.advance(45_000); // 15 s remain
    expect(budget.timeoutFor('search', 6_000)).toBe(2_000);
    clock.advance(1_000); // 14 s remain
    expect(budget.timeoutFor('search', 6_000)).toBe(1_000);
  });

  it('is <= 0 once the reserve consumes what is left (the call must not start)', () => {
    const { budget, clock } = make();
    clock.advance(47_000); // 13 s remain = exactly the search reserve
    expect(budget.timeoutFor('search', 6_000)).toBe(0);
    clock.advance(1_000);
    expect(budget.timeoutFor('search', 6_000)).toBeLessThan(0);
  });

  it('extraction reserves 14 s; judge must end 500 ms before the deadline', () => {
    const { budget, clock } = make();
    clock.advance(40_000); // 20 s remain
    expect(budget.timeoutFor('extraction', 25_000)).toBe(6_000);
    clock.advance(18_000); // 2 s remain
    expect(budget.timeoutFor('judge', 4_000)).toBe(1_500);
  });

  it('synthesis runs until the deadline, with no reserve', () => {
    const { budget, clock } = make();
    clock.advance(55_000);
    expect(budget.timeoutFor('synthesis', 60_000)).toBe(5_000);
  });
});

describe('DeadlineTurnBudget.signalFor', () => {
  it('combines the turn signal with a per-call timeout of timeoutFor(stage, cap)', () => {
    const { budget, timeoutControllers } = make();
    const signal = budget.signalFor('search', 6_000);
    expect(timeoutControllers).toHaveLength(1);
    expect(timeoutControllers[0]?.ms).toBe(6_000);
    expect(signal.aborted).toBe(false);
    timeoutControllers[0]?.controller.abort(new Error('call timeout'));
    expect(signal.aborted).toBe(true);
  });

  it('aborts when the turn deadline signal aborts', () => {
    const { budget, timers } = make();
    const signal = budget.signalFor('extraction', 25_000);
    timers.fireAll();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DeadlineExceededError);
  });

  it('returns an already-aborted signal when the call must not start', () => {
    const { budget, clock, timeoutControllers } = make();
    clock.advance(50_000); // 10 s remain < 13 s search reserve
    const signal = budget.signalFor('search', 6_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DeadlineExceededError);
    expect(timeoutControllers).toHaveLength(0);
  });

  it('with the real default timeout, a call signal aborts by itself', async () => {
    const clock = new FixedClock(T0);
    const budget = new DeadlineTurnBudget({ clock, deadline: T0 + 60_000 });
    const signal = budget.signalFor('judge', 5); // min(5, 59 500) = 5 ms
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal.aborted).toBe(true);
    budget.dispose();
  });
});

describe('DeadlineTurnBudget.admit: remaining - reserve >= minDuration', () => {
  const ops: Array<[BudgetOp, number]> = [
    // op, remaining at which it is exactly admitted
    ['search_retry', 13_000 + 2_000],
    ['extraction_retry', 14_000 + 8_000],
    ['extraction_split', 14_000 + 8_000],
    ['fallback_round', 13_000 + 25_000],
    ['judge', 500 + 2_000],
  ];
  it.each(ops)('%s is admitted at the boundary and refused one ms below', (op, boundary) => {
    const { budget, clock } = make();
    clock.set(T0 + 60_000 - boundary);
    expect(budget.admit(op)).toBe(true);
    clock.advance(1);
    expect(budget.admit(op)).toBe(false);
  });

  it('refuses everything once the deadline has fired', () => {
    const { budget, timers } = make();
    timers.fireAll();
    for (const op of [
      'search_retry',
      'extraction_retry',
      'extraction_split',
      'fallback_round',
      'judge',
    ] as const) {
      expect(budget.admit(op)).toBe(false);
    }
  });

  it('flags compact synthesis below 12 s remaining', () => {
    const { budget, clock } = make();
    clock.advance(48_000);
    expect(budget.synthesisShouldCompact).toBe(false);
    clock.advance(1);
    expect(budget.synthesisShouldCompact).toBe(true);
  });

  it('never extends the deadline: admission only shrinks as time passes', () => {
    const { budget, clock } = make();
    const first = budget.deadline;
    clock.advance(30_000);
    budget.admit('fallback_round');
    budget.timeoutFor('search', 6_000);
    budget.signalFor('search', 6_000);
    expect(budget.deadline).toBe(first);
  });
});
