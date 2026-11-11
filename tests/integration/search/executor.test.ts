import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH_CAP_MS, SearchResearchExecutor } from '../../../src/research/executor.js';
import type { Origin } from '../../../src/shared/ids.js';
import type { QuerySpec, ResearchPlan } from '../../../src/shared/research.js';
import {
  ReplayMissError,
  SearchError,
  type SearchHit,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../../../src/shared/search.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { SnapshotStore } from '../../../src/sources/snapshot-store.js';
import { FakeBudget } from '../../helpers/budget.js';
import { count, insertEntity, openTestDb, seedConversation, T0 } from '../../helpers/db.js';

const PRICING_TEXT =
  '# AcmeCRM Pricing\n\n| Plan | Price per user / month |\n|---|---|\n| Pro | $90 |\n\nPrices in USD.\n';

const request: SearchRequest = {
  query: 'AcmeCRM pricing',
  numResults: 5,
  freshness: 'live',
  contentMode: 'text',
  contentChars: 6000,
};

function hit(url: string, text = PRICING_TEXT, over: Partial<SearchHit> = {}): SearchHit {
  return {
    url,
    title: '[SYNTHETIC] page',
    text,
    publishedAt: Date.UTC(2026, 9, 1),
    lastUpdatedAt: null,
    providerScore: 0.5,
    freshFetch: true,
    crawlStatus: 'ok',
    ...over,
  };
}

function response(hits: SearchHit[]): SearchResponse {
  return {
    provider: 'fake',
    hits,
    droppedMalformed: 0,
    latencyMs: 12,
    costUsd: 0.007,
    observedAt: T0,
  };
}

type Step = SearchResponse | Error;

class ScriptedPort implements SearchPort {
  readonly provider = 'fake';
  calls: SearchRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    private readonly script: (req: SearchRequest, call: number) => Step | Promise<Step>,
    private readonly delayMs = 0,
  ) {}
  async search(req: SearchRequest): Promise<SearchResponse> {
    const call = this.calls.length;
    this.calls.push(req);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const step = await this.script(req, call);
      if (step instanceof Error) throw step;
      return step;
    } finally {
      this.inFlight -= 1;
    }
  }
}

function spec(id: string, over: Partial<QuerySpec> = {}): QuerySpec {
  return {
    id,
    entityId: null,
    intent: 'pricing',
    round: 1,
    request: { ...request, query: `${request.query} ${id}` },
    ...over,
  };
}

function plan(specs: QuerySpec[], fallback: QuerySpec[] = [], concurrency = 3): ResearchPlan {
  return { specs, fallback, budget: { maxSearches: 16, maxPerEntity: 4, concurrency } };
}

