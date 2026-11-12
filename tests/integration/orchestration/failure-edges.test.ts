import { describe, expect, it } from 'vitest';
import { DefaultTurnOrchestrator } from '../../../src/orchestration/orchestrator.js';
import { ContractViolationError } from '../../../src/orchestration/errors.js';
import type { ConversationWindowReader, TurnStore } from '../../../src/orchestration/ports.js';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { ReplayMissError } from '../../../src/shared/search.js';
import { LlmError } from '../../../src/shared/llm.js';
import { newId, type EntityId, type SnapshotId, type UserId } from '../../../src/shared/ids.js';
import type { Logger } from '../../../src/shared/infrastructure.js';
import type { MemoryRetriever } from '../../../src/shared/memory.js';
import type { ResearchPlanner } from '../../../src/shared/research.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import type { TurnRequest, TurnState } from '../../../src/shared/turn.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { count, insertEntity, openTestDb, T0, type TestDb } from '../../helpers/db.js';
import {
  analysis,
  answerOf,
  FakeAnalyzer,
  FakeAnswer,
  FakeResearch,
  finding,
  findingSet,
  mention,
  sentence,
  SpyBaselines,
} from '../../unit/orchestration/fakes.js';

/**
 * ADR-39 against the real SqliteTurnRepository and the real migrations: an unexpected error in any non-final
 * state ends in a terminal turn. The analyzer, planner, memory, research service and answer pipeline are
 * doubles that fail on purpose; a TurnStore wrapper injects failures into the state machine itself.
 */

class FixtureMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureMissError';
  }
}

interface Fault {
  /** Throw when the coordinator asks for this state. */
  atSetState?: TurnState;
  /** Apply the real transition first, then throw (a failure after the commit). */
  afterApply?: boolean;
  /** Throw once, then behave. Default: always. */
  once?: boolean;
  error?: Error;
}

/** Delegates to the real repository; injects the configured faults. */
class FaultyTurns implements TurnStore {
  setStateFaults: Fault[] = [];
  completeError: Error | null = null;
  completeCalls = 0;
  failError: Error | null = null;
  failCalls: string[] = [];
  constructor(private readonly inner: TestDb['turns']) {}
  begin: TurnStore['begin'] = (...a) => this.inner.begin(...a);
  setState: TurnStore['setState'] = (userId, turnId, state) => {
    const fault = this.setStateFaults.find((f) => f.atSetState === state);
    if (fault && !fault.afterApply) {
      if (fault.once) this.setStateFaults = this.setStateFaults.filter((f) => f !== fault);
      throw fault.error ?? new TypeError(`injected failure entering ${state}`);
    }
    this.inner.setState(userId, turnId, state);
    if (fault) {
      this.setStateFaults = this.setStateFaults.filter((f) => f !== fault);
      throw fault.error ?? new TypeError(`injected failure after entering ${state}`);
    }
  };
  complete: TurnStore['complete'] = (...a) => {
    this.completeCalls += 1;
    if (this.completeError) throw this.completeError;
    this.inner.complete(...a);
  };
  fail: TurnStore['fail'] = (u, t, code) => {
    this.failCalls.push(code);
    if (this.failError) throw this.failError;
    this.inner.fail(u, t, code);
  };
  get: TurnStore['get'] = (...a) => this.inner.get(...a);
  ack: TurnStore['ack'] = (...a) => this.inner.ack(...a);
  recoverRunning: TurnStore['recoverRunning'] = (...a) => this.inner.recoverRunning(...a);
  deleteConversation: TurnStore['deleteConversation'] = (...a) =>
    this.inner.deleteConversation(...a);
}

function windowReader(t: TestDb): ConversationWindowReader {
  return {
    recent(userId, conversationId, exceptMessageId, limit) {
      return t.messages
        .listByConversation(userId, conversationId)
        .filter((m) => m.id !== exceptMessageId)
        .slice(-limit)
        .map((m) => ({ role: m.role, content: m.content }));
    },
  };
}

