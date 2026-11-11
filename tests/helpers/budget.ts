import type { Ms } from '../../src/shared/ids.js';
import type { BudgetOp, BudgetStage, TurnBudget } from '../../src/shared/infrastructure.js';

/**
 * A deterministic TurnBudget for tests. It is NOT the production budget (which applies the stage reserves
 * and minimum durations from architecture §4): every stage gets `min(cap, remaining)` and `admit` is
 * `remaining >= minimumMs`. Time only moves through `spend`.
 */
export class FakeBudget implements TurnBudget {
  private readonly controller = new AbortController();
  private left: Ms;

  constructor(
    totalMs: Ms,
    private readonly nowMs: Ms = 0,
    private readonly minimumMs: Ms = 0,
  ) {
    this.left = totalMs;
  }

  get deadline(): Ms {
    return this.nowMs + this.left;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remaining(): Ms {
    return Math.max(0, this.left);
  }

  spend(ms: Ms): void {
    this.left -= ms;
    if (this.left <= 0) this.controller.abort(new Error('deadline'));
  }

  timeoutFor(_stage: BudgetStage, capMs: Ms): Ms {
    return Math.min(capMs, this.remaining());
  }

  signalFor(stage: BudgetStage, capMs: Ms): AbortSignal {
    return AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, this.timeoutFor(stage, capMs))),
    ]);
  }

  admit(op: BudgetOp): boolean {
    void op;
    return this.remaining() >= this.minimumMs && this.remaining() > 0;
  }
}
