import type { Db } from '../db/connection.js';
import type { Ms, Origin, SnapshotId, TurnId, UserId } from '../shared/ids.js';
import type { Clock, TurnBudget } from '../shared/infrastructure.js';
import type {
  QuerySpec,
  ResearchExecutor,
  ResearchPlan,
  SearchOutcome,
} from '../shared/research.js';
import {
  ReplayMissError,
  SearchError,
  type SearchErrorCode,
  type SearchPort,
  type SearchResponse,
} from '../shared/search.js';
import type { EventSink } from '../shared/sse.js';
import { SearchLog, type SearchResultLink } from '../sources/search-log.js';
import { SnapshotStore } from '../sources/snapshot-store.js';

export interface SearchExecutorOptions {
  db: Db;
  port: SearchPort;
  clock: Clock;
  /** Executors are per turn: `ResearchExecutor.execute` carries no user or turn, so they are injected here. */
  userId: UserId;
  turnId: TurnId;
  /** Stored on every snapshot. Use 'live' for the real provider, 'recorded' or 'synthetic' for replay. */
  origin: Origin;
  /** Retries after the first attempt. Default 1. */
  maxRetries?: number;
  /** Per-call cap passed to `budget.signalFor('search', cap)`. Default 6000 (architecture H). */
  searchCapMs?: Ms;
  /** Upper bound on one backoff wait. Default 2000. */
  maxBackoffMs?: Ms;
  /** Injected so tests need no real timers. Must reject if `signal` aborts. */
  sleep?: (ms: Ms, signal: AbortSignal) => Promise<void>;
}

const RETRYABLE: ReadonlySet<SearchErrorCode> = new Set(['rate_limited', 'unavailable', 'timeout']);

