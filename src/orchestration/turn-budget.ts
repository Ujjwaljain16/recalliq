import type { Clock, BudgetOp, BudgetStage, TurnBudget } from '../shared/infrastructure.js';
import type { Ms } from '../shared/ids.js';
import { DEFAULT_TURN_BUDGET_CONFIG, STAGE_OF_OP, type TurnBudgetConfig } from './config.js';

/** The abort reason of a turn signal that reached the deadline. */
export class DeadlineExceededError extends Error {
  constructor() {
    super('the turn deadline was reached');
    this.name = 'DeadlineExceededError';
  }
}

/** The abort reason of a turn signal aborted by server shutdown. Never raised by a client disconnect. */
export class TurnShutdownError extends Error {
  constructor() {
    super('the server is shutting down');
    this.name = 'TurnShutdownError';
  }
}

export interface BudgetTimers {
  set(fn: () => void, ms: Ms): unknown;
  clear(handle: unknown): void;
}

const systemTimers: BudgetTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface TurnBudgetOptions {
  clock: Clock;
  /** The absolute deadline (epoch ms): turn start + TURN_DEADLINE_MS. */
  deadline: Ms;
  config?: TurnBudgetConfig;
  /**
   * Server shutdown. There is deliberately no parameter for a client disconnect: a disconnect does not
   * cancel a turn (ADR-17), the answer is delivered when the client returns.
   */
  shutdown?: AbortSignal;
  /** Injected for tests; the default is unref'ed setTimeout. */
  timers?: BudgetTimers;
  /** Injected for tests; the default is AbortSignal.timeout. */
  timeoutSignal?: (ms: Ms) => AbortSignal;
}

/**
 * The production TurnBudget (architecture section 4 / H, ADR-24).
 *
 *  - One absolute deadline. `signal` aborts at the deadline (a timer) or on shutdown, not on client disconnect.
 *  - `timeoutFor(stage, cap) = min(cap, remaining - reserve(stage))`; a value <= 0 means the call must not start.
 *  - `signalFor` combines the turn signal with a per-call timeout; when the call must not start it returns a
 *    signal that is already aborted.
 *  - `admit(op)` is `remaining - reserve(stage of op) >= minDuration(op)`.
 *  - Nothing here extends the deadline.
 *
 * Call `dispose()` when the turn ends so that the deadline timer does not outlive it.
 */
export class DeadlineTurnBudget implements TurnBudget {
  readonly deadline: Ms;
  private readonly controller = new AbortController();
  private readonly timers: BudgetTimers;
  private readonly timeoutSignal: (ms: Ms) => AbortSignal;
  private readonly config: TurnBudgetConfig;
  private timer: unknown;
  private readonly onShutdown: (() => void) | null;
  private readonly shutdown: AbortSignal | undefined;

  constructor(private readonly options: TurnBudgetOptions) {
    this.deadline = options.deadline;
    this.config = options.config ?? DEFAULT_TURN_BUDGET_CONFIG;
    this.timers = options.timers ?? systemTimers;
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.shutdown = options.shutdown;

    if (this.remaining() <= 0) {
      this.controller.abort(new DeadlineExceededError());
    } else {
      this.timer = this.timers.set(() => {
        if (!this.controller.signal.aborted) this.controller.abort(new DeadlineExceededError());
      }, this.remaining());
    }

    if (this.shutdown) {
      if (this.shutdown.aborted) {
        this.abortForShutdown();
        this.onShutdown = null;
      } else {
        this.onShutdown = () => this.abortForShutdown();
        this.shutdown.addEventListener('abort', this.onShutdown, { once: true });
      }
    } else {
      this.onShutdown = null;
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once the deadline has passed, whether or not the timer has fired yet. */
  get expired(): boolean {
    return this.remaining() <= 0;
  }

  remaining(): Ms {
    return Math.max(0, this.deadline - this.options.clock.now());
  }

  timeoutFor(stage: BudgetStage, capMs: Ms): Ms {
    return Math.min(capMs, this.remaining() - this.config.reserveMs[stage]);
  }

  signalFor(stage: BudgetStage, capMs: Ms): AbortSignal {
    const timeout = this.timeoutFor(stage, capMs);
    if (timeout <= 0) return AbortSignal.abort(new DeadlineExceededError());
    return AbortSignal.any([this.signal, this.timeoutSignal(timeout)]);
  }

  admit(op: BudgetOp): boolean {
    if (this.signal.aborted) return false;
    const stage = STAGE_OF_OP[op];
    return this.remaining() - this.config.reserveMs[stage] >= this.config.minDurationMs[op];
  }

  /** True when synthesis must run in compact mode (less than SYNTH_COMPACT_BELOW_MS remains). */
  get synthesisShouldCompact(): boolean {
    return this.remaining() < this.config.synthCompactBelowMs;
  }

  dispose(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.shutdown && this.onShutdown)
      this.shutdown.removeEventListener('abort', this.onShutdown);
  }

  private abortForShutdown(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new TurnShutdownError());
  }
}
