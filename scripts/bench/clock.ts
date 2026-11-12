import type { Clock } from '../../src/shared/infrastructure.js';
import type { Ms } from '../../src/shared/ids.js';

/**
 * A clock that runs at real speed from a chosen instant. The application reads "now" from it, so a question
 * can be asked "on" its benchmark date, while time still passes during the turn: turn deadlines, the request
 * limiter and provider timeouts all measure elapsed time with this clock, and a frozen clock would stop
 * them from ever seeing time pass.
 */
export class OffsetClock implements Clock {
  private offset = 0;

  constructor(private readonly real: () => Ms = Date.now) {}

  now(): Ms {
    return this.real() + this.offset;
  }

  /** From now on, `now()` reads `at` and moves forward in real time from there. */
  setNow(at: Ms): void {
    this.offset = at - this.real();
  }

  /** Back to the real time. */
  reset(): void {
    this.offset = 0;
  }
}