function memoryOver(
  t: TestDb,
  entitiesByAlias?: MemoryRetriever['entitiesByAlias'],
): MemoryRetriever {
  const messages = new SqliteMessageMemory(t.db);
  return {
    messagesInIntervals: (u, iv, terms) => messages.messagesInIntervals(u, iv, terms),
    searchAll: (u, terms, limit) => messages.searchAll(u, terms, limit),
    topicalRecall: (...a) => messages.topicalRecall(...a),
    conversationOverview: (...a) => messages.conversationOverview(...a),
    decisions: () => [],
    entitiesByAlias: entitiesByAlias ?? (() => []),
  };
}

const RESEARCH = analysis({
  laneHint: 'research',
  intents: ['pricing'],
  entities: [mention('Zoom')],
});

interface Doubles {
  analyzer?: FakeAnalyzer;
  research?: FakeResearch | ((entityId: EntityId) => FakeResearch);
  answer?: FakeAnswer;
  planner?: ResearchPlanner;
  memory?: (t: TestDb) => MemoryRetriever;
}

interface Logged {
  level: 'warn' | 'error';
  o: object;
  m: string | undefined;
}

function harness(d: Doubles = {}) {
  const t = openTestDb('real');
  const turns = new FaultyTurns(t.turns);
  const userId: UserId = t.users.create();
  const entityId = insertEntity(t.db, { userId, norm: 'zoom' });
  const conversationId = t.conversations.create({ userId }).id;
  const logs: Logged[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (o, m) => logs.push({ level: 'warn', o, m }),
    error: (o, m) => logs.push({ level: 'error', o, m }),
    child: () => logger,
  };
  const orchestrator = new DefaultTurnOrchestrator({
    turns,
    analyzer: d.analyzer ?? new FakeAnalyzer(RESEARCH),
    research:
      typeof d.research === 'function'
        ? d.research(entityId)
        : (d.research ?? new FakeResearch((r) => findingSet(r.turnId, [finding(1, { entityId })]))),
    answer:
      d.answer ?? new FakeAnswer(() => answerOf([sentence(0, 'Hello.', { status: 'no_claims' })])),
    memory: d.memory ? d.memory(t) : memoryOver(t),
    resolver: new DefaultTemporalResolver(),
    baselines: new SpyBaselines(),
    window: windowReader(t),
    clock: t.clock,
    logger,
    ...(d.planner ? { planner: d.planner } : {}),
  });
  const events: SseEvent[] = [];
  const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
    userId,
    conversationId,
    text: 'what does Zoom cost?',
    tz: 'UTC',
    idempotencyKey: 'k1',
    ...over,
  });
  const run = (over: Partial<TurnRequest> = {}) =>
    orchestrator.run(req(over), (e) => events.push(e));
  const row = () =>
    t.db
      .prepare(
        'SELECT state, status, error_code, finished_at FROM turns WHERE user_id = ? ORDER BY started_at, rowid',
      )
      .all(userId) as Array<{
      state: string;
      status: string;
      error_code: string | null;
      finished_at: number | null;
    }>;
  return { t, turns, userId, conversationId, events, logs, run, req, row };
}

type H = ReturnType<typeof harness>;

const SOURCES = {
  [newId('snp') as SnapshotId]: {
    url: 'https://zoom.example/pricing',
    title: null,
    domain: 'zoom.example',
    tier: 'official' as never,
    observedAt: T0,
  },
};
const withSources = new FakeResearch((r) => ({
  ...findingSet(r.turnId, [finding(1)]),
  sources: SOURCES,
}));

/** The turn must be terminal, failed, with no stored answer and nothing asserted. */
function expectFailedTerminal(h: H, code: string): void {
  const [row] = h.row();
  expect(row).toMatchObject({ state: 'COMPLETED', status: 'failed', error_code: code });
  expect(row?.finished_at).not.toBeNull();
  expect(count(h.t.db, 'messages', "user_id = ? AND role = 'assistant'", h.userId)).toBe(0);
  expect(count(h.t.db, 'assertions', '1 = 1')).toBe(0);
  expect(count(h.t.db, 'findings', '1 = 1')).toBe(0);
  const errors = h.events.filter((e) => e.event === 'error');
  expect(errors).toHaveLength(1);
  expect(h.events.some((e) => e.event === 'turn.completed')).toBe(false);
  expect(h.logs.some((l) => l.level === 'error')).toBe(true);
}

