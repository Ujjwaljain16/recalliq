// The activity trail of a turn: what the agent is doing, as a short list of steps, built from the streamed
// events by a pure reducer. The page renders the state; it never decides wording itself.

import { duration, localTimeLabel } from './time.js';

/** Progress stages (src/shared/turn.ts) and the step each one belongs to. */
const STAGE_STEP = {
  ANALYZING: 'understand',
  RESOLVING_CONTEXT: 'understand',
  CLARIFYING: 'clarify',
  PLANNING: 'search',
  SEARCHING: 'search',
  EXTRACTING: 'read',
  VERIFYING: 'check',
  RESOLVING_BELIEFS: 'check',
  SYNTHESIZING: 'write',
  POST_VERIFYING: 'review',
};

const STEP_LABEL = {
  understand: 'Understanding your question',
  clarify: 'Asking which one you mean',
  check: 'Checking the evidence',
  write: 'Writing the answer',
  review: 'Checking the answer',
};

const MAX_CHIPS = 6;

/** @returns {import('./trail.js').TrailState} */
export function createTrail(startedAt) {
  return {
    running: true,
    startedAt,
    endedAt: null,
    status: null,
    steps: [],
    plan: null,
    domains: [],
    sourceCount: 0,
    memoryHits: [],
  };
}

function searchLabel(state) {
  const plan = state.plan;
  if (!plan) return 'Searching the web';
  const searches = `${plan.plannedSearches} search${plan.plannedSearches === 1 ? '' : 'es'}`;
  const names = plan.entities;
  const general = plan.intents.length > 0 && plan.intents.every((i) => i === 'general');
  if (names.length === 0 || general) return `Searching the web · ${searches}`;
  const who = names.length === 1 ? names[0] : `${names.length} companies`;
  return `Searching ${who} · ${searches}`;
}

function readLabel(state) {
  const n = state.sourceCount;
  return n === 0 ? 'Reading the sources' : `Reading ${n} source${n === 1 ? '' : 's'}`;
}

function contextStep(data) {
  const hits = data.memoryHits;
  if (hits.length > 0) {
    const days = new Set(hits.map((h) => h.localTime.slice(0, 10)));
    const label =
      days.size === 1
        ? `Found your conversation from ${localTimeLabel(hits[0].localTime, { long: true })}`
        : `Found ${hits.length} earlier messages`;
    return { key: 'recall', label, detail: hits[0].excerpt, state: 'done', chips: [] };
  }
  const dates = data.resolvedDates.flatMap((d) => d.localDates);
  if (dates.length > 0 && (data.lane === 'recall' || data.lane === 'audit')) {
    const label =
      dates.length === 1
        ? `No earlier conversation on ${localTimeLabel(`${dates[0]} 00:00`, { long: true })}`
        : 'No earlier conversation on those days';
    return { key: 'recall', label, detail: null, state: 'done', chips: [] };
  }
  return null;
}

/** Marks every running step done and starts (or refreshes) step `key`. */
function enter(steps, key, label) {
  const out = steps.map((s) =>
    s.state === 'active' && s.key !== key ? { ...s, state: 'done' } : s,
  );
  const i = out.findIndex((s) => s.key === key);
  if (i === -1) return [...out, { key, label, detail: null, state: 'active', chips: [] }];
  out[i] = { ...out[i], label };
  return out;
}

function relabel(steps, key, patch) {
  return steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
}

/**
 * Folds one streamed event into the trail.
 *
 * @param {import('./trail.js').TrailState} state
 * @param {{ event: string, data: any }} e
 * @param {number} now
 * @returns {import('./trail.js').TrailState}
 */
export function reduceTrail(state, { event, data }, now) {
  if (!state.running) return state;
  switch (event) {
    case 'turn.started':
      return { ...state, steps: enter(state.steps, 'understand', STEP_LABEL.understand) };
    case 'progress': {
      const key = STAGE_STEP[data.stage];
      if (!key) return state;
      const label =
        key === 'search' ? searchLabel(state) : key === 'read' ? readLabel(state) : STEP_LABEL[key];
      return { ...state, steps: enter(state.steps, key, label) };
    }
    case 'context': {
      const step = contextStep(data);
      const next = { ...state, memoryHits: data.memoryHits };
      if (!step || state.steps.some((s) => s.key === 'recall')) return next;
      // shown right after "Understanding your question", without ending whatever is running
      return { ...next, steps: [...state.steps, step] };
    }
    case 'plan': {
      const next = { ...state, plan: data };
      return { ...next, steps: enter(next.steps, 'search', searchLabel(next)) };
    }
    case 'source': {
      const domains = state.domains.includes(data.domain)
        ? state.domains
        : [...state.domains, data.domain];
      const next = { ...state, domains, sourceCount: state.sourceCount + 1 };
      const steps = enter(next.steps, 'read', readLabel(next));
      return {
        ...next,
        steps: relabel(steps, 'read', {
          chips: domains.slice(0, MAX_CHIPS),
          more: Math.max(0, domains.length - MAX_CHIPS),
        }),
      };
    }
    case 'answer.delta':
      return state.steps.some((s) => s.key === 'write')
        ? state
        : { ...state, steps: enter(state.steps, 'write', STEP_LABEL.write) };
    case 'turn.completed':
      return finishTrail(state, data.status, now);
    default:
      return state;
  }
}

/** Ends the trail: every step done, the clock stopped. */
export function finishTrail(state, status, now) {
  return {
    ...state,
    running: false,
    endedAt: now,
    status,
    steps: state.steps.map((s) => (s.state === 'active' ? { ...s, state: 'done' } : s)),
  };
}

/** The step to announce and show as the headline while the turn runs. */
export function activeStep(state) {
  return state.steps.findLast((s) => s.state === 'active') ?? state.steps.at(-1) ?? null;
}

/**
 * The one-line summary of a finished turn: "Searched 12 times · 8 sources · 23 s".
 *
 * @param {{ plannedSearches: number | null, sources: number, recalled: number, elapsedMs: number | null, status?: string | null }} s
 */
export function trailSummary(s) {
  const parts = [];
  if (s.plannedSearches)
    parts.push(`Searched ${s.plannedSearches} time${s.plannedSearches === 1 ? '' : 's'}`);
  if (s.sources > 0) parts.push(`${s.sources} source${s.sources === 1 ? '' : 's'}`);
  if (s.recalled > 0) parts.push(`recalled ${s.recalled} message${s.recalled === 1 ? '' : 's'}`);
  if (parts.length === 0)
    parts.push(s.status === 'interrupted' || s.status === 'failed' ? 'Stopped' : 'Answered');
  else parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  if (s.elapsedMs !== null) parts.push(duration(s.elapsedMs));
  return parts.join(' · ');
}

/** The summary of a live trail. */
export function summaryOf(state) {
  return trailSummary({
    plannedSearches: state.plan?.plannedSearches ?? null,
    sources: state.sourceCount,
    recalled: state.memoryHits.length,
    elapsedMs: state.endedAt === null ? null : state.endedAt - state.startedAt,
    status: state.status,
  });
}