function realSleep(ms: Ms, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Names that identify an abort/timeout raised by a port that does not use `SearchError`. */
function asSearchError(e: unknown): SearchError | null {
  if (e instanceof SearchError) return e;
  if (e instanceof Error && e.name === 'TimeoutError') return new SearchError('timeout', 'timeout');
  if (e instanceof Error && e.name === 'AbortError')
    return new SearchError('cancelled', 'cancelled');
  return null;
}

type Attempt =
  | { ok: true; response: SearchResponse; latencyMs: Ms }
  | { ok: false; code: SearchErrorCode | 'deadline' };

/**
 * Runs one round of a `ResearchPlan` against a `SearchPort`.
 *
 * - Provider failure (rate limit, quota, timeout, unavailable, bad request, cancel, deadline) is a typed
 *   outcome with `status: 'failed'` and an `errorCode`; it is never thrown and never reported as ok.
 * - `ReplayMissError`, database errors (including ownership triggers) and unknown exceptions propagate.
 * - Retries are bounded, only for rate_limited/unavailable/timeout, and each retry needs `budget.admit('search_retry')`.
 * - Persistence runs even after the deadline (architecture H.6).
 * - `plan.budget.maxSearches` and `maxPerEntity` are the planner's job and are not re-enforced here;
 *   only `plan.budget.concurrency` is used.
 */
export class SearchResearchExecutor implements ResearchExecutor {
  private readonly snapshots: SnapshotStore;
  private readonly log: SearchLog;
  private readonly maxRetries: number;
  private readonly cap: Ms;
  private readonly maxBackoff: Ms;
  private readonly sleep: (ms: Ms, signal: AbortSignal) => Promise<void>;

  constructor(private readonly o: SearchExecutorOptions) {
    this.snapshots = new SnapshotStore(o.db);
    this.log = new SearchLog(o.db);
    this.maxRetries = o.maxRetries ?? 1;
    this.cap = o.searchCapMs ?? 6000;
    this.maxBackoff = o.maxBackoffMs ?? 2000;
    this.sleep = o.sleep ?? realSleep;
  }

  async execute(
    plan: ResearchPlan,
    round: 1 | 2,
    budget: TurnBudget,
    emit: EventSink,
  ): Promise<SearchOutcome[]> {
    const specs = [...plan.specs, ...plan.fallback].filter((s) => s.round === round);
    const outcomes: SearchOutcome[] = new Array<SearchOutcome>(specs.length);
    const concurrency = Math.max(1, Math.min(plan.budget.concurrency, 10, specs.length || 1));

    let next = 0;
    let failure: { error: unknown } | null = null;
    const worker = async (): Promise<void> => {
      while (failure === null) {
        const i = next++;
        const spec = specs[i];
        if (spec === undefined) return;
        try {
          outcomes[i] = await this.runSpec(spec, budget);
        } catch (error) {
          failure ??= { error };
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (failure !== null) throw (failure as { error: unknown }).error;

    const failed = outcomes.filter((o) => o.status === 'failed').length;
    if (failed > 0) {
      emit({
        event: 'warning',
        data: { code: 'search_partial', text: `${failed} of ${outcomes.length} searches failed` },
      });
    }
    return outcomes;
  }

  private async runSpec(spec: QuerySpec, budget: TurnBudget): Promise<SearchOutcome> {
    const startedAt = this.o.clock.now();
    const attempt = await this.attempt(spec, budget);

    if (!attempt.ok) {
      this.log.record(
        {
          turnId: this.o.turnId,
          userId: this.o.userId,
          entityId: spec.entityId,
          intent: spec.intent,
          round: spec.round,
          provider: this.o.port.provider,
          request: spec.request,
          status: 'failed',
          errorCode: attempt.code,
          latencyMs: null,
          costUsd: null,
          startedAt,
        },
        [],
      );
      return { spec, status: 'failed', errorCode: attempt.code, snapshotIds: [] };
    }

    const { response } = attempt;
    const links: SearchResultLink[] = [];
    const seen = new Set<SnapshotId>();
    // Persist the snapshots and the request together: snapshots first (links need them).
    // The snapshot store and the log use the same connection; wrap both in one transaction.
    this.o.db.transaction(() => {
      let rank = 0;
      for (const hit of response.hits) {
        const id = this.snapshots.insert({
          userId: this.o.userId,
          hit,
          contentMode: spec.request.contentMode,
          provider: response.provider,
          observedAt: response.observedAt,
          origin: this.o.origin,
        });
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        links.push({ snapshotId: id, rank, providerScore: hit.providerScore });
        rank += 1;
      }
      this.log.record(
        {
          turnId: this.o.turnId,
          userId: this.o.userId,
          entityId: spec.entityId,
          intent: spec.intent,
          round: spec.round,
          provider: response.provider,
          request: spec.request,
          status: links.length > 0 ? 'ok' : 'empty',
          latencyMs: Math.round(attempt.latencyMs),
          costUsd: response.costUsd,
          startedAt,
        },
        links,
      );
    })();
    return {
      spec,
      status: links.length > 0 ? 'ok' : 'empty',
      snapshotIds: links.map((l) => l.snapshotId),
    };
  }

  private async attempt(spec: QuerySpec, budget: TurnBudget): Promise<Attempt> {
    for (let n = 0; ; n += 1) {
      if (budget.signal.aborted || budget.timeoutFor('search', this.cap) <= 0) {
        return { ok: false, code: 'deadline' };
      }
      if (n > 0 && !budget.admit('search_retry')) return { ok: false, code: 'deadline' };

      const t0 = this.o.clock.now();
      try {
        const response = await this.o.port.search(
          spec.request,
          budget.signalFor('search', this.cap),
        );
        return { ok: true, response, latencyMs: response.latencyMs || this.o.clock.now() - t0 };
      } catch (e) {
        if (e instanceof ReplayMissError) throw e;
        const err = asSearchError(e);
        if (err === null) throw e;
        if (budget.signal.aborted) return { ok: false, code: 'deadline' };
        if (!RETRYABLE.has(err.code) || n >= this.maxRetries) return { ok: false, code: err.code };

        const wait = Math.min(err.retryAfterMs ?? 250 * 2 ** n, this.maxBackoff);
        if (wait >= budget.remaining()) return { ok: false, code: 'deadline' };
        try {
          await this.sleep(wait, budget.signal);
        } catch {
          return { ok: false, code: 'deadline' };
        }
      }
    }
  }
}