interface Case {
  /** The state the turn is in when the error happens. */
  state: TurnState;
  setup: (h: H) => void;
  doubles?: Doubles;
}

const boom = () => new TypeError('injected defect');

const CASES: Case[] = [
  {
    state: 'RECEIVED',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'ANALYZING' }),
  },
  { state: 'ANALYZING', setup: () => undefined, doubles: { analyzer: new FakeAnalyzer(boom()) } },
  {
    state: 'RESOLVING_CONTEXT',
    setup: () => undefined,
    doubles: {
      memory: (t) =>
        memoryOver(t, () => {
          throw boom();
        }),
    },
  },
  {
    state: 'PLANNING',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'SEARCHING' }),
  },
  {
    state: 'SEARCHING',
    setup: () => undefined,
    doubles: { research: new FakeResearch(() => boom()) },
  },
  {
    state: 'EXTRACTING',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'VERIFYING' }),
    doubles: { research: withSources },
  },
  {
    state: 'VERIFYING',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'RESOLVING_BELIEFS' }),
    doubles: { research: withSources },
  },
  {
    state: 'RESOLVING_BELIEFS',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'SYNTHESIZING' }),
  },
  {
    state: 'SYNTHESIZING',
    setup: () => undefined,
    doubles: { answer: new FakeAnswer(() => boom()) },
  },
  {
    state: 'POST_VERIFYING',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'PERSISTING', once: true }),
  },
  {
    state: 'CLARIFYING',
    setup: (h) => h.turns.setStateFaults.push({ atSetState: 'PERSISTING', once: true }),
    doubles: { analyzer: new FakeAnalyzer(analysis({ laneHint: 'clarify' })) },
  },
];

describe('ADR-39: an unexpected error in any state ends in a terminal failed turn', () => {
  it('covers every non-final state except PERSISTING', () => {
    expect(CASES.map((c) => c.state).sort()).toEqual(
      [
        'RECEIVED',
        'ANALYZING',
        'RESOLVING_CONTEXT',
        'CLARIFYING',
        'PLANNING',
        'SEARCHING',
        'EXTRACTING',
        'VERIFYING',
        'RESOLVING_BELIEFS',
        'SYNTHESIZING',
        'POST_VERIFYING',
      ].sort(),
    );
  });

  for (const c of CASES) {
    it(`${c.state}: the error is rethrown, the turn is failed and terminal, nothing is answered or asserted, the next turn is accepted`, async () => {
      const h = harness(c.doubles);
      c.setup(h);
      const run = h.run();
      await expect(run).rejects.toBeInstanceOf(Error);
      // the state the turn was in when it failed was recorded in the visited states
      expectFailedTerminal(h, 'internal_error');
      // text already streamed before the failure (a clarification) is never stored; none is streamed otherwise
      if (c.state !== 'CLARIFYING') {
        expect(h.events.some((e) => e.event === 'answer.delta')).toBe(false);
      }
      const errorEvent = h.events.find((e) => e.event === 'error');
      expect(errorEvent?.data).toMatchObject({ code: 'internal_error', recoverable: false });
      // the stored events include the error, never a completion
      const stored = h.t.db
        .prepare('SELECT events_json FROM turns WHERE user_id = ?')
        .get(h.userId) as { events_json: string };
      expect(stored.events_json).toContain('"error"');
      expect(stored.events_json).not.toContain('turn.completed');

      // the one-running-turn rule is satisfied again: the conversation takes a new turn
      h.turns.setStateFaults = [];
      const next = await new DefaultTurnOrchestrator({
        turns: h.turns,
        analyzer: new FakeAnalyzer(analysis()),
        research: new FakeResearch((r) => findingSet(r.turnId, [])),
        answer: new FakeAnswer(() => answerOf([sentence(0, 'Hi.', { status: 'no_claims' })])),
        memory: memoryOver(h.t),
        resolver: new DefaultTemporalResolver(),
        baselines: new SpyBaselines(),
        window: windowReader(h.t),
        clock: h.t.clock,
      }).run(h.req({ idempotencyKey: 'k2', text: 'hello again' }), () => undefined);
      expect(next.status).toBe('complete');
      expect(h.row()).toHaveLength(2);
      // nothing is left for restart recovery
      expect(h.t.turns.recoverRunning(T0 + 1)).toBe(0);
    });
  }

  it('records the state the failure happened in: the failed turn passed through PERSISTING last', async () => {
    const h = harness({ research: new FakeResearch(() => boom()) });
    await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    const metrics = h.t.db
      .prepare('SELECT metrics_json FROM turns WHERE user_id = ?')
      .get(h.userId) as { metrics_json: string };
    expect((JSON.parse(metrics.metrics_json) as { statesVisited: string[] }).statesVisited).toEqual(
      ['RECEIVED', 'ANALYZING', 'RESOLVING_CONTEXT', 'PLANNING', 'SEARCHING', 'PERSISTING'],
    );
  });

  it('a failure after the transition to PERSISTING was applied is still finalised', async () => {
    const h = harness();
    h.turns.setStateFaults.push({ atSetState: 'PERSISTING', afterApply: true });
    await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    expectFailedTerminal(h, 'internal_error');
  });
});