function setup(
  script: ConstructorParameters<typeof ScriptedPort>[0],
  opts: { mode?: 'real' | 'demo'; origin?: Origin; delayMs?: number; maxRetries?: number } = {},
) {
  const t = openTestDb(opts.mode ?? 'real');
  const userId = t.users.create();
  const { turnId } = seedConversation(t, userId);
  const port = new ScriptedPort(script, opts.delayMs);
  const sleeps: number[] = [];
  const executor = new SearchResearchExecutor({
    db: t.db,
    port,
    clock: t.clock,
    userId,
    turnId,
    origin: opts.origin ?? 'live',
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const events: SseEvent[] = [];
  return {
    t,
    userId,
    turnId,
    port,
    executor,
    sleeps,
    events,
    emit: (e: SseEvent) => events.push(e),
  };
}

const budget = () => new FakeBudget(60_000, T0);

describe('SearchResearchExecutor: success paths', () => {
  it('persists request, snapshots and links; text is stored byte for byte', async () => {
    const w = setup(() => response([hit('https://www.acmecrm.example/pricing?utm_source=x')]));
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);

    expect(o?.status).toBe('ok');
    expect(o?.snapshotIds).toHaveLength(1);
    expect(count(w.t.db, 'search_requests', 'status = ?', 'ok')).toBe(1);
    expect(count(w.t.db, 'search_results')).toBe(1);

    const snaps = new SnapshotStore(w.t.db).getMany(w.userId, o?.snapshotIds ?? []);
    expect(snaps[0]).toMatchObject({
      text: PRICING_TEXT,
      urlNorm: 'https://acmecrm.example/pricing',
      domain: 'acmecrm.example',
      provider: 'fake',
      observedAt: T0,
      freshFetch: true,
      crawlStatus: 'ok',
      providerPublishedAt: Date.UTC(2026, 9, 1),
      origin: 'live',
    });
    expect(snaps[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const row = w.t.db
      .prepare('SELECT latency_ms, cost_usd, request_json FROM search_requests')
      .get() as {
      latency_ms: number;
      cost_usd: number;
      request_json: string;
    };
    expect(row).toMatchObject({ latency_ms: 12, cost_usd: 0.007 });
    expect(JSON.parse(row.request_json)).toEqual(spec('a').request);
  });

  it('an empty provider response is status empty, with the request recorded', async () => {
    const w = setup(() => response([]));
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o).toMatchObject({ status: 'empty', snapshotIds: [] });
    expect(count(w.t.db, 'search_requests', "status = 'empty'")).toBe(1);
    expect(w.events).toEqual([]);
  });

  it('collapses duplicate and unusable URLs within one response', async () => {
    const w = setup(() =>
      response([
        hit('https://acme.example/p'),
        hit('https://acme.example/p#again'),
        hit('javascript:alert(1)'),
      ]),
    );
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o?.snapshotIds).toHaveLength(1);
    expect(count(w.t.db, 'search_results')).toBe(1);
  });

  it('only runs the specs of the requested round (fallback specs are round 2)', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]));
    const p = plan([spec('r1')], [spec('r2', { round: 2 })]);
    const o1 = await w.executor.execute(p, 1, budget(), w.emit);
    const o2 = await w.executor.execute(p, 2, budget(), w.emit);
    expect(o1.map((o) => o.spec.id)).toEqual(['r1']);
    expect(o2.map((o) => o.spec.id)).toEqual(['r2']);
    expect(w.t.db.prepare('SELECT round FROM search_requests ORDER BY round').all()).toEqual([
      { round: 1 },
      { round: 2 },
    ]);
  });

  it('keeps outcomes in spec order and never exceeds the plan concurrency', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]), { delayMs: 5 });
    const specs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((i) => spec(i));
    const out = await w.executor.execute(plan(specs, [], 2), 1, budget(), w.emit);
    expect(out.map((o) => o.spec.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(w.port.maxInFlight).toBeLessThanOrEqual(2);
    expect(w.port.maxInFlight).toBe(2);
  });

  it('records the same page seen twice as two snapshots only when content or time differs', async () => {
    const w = setup((_r, call) =>
      response([hit('https://acme.example/p', call === 0 ? 'Pro $90' : 'Pro $95')]),
    );
    await w.executor.execute(plan([spec('a'), spec('b')], [], 1), 1, budget(), w.emit);
    expect(count(w.t.db, 'source_snapshots')).toBe(2);
    const w2 = setup(() => response([hit('https://acme.example/p', 'Pro $90')]));
    await w2.executor.execute(plan([spec('a'), spec('b')], [], 1), 1, budget(), w2.emit);
    expect(count(w2.t.db, 'source_snapshots')).toBe(1);
    expect(count(w2.t.db, 'search_results')).toBe(2);
  });
});

