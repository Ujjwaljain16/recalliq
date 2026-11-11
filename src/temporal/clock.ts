import type { Clock } from '../shared/infrastructure.js';
import type { Ms } from '../shared/ids.js';

export class SystemClock implements Clock {
  now(): Ms {
    return Date.now();
  }
}

/** Deterministic clock for tests and replay. Time only moves when told to. */
export class FixedClock implements Clock {
  constructor(private current: Ms) {}

  now(): Ms {
    return this.current;
  }

  advance(ms: Ms): void {
    if (ms < 0) throw new RangeError('FixedClock cannot move backwards');
    this.current += ms;
  }

  set(ms: Ms): void {
    this.current = ms;
  }
}