describe('ADR-39: the error code names the class', () => {
  it('a replay fixture miss from the model fixtures is replay_miss', async () => {
    const h = harness({ analyzer: new FakeAnalyzer(new FixtureMissError('no analysis fixture')) });
    await expect(h.run()).rejects.toBeInstanceOf(FixtureMissError);
    expectFailedTerminal(h, 'replay_miss');
    expect(h.events.find((e) => e.event === 'error')?.data).toMatchObject({ code: 'replay_miss' });
  });

  it('a replay miss from the search fixtures during SEARCHING is replay_miss', async () => {
    const h = harness({
      research: new FakeResearch(() => new ReplayMissError('no search fixture')),
    });
    await expect(h.run()).rejects.toBeInstanceOf(ReplayMissError);
    expectFailedTerminal(h, 'replay_miss');
  });

  it('a replay miss during SYNTHESIZING is replay_miss, with no answer stored', async () => {
    const h = harness({
      answer: new FakeAnswer(() => new FixtureMissError('no synthesis fixture')),
    });
    await expect(h.run()).rejects.toBeInstanceOf(FixtureMissError);
    expectFailedTerminal(h, 'replay_miss');
  });

  it('our own database failing during SEARCHING is persistence:<code>, shown to the client as internal_error', async () => {
    const dbError = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const h = harness({ research: new FakeResearch(() => dbError) });
    await expect(h.run()).rejects.toBe(dbError);
    expectFailedTerminal(h, 'persistence:sqlite_ioerr');
    expect(h.events.find((e) => e.event === 'error')?.data).toMatchObject({
      code: 'internal_error',
    });
    expect(JSON.stringify(h.events)).not.toContain('disk I/O');
  });

  it('a broken contract is contract_violation', async () => {
    const lie = finding(1, { coverage: { ...finding(1).coverage, failure: 'search_timeout' } });
    const h = harness({ research: new FakeResearch((r) => findingSet(r.turnId, [lie])) });
    await expect(h.run()).rejects.toBeInstanceOf(ContractViolationError);
    expectFailedTerminal(h, 'contract_violation');
  });

  it('a provider error that reaches the coordinator from a lane is external_error', async () => {
    const h = harness({ research: new FakeResearch(() => new LlmError('unavailable', 'down')) });
    await expect(h.run()).rejects.toBeInstanceOf(LlmError);
    expectFailedTerminal(h, 'external_error');
  });
});

