import type { IanaTz, Ms } from './ids.js';
import type { TemporalMention } from './understanding.js';

/** A local calendar day as the half-open UTC interval [startMs, endMs). */
export interface DayInterval {
  startMs: Ms;
  endMs: Ms;
  localDate: string;
  tz: IanaTz;
}

export interface ResolvedTemporal {
  mention: TemporalMention;
  candidates: DayInterval[];
  status: 'resolved' | 'ambiguous' | 'unresolved';
}

export interface TemporalResolver {
  resolve(m: TemporalMention[], tz: IanaTz, now: Ms): ResolvedTemporal[];
}
