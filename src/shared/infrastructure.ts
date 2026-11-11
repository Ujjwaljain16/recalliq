import type { Ms } from './ids.js';

export interface Clock {
  now(): Ms;
}

export interface Logger {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
  child(b: object): Logger;
}

export type BudgetStage = 'analysis' | 'search' | 'extraction' | 'judge' | 'synthesis';
export type BudgetOp =
  'search_retry' | 'extraction_retry' | 'extraction_split' | 'fallback_round' | 'judge';

// Constants (config): TURN_DEADLINE_MS 60000; caps: analysis 8000, search 6000, extraction 25000,
// judge 4000; reserves: search 13000, extraction 10000, judge → must end by deadline−500;
// minDuration: search_retry 2000, extraction_retry/split 8000, fallback_round 15000, judge 2000;
// SYNTH_COMPACT_BELOW_MS 12000. Implemented with TurnBudget in the orchestration milestone.
export interface TurnBudget {
  readonly deadline: Ms;
  /** Aborts at the deadline or on shutdown; NOT on client disconnect. */
  readonly signal: AbortSignal;
  remaining(): Ms;
  /** min(cap, remaining − reserve(stage)); ≤ 0 means the call must not start. */
  timeoutFor(stage: BudgetStage, capMs: Ms): Ms;
  /** AbortSignal.any([this.signal, AbortSignal.timeout(timeoutFor(...))]) */
  signalFor(stage: BudgetStage, capMs: Ms): AbortSignal;
  /** remaining − reserve(stage) ≥ minDuration(op) */
  admit(op: BudgetOp): boolean;
}