describe('ADR-39: when the finalising write fails', () => {
  it('falls back to fail() when the turn reached PERSISTING', async () => {
    const h = harness({ research: new FakeResearch(() => boom()) });
    h.turns.completeError = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    await expect(h.run()).rejects.toBeInstanceOf(TypeError); // the original error, not the write error
    expect(h.turns.failCalls).toEqual(['persistence:sqlite_full']);
    expect(h.row()[0]).toMatchObject({
      state: 'FAILED',
      status: 'failed',
      error_code: 'persistence:sqlite_full',
    });
    expect(h.turns.completeCalls).toBeGreaterThan(0);
  });

  it('leaves the turn for restart recovery when even fail() is refused', async () => {
    const h = harness({ research: new FakeResearch(() => boom()) });
    h.turns.completeError = new Error('db gone');
    h.turns.failError = new Error('still gone');
    await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    expect(h.row()[0]).toMatchObject({ state: 'PERSISTING', status: 'running' });
    expect(h.t.turns.recoverRunning(T0 + 1)).toBe(1);
    expect(h.row()[0]).toMatchObject({
      status: 'interrupted',
      error_code: 'recovered_after_restart',
    });
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('leaves the turn for restart recovery when it cannot even move to PERSISTING', async () => {
    const h = harness({ research: new FakeResearch(() => boom()) });
    h.turns.setStateFaults.push({ atSetState: 'PERSISTING' });
    await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    expect(h.row()[0]).toMatchObject({ state: 'SEARCHING', status: 'running' });
    expect(h.turns.failCalls.length).toBeLessThanOrEqual(1); // fail() is refused: not in PERSISTING
    expect(h.t.turns.recoverRunning(T0 + 1)).toBe(1);
    expect(h.row()[0]).toMatchObject({ state: 'SEARCHING', status: 'interrupted' });
  });
});

describe('ADR-39: normal typed outcomes are unchanged', () => {
  it('a clarification stays a clarify turn with its question stored', async () => {
    const h = harness({ analyzer: new FakeAnalyzer(analysis({ laneHint: 'clarify' })) });
    const result = await h.run();
    expect(result.status).toBe('clarify');
    expect(h.row()[0]).toMatchObject({ state: 'COMPLETED', status: 'clarify', error_code: null });
    expect(h.events.filter((e) => e.event === 'error')).toEqual([]);
  });

  it('an interrupted answer stays interrupted, not failed', async () => {
    const h = harness({
      answer: new FakeAnswer(() =>
        answerOf(
          [
            sentence(0, 'Part one.', { status: 'no_claims' }),
            sentence(1, 'Par', { status: 'truncated' }),
          ],
          {
            interrupted: true,
            streamedThrough: 0,
          },
        ),
      ),
    });
    const result = await h.run();
    expect(result.status).toBe('interrupted');
    expect(h.row()[0]).toMatchObject({ status: 'interrupted', error_code: null });
    expect(h.events.filter((e) => e.event === 'error')).toEqual([]);
  });

  it('unable_to_verify findings stay a partial answer', async () => {
    const h = harness({
      research: (entityId) =>
        new FakeResearch((r) =>
          findingSet(r.turnId, [
            finding(1, {
              entityId,
              currentStatus: 'unable_to_verify',
              verdict: 'unable_to_verify',
              verdictReason: 'search_unavailable',
              coverage: {
                ...finding(1).coverage,
                searchesOk: 0,
                searchesFailed: 1,
                failure: 'search_unavailable',
              },
            }),
          ]),
        ),
    });
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(h.row()[0]).toMatchObject({ state: 'COMPLETED', status: 'partial' });
  });

  it('a provider error from the analyzer or the answer pipeline is still a fixed failed reply, not a rethrow', async () => {
    const a = harness({ analyzer: new FakeAnalyzer(new LlmError('unavailable', 'down')) });
    const resultA = await a.run();
    expect(resultA.status).toBe('failed');
    expect(a.row()[0]).toMatchObject({ error_code: 'analysis_degraded' });
    expect(count(a.t.db, 'messages', "user_id = ? AND role = 'assistant'", a.userId)).toBe(1);

    const b = harness({ answer: new FakeAnswer(() => new LlmError('unavailable', 'down')) });
    const resultB = await b.run();
    expect(resultB.status).toBe('failed');
    expect(b.row()[0]).toMatchObject({ error_code: 'synthesis_external_retryable' });
  });
});