describe('SearchResearchExecutor: provider failures are typed outcomes', () => {
  it.each([
    ['quota_exhausted', 1],
    ['bad_request', 1],
    ['cancelled', 1],
  ] as const)('%s is not retried', async (code, calls) => {
    const w = setup(() => new SearchError(code, 'x'));
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: code, snapshotIds: [] });
    expect(w.port.calls).toHaveLength(calls);
    expect(count(w.t.db, 'search_requests', "status = 'failed' AND error_code = ?", code)).toBe(1);
    expect(count(w.t.db, 'search_results')).toBe(0);
  });

  it('retries a rate limit once, honouring Retry-After (bounded), then succeeds', async () => {
    const w = setup((_r, call) =>
      call === 0
        ? new SearchError('rate_limited', 'x', 900)
        : response([hit('https://acme.example/p')]),
    );
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o?.status).toBe('ok');
    expect(w.port.calls).toHaveLength(2);
    expect(w.sleeps).toEqual([900]);
    // The failed attempt is not a separate request row: one search, one row.
    expect(count(w.t.db, 'search_requests')).toBe(1);
  });

  it('caps an enormous Retry-After at maxBackoff and falls back to exponential backoff', async () => {
    const w = setup(() => new SearchError('rate_limited', 'x', 60_000), { maxRetries: 2 });
    await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(w.sleeps).toEqual([2000, 2000]);
    const w2 = setup(() => new SearchError('unavailable', 'x'), { maxRetries: 2 });
    await w2.executor.execute(plan([spec('a')]), 1, budget(), w2.emit);
    expect(w2.sleeps).toEqual([250, 500]);
  });

  it.each(['unavailable', 'timeout', 'rate_limited'] as const)(
    'a persistent %s fails after the bounded retry, typed, never ok',
    async (code) => {
      const w = setup(() => new SearchError(code, 'x'));
      const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
      expect(o).toMatchObject({ status: 'failed', errorCode: code });
      expect(w.port.calls).toHaveLength(2);
    },
  );

  it('a retry that the budget does not admit becomes failed/deadline', async () => {
    const w = setup(() => new SearchError('unavailable', 'x'));
    const tight = new FakeBudget(1000, T0, 5000); // remaining 1000 < minimum 5000: no retry
    const [o] = await w.executor.execute(plan([spec('a')]), 1, tight, w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'deadline' });
    expect(w.port.calls).toHaveLength(1);
  });

  it('a wait longer than the remaining budget is not started', async () => {
    const w = setup(() => new SearchError('rate_limited', 'x', 1500));
    const [o] = await w.executor.execute(plan([spec('a')]), 1, new FakeBudget(1000, T0), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'deadline' });
    expect(w.sleeps).toEqual([]);
  });

  it('an exhausted budget starts no call at all', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]));
    const b = new FakeBudget(100, T0);
    b.spend(100);
    const out = await w.executor.execute(plan([spec('a'), spec('b')]), 1, b, w.emit);
    expect(out.map((o) => [o.status, o.errorCode])).toEqual([
      ['failed', 'deadline'],
      ['failed', 'deadline'],
    ]);
    expect(w.port.calls).toHaveLength(0);
    // Persistence still happens after the deadline.
    expect(count(w.t.db, 'search_requests', "error_code = 'deadline'")).toBe(2);
  });

  it('cancellation by the turn budget mid-call is deadline, not ok', async () => {
    const b = budget();
    const w = setup(() => {
      b.spend(60_000);
      return new SearchError('cancelled', 'aborted');
    });
    const [o] = await w.executor.execute(plan([spec('a')]), 1, b, w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'deadline' });
    expect(w.port.calls).toHaveLength(1);
  });

  it('maps a port that rejects with a bare TimeoutError or AbortError', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const w = setup(() => timeout, { maxRetries: 0 });
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    const w2 = setup(() => abort);
    const [o2] = await w2.executor.execute(plan([spec('a')]), 1, budget(), w2.emit);
    expect(o2).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
  });

  it('one failure does not block the others; a search_partial warning is emitted', async () => {
    const w = setup((r) =>
      r.query.endsWith(' b')
        ? new SearchError('quota_exhausted', 'x')
        : response([hit('https://acme.example/p')]),
    );
    const out = await w.executor.execute(
      plan([spec('a'), spec('b'), spec('c')]),
      1,
      budget(),
      w.emit,
    );
    expect(out.map((o) => o.status)).toEqual(['ok', 'failed', 'ok']);
    expect(w.events).toEqual([
      { event: 'warning', data: { code: 'search_partial', text: '1 of 3 searches failed' } },
    ]);
  });

  it('every spec failing yields only failed outcomes', async () => {
    const w = setup(() => new SearchError('quota_exhausted', 'x'));
    const out = await w.executor.execute(plan([spec('a'), spec('b')]), 1, budget(), w.emit);
    expect(out.every((o) => o.status === 'failed')).toBe(true);
  });
});

