import type { SseEvent } from '../../src/shared/sse.js';

export interface TrailStep {
  key: string;
  label: string;
  detail: string | null;
  state: 'active' | 'done';
  chips: string[];
  more?: number;
}

type EventData<N extends SseEvent['event']> = Extract<SseEvent, { event: N }>['data'];

export interface TrailState {
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  status: string | null;
  steps: TrailStep[];
  plan: EventData<'plan'> | null;
  domains: string[];
  sourceCount: number;
  memoryHits: EventData<'context'>['memoryHits'];
  userMessageId: string | null;
}

export function createTrail(startedAt: number): TrailState;
export function reduceTrail(state: TrailState, e: SseEvent, now: number): TrailState;
export function finishTrail(state: TrailState, status: string, now: number): TrailState;
export function activeStep(state: TrailState): TrailStep | null;
export function trailSummary(s: {
  plannedSearches: number | null;
  sources: number;
  recalled: number;
  elapsedMs: number | null;
  status?: string | null;
}): string;
export function summaryOf(state: TrailState): string;