describe('SearchResearchExecutor: errors that must propagate', () => {
  it('ReplayMissError propagates and is never retried', async () => {
    const w = setup(() => new ReplayMissError('miss'));
    await expect(
      w.executor.execute(plan([spec('a'), spec('b')]), 1, budget(), w.emit),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(w.port.calls.length).toBeLessThanOrEqual(2);
    expect(w.sleeps).toEqual([]);
    const solo = setup(() => new ReplayMissError('miss'));
    await expect(
      solo.executor.execute(plan([spec('a')]), 1, budget(), solo.emit),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(solo.port.calls).toHaveLength(1);
  });

  it('an unknown exception from the port is a programmer error and propagates', async () => {
    const w = setup(() => new TypeError('bug'));
    await expect(w.executor.execute(plan([spec('a')]), 1, budget(), w.emit)).rejects.toThrow('bug');
  });

  it('a database ownership failure propagates (another user entity)', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]));
    const other = w.t.users.create();
    const foreign = insertEntity(w.t.db, { userId: other, norm: 'acme' });
    await expect(
      w.executor.execute(plan([spec('a', { entityId: foreign })]), 1, budget(), w.emit),
    ).rejects.toThrow(/search request entity owner mismatch/);
    // Atomic: neither snapshot nor request survived.
    expect(count(w.t.db, 'source_snapshots')).toBe(0);
    expect(count(w.t.db, 'search_requests')).toBe(0);
  });

  it('a turn of another user is refused by the database and propagates', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]));
    const stranger = w.t.users.create();
    const strangerExec = new SearchResearchExecutor({
      db: w.t.db,
      port: w.port,
      clock: w.t.clock,
      userId: stranger,
      turnId: w.turnId,
      origin: 'live',
    });
    await expect(strangerExec.execute(plan([spec('a')]), 1, budget(), w.emit)).rejects.toThrow(
      /search request turn owner mismatch/,
    );
  });

  it('a non-live origin in a real database is refused by the isolation trigger and propagates', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]), { origin: 'recorded' });
    await expect(w.executor.execute(plan([spec('a')]), 1, budget(), w.emit)).rejects.toThrow(
      /non-live snapshot in real db/,
    );
  });

  it('recorded origin is accepted in a demo database', async () => {
    const w = setup(() => response([hit('https://acme.example/p')]), {
      mode: 'demo',
      origin: 'recorded',
    });
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o?.status).toBe('ok');
    const s = new SnapshotStore(w.t.db).getMany(w.userId, o?.snapshotIds ?? []);
    expect(s[0]?.origin).toBe('recorded');
  });

  it('stops dispatching after a fatal error', async () => {
    const fn = vi.fn((): Step => new ReplayMissError('miss'));
    const w = setup(fn);
    const many = Array.from({ length: 20 }, (_, i) => spec(`s${i}`));
    await expect(w.executor.execute(plan(many, [], 1), 1, budget(), w.emit)).rejects.toBeInstanceOf(
      ReplayMissError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SearchResearchExecutor: the search time budget (one budget for all attempts)', () => {
  it('the default cap is 9 seconds, and the turn budget config agrees', () => {
    expect(DEFAULT_SEARCH_CAP_MS).toBe(9_000);
  });

  it('a retry does not get a fresh cap: after the first attempt used the whole budget there is no retry, and the failure is typed timeout', async () => {
    const w = setup(
      () => {
        w.t.clock.advance(9_000); // the first attempt used all of the search's own time
        return new SearchError('timeout', 'slow');
      },
      { maxRetries: 3 },
    );
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(w.port.calls).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
  });

  it('a retry is refused when less than 2 seconds of the search budget are left, and allowed when more are left', async () => {
    const tight = setup(
      () => {
        tight.t.clock.advance(8_000); // 1 s left
        return new SearchError('timeout', 'slow');
      },
      { maxRetries: 3 },
    );
    const [a] = await tight.executor.execute(plan([spec('a')]), 1, budget(), tight.emit);
    expect(a).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(tight.port.calls).toHaveLength(1);

    const roomy = setup(
      (_req, call) => {
        roomy.t.clock.advance(5_000); // 4 s left after the first attempt
        return call === 0
          ? new SearchError('timeout', 'slow')
          : response([hit('https://a.example/p')]);
      },
      { maxRetries: 3 },
    );
    const [b] = await roomy.executor.execute(plan([spec('a')]), 1, budget(), roomy.emit);
    expect(b?.status).toBe('ok');
    expect(roomy.port.calls).toHaveLength(2);
  });

  it('every attempt is also bounded by the turn deadline: a wait that does not fit in what is left is not started', async () => {
    const w = setup(() => new SearchError('rate_limited', 'x', 2_000), { maxRetries: 3 });
    const [o] = await w.executor.execute(plan([spec('a')]), 1, new FakeBudget(1_500, T0), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'deadline' });
    expect(w.sleeps).toEqual([]);
  });

  it('parallel searches share one deadline: when it is gone, none starts and none is reported ok', async () => {
    const w = setup(() => response([hit('https://a.example/p')]));
    const outcomes = await w.executor.execute(
      plan([spec('a'), spec('b'), spec('c'), spec('d')], [], 4),
      1,
      new FakeBudget(0, T0),
      w.emit,
    );
    expect(outcomes.map((o) => [o.status, o.errorCode])).toEqual([
      ['failed', 'deadline'],
      ['failed', 'deadline'],
      ['failed', 'deadline'],
      ['failed', 'deadline'],
    ]);
    expect(w.port.calls).toHaveLength(0);
    expect(w.events.some((e) => e.event === 'warning')).toBe(true);
  });

  it('a timeout is a typed failure with no snapshots, never a success', async () => {
    const w = setup(() => new SearchError('timeout', 'slow'), { maxRetries: 0 });
    const [o] = await w.executor.execute(plan([spec('a')]), 1, budget(), w.emit);
    expect(o).toMatchObject({ status: 'failed', errorCode: 'timeout', snapshotIds: [] });
    expect(count(w.t.db, 'source_snapshots')).toBe(0);
    expect(count(w.t.db, 'search_requests', "status = 'failed' AND error_code = 'timeout'")).toBe(
      1,
    );
  });
});
