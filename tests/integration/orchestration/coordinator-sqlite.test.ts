import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  InvalidCompletionError,
  TurnInProgressError,
} from '../../../src/db/errors.js';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { DefaultTurnOrchestrator } from '../../../src/orchestration/orchestrator.js';
import { TurnStillRunningError } from '../../../src/orchestration/errors.js';
import { TurnShutdownError } from '../../../src/orchestration/turn-budget.js';
import type { ConversationWindowReader } from '../../../src/orchestration/ports.js';
import { newId, type ConversationId, type Ms, type UserId } from '../../../src/shared/ids.js';
import type { MemoryRetriever } from '../../../src/shared/memory.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import type { TurnRequest } from '../../../src/shared/turn.js';
import type { TemporalMention } from '../../../src/shared/understanding.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { SystemClock } from '../../../src/temporal/clock.js';
import { USD_90 } from '../../helpers/turns.js';
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
  SpyBaselines,
  sentence,
  unableFinding,
} from '../../unit/orchestration/fakes.js';

/**
 * The coordinator against the REAL SqliteTurnRepository, real migrations, the real temporal resolver and the
 * real message retriever. The analyzer, research service and answer pipeline are test doubles, so these tests
 * prove the lifecycle, idempotency and persistence wiring only. They do not prove that research or answering works.
 */

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
  entities: MemoryRetriever['entitiesByAlias'] = () => [],
): MemoryRetriever {
  const messages = new SqliteMessageMemory(t.db);
  return {
    messagesInIntervals: (u, iv, terms) => messages.messagesInIntervals(u, iv, terms),
    searchAll: (u, terms, limit) => messages.searchAll(u, terms, limit),
    topicalRecall: (...a) => messages.topicalRecall(...a),
    conversationOverview: (...a) => messages.conversationOverview(...a),
    decisions: () => [],
    entitiesByAlias: entities,
  };
}

interface Doubles {
  analyzer?: FakeAnalyzer;
  research?: FakeResearch;
  answer?: FakeAnswer;
  baselines?: SpyBaselines;
  memory?: MemoryRetriever;
}

function harness(
  d: Doubles = {},
  opts: { deadlineMs?: number; shutdown?: AbortSignal; realClock?: boolean } = {},
) {
  const t = openTestDb('real');
  const userId = t.users.create();
  const conversationId = t.conversations.create({ userId }).id;
  const analyzer = d.analyzer ?? new FakeAnalyzer(analysis());
  const research = d.research ?? new FakeResearch((r) => findingSet(r.turnId, []));
  const answer =
    d.answer ?? new FakeAnswer(() => answerOf([sentence(0, 'Hello.', { status: 'no_claims' })]));
  const baselines = d.baselines ?? new SpyBaselines();
  const orchestrator = new DefaultTurnOrchestrator({
    turns: t.turns,
    analyzer,
    research,
    answer,
    memory: d.memory ?? memoryOver(t),
    resolver: new DefaultTemporalResolver(),
    baselines,
    window: windowReader(t),
    clock: opts.realClock ? new SystemClock() : t.clock,
    ...(opts.deadlineMs !== undefined
      ? { budgetConfig: { ...defaultConfig(), deadlineMs: opts.deadlineMs } }
      : {}),
    ...(opts.shutdown ? { shutdown: opts.shutdown } : {}),
  });
  const events: SseEvent[] = [];
  const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
    userId,
    conversationId,
    text: 'hello',
    tz: 'UTC',
    idempotencyKey: 'k1',
    ...over,
  });
  const run = (over: Partial<TurnRequest> = {}) =>
    orchestrator.run(req(over), (e) => events.push(e));
  return {
    t,
    userId,
    conversationId,
    analyzer,
    research,
    answer,
    baselines,
    orchestrator,
    events,
    run,
    req,
  };
}

function defaultConfig() {
  return {
    deadlineMs: 60_000,
    capMs: { analysis: 8_000, search: 6_000, extraction: 25_000, judge: 4_000, quick: 8_000 },
    reserveMs: {
      analysis: 0,
      search: 13_000,
      extraction: 10_000,
      judge: 500,
      synthesis: 0,
      quick: 13_000,
    },
    minDurationMs: {
      search_retry: 2_000,
      extraction_retry: 8_000,
      extraction_split: 8_000,
      fallback_round: 15_000,
      judge: 2_000,
    },
    synthCompactBelowMs: 12_000,
  };
}

function turnRow(t: TestDb, turnId: string) {
  return t.db
    .prepare(
      'SELECT state, status, lane, error_code, finished_at, assistant_message_id FROM turns WHERE id = ?',
    )
    .get(turnId) as
    | {
        state: string;
        status: string;
        lane: string | null;
        error_code: string | null;
        finished_at: number | null;
        assistant_message_id: string | null;
      }
    | undefined;
}

describe('lifecycle against the real turn repository', () => {
  it('a chat turn goes RECEIVED to COMPLETED and stores the user and assistant messages', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.status).toBe('complete');
    expect(result.assistantMessageId).not.toBeNull();
    const row = turnRow(h.t, result.turnId);
    expect(row).toMatchObject({ state: 'COMPLETED', status: 'complete', lane: 'chat' });
    expect(row?.finished_at).not.toBeNull();
    const messages = h.t.messages.listByConversation(h.userId, h.conversationId);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hello.'],
    ]);
    expect(messages[1]?.streamedThrough).toBe(0);
    expect(result.metrics.statesVisited).toEqual([
      'RECEIVED',
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'SYNTHESIZING',
      'POST_VERIFYING',
      'PERSISTING',
    ]);
    // the chat lane read nothing but the turn's own window: no baseline and no research call
    expect(h.baselines.calls).toEqual([]);
    expect(h.research.calls).toEqual([]);
  });

  it('a research turn persists findings and unpresented assertions; only an acknowledgement presents them', async () => {
    const userEntityHolder: { id?: ReturnType<typeof insertEntity> } = {};
    const h = harness();
    userEntityHolder.id = insertEntity(h.t.db, { userId: h.userId, norm: 'hubspot' });
    const f = finding(1, { entityId: userEntityHolder.id, entityName: 'HubSpot' });
    const research = new FakeResearch((r) => findingSet(r.turnId, [f]));
    const answer = new FakeAnswer(() =>
      answerOf([
        sentence(0, 'HubSpot costs US$90.', {
          placeholders: [{ token: '[[F1]]', findingId: f.id, rendered: 'US$90' }],
        }),
      ]),
    );
    const orchestrator = new DefaultTurnOrchestrator({
      turns: h.t.turns,
      analyzer: new FakeAnalyzer(
        analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('HubSpot')] }),
      ),
      research,
      answer,
      memory: memoryOver(h.t),
      resolver: new DefaultTemporalResolver(),
      baselines: h.baselines,
      window: windowReader(h.t),
      clock: h.t.clock,
    });
    const result = await orchestrator.run(
      h.req({ text: 'What does HubSpot cost?' }),
      () => undefined,
    );
    expect(result.status).toBe('complete');
    expect(count(h.t.db, 'findings', 'turn_id = ?', result.turnId)).toBe(1);
    expect(count(h.t.db, 'assertions', 'turn_id = ?', result.turnId)).toBe(1);
    expect(count(h.t.db, 'assertions', 'turn_id = ? AND presented_at IS NULL', result.turnId)).toBe(
      1,
    );

    // acknowledgement is the only thing that presents (the coordinator never does)
    const ack = h.t.turns.ack(
      h.userId,
      result.turnId,
      { renderedThrough: 0, complete: true },
      h.t.clock.now(),
    );
    expect(ack).toEqual({ renderedThrough: 0, newlyPresented: 1 });
  });

  it('a partial research turn stores status partial and the unable_to_verify finding', async () => {
    const h = harness();
    const entityId = insertEntity(h.t.db, { userId: h.userId, norm: 'notion' });
    const bad = { ...unableFinding(1, 'search_unavailable'), entityId };
    const orchestrator = new DefaultTurnOrchestrator({
      turns: h.t.turns,
      analyzer: new FakeAnalyzer(
        analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Notion')] }),
      ),
      research: new FakeResearch((r) => findingSet(r.turnId, [bad])),
      answer: h.answer,
      memory: memoryOver(h.t),
      resolver: new DefaultTemporalResolver(),
      baselines: h.baselines,
      window: windowReader(h.t),
      clock: h.t.clock,
    });
    const result = await orchestrator.run(h.req({ text: 'Notion price?' }), () => undefined);
    expect(result.status).toBe('partial');
    expect(turnRow(h.t, result.turnId)?.status).toBe('partial');
    const stored = h.t.db
      .prepare('SELECT current_status, verdict FROM findings WHERE turn_id = ?')
      .get(result.turnId);
    expect(stored).toEqual({ current_status: 'unable_to_verify', verdict: 'unable_to_verify' });
  });

  it('an interrupted answer is stored interrupted with its exact streamed extent', async () => {
    const answer = new FakeAnswer(() =>
      answerOf(
        [
          sentence(0, 'First.', { status: 'no_claims' }),
          sentence(1, 'Sec', { status: 'truncated' }),
        ],
        {
          interrupted: true,
          streamedThrough: 0,
        },
      ),
    );
    const h = harness({ answer });
    const result = await h.run();
    expect(result.status).toBe('interrupted');
    const assistant = h.t.messages.listByConversation(h.userId, h.conversationId)[1];
    expect(assistant).toMatchObject({ status: 'interrupted', streamedThrough: 0 });
    expect(turnRow(h.t, result.turnId)?.state).toBe('COMPLETED');
  });

  it('a clarification ends with status clarify, stores the question and the typed options', async () => {
    const lastTuesday: TemporalMention = {
      text: 'last Tuesday',
      expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
      role: 'reference_conversation',
    };
    const h = harness({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [lastTuesday] })),
    });
    seedMessage(h.t, h.userId, Date.UTC(2026, 10, 3, 12), 'tuesday the third');
    seedMessage(h.t, h.userId, Date.UTC(2026, 10, 10, 12), 'tuesday the tenth');
    h.t.clock.set(T0);
    const result = await h.run();
    expect(result.status).toBe('clarify');
    const row = turnRow(h.t, result.turnId);
    expect(row).toMatchObject({ state: 'COMPLETED', status: 'clarify', lane: 'clarify' });
    const context = h.t.db
      .prepare('SELECT context_json FROM turns WHERE id = ?')
      .get(result.turnId) as {
      context_json: string;
    };
    const parsed = JSON.parse(context.context_json) as {
      clarification: { options: Array<{ ref: string }> };
    };
    expect(parsed.clarification.options.map((o) => o.ref).sort()).toEqual([
      'day:2026-11-03',
      'day:2026-11-10',
    ]);
    expect(h.answer.calls).toEqual([]);
  });

  it('a recall with no stored record answers "no record" and stores no assertion', async () => {
    const yesterday: TemporalMention = {
      text: 'yesterday',
      expr: { kind: 'yesterday' },
      role: 'reference_conversation',
    };
    const h = harness({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [yesterday] })),
    });
    const result = await h.run();
    expect(result.status).toBe('complete');
    const assistant = h.t.messages.listByConversation(h.userId, h.conversationId)[1];
    expect(assistant?.content).toMatch(/no record of a conversation on Tuesday 10 November/);
    expect(h.answer.calls).toEqual([]);
    expect(count(h.t.db, 'assertions', 'turn_id = ?', result.turnId)).toBe(0);
  });

  it('a recall with a stored record reaches synthesis with exactly that record', async () => {
    const yesterday: TemporalMention = {
      text: 'yesterday',
      expr: { kind: 'yesterday' },
      role: 'reference_conversation',
    };
    const h = harness({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [yesterday] })),
    });
    const seeded = seedMessage(h.t, h.userId, Date.UTC(2026, 10, 10, 12), 'What does Linear cost?');
    h.t.clock.set(T0);
    const result = await h.run();
    expect(result.status).toBe('complete');
    const input = h.answer.calls[0];
    expect([...(input?.recall.keys() ?? [])]).toEqual([seeded.messageId]);
    expect(input?.recall.get(seeded.messageId)?.text).toContain('What does Linear cost?');
  });
});

describe('idempotent begin against SQLite', () => {
  it('the same key returns the existing turn and runs nothing again', async () => {
    const h = harness();
    const first = await h.run();
    const second = await h.run();
    expect(second.turnId).toBe(first.turnId);
    expect(second.status).toBe('complete');
    expect(second.assistantMessageId).toBe(first.assistantMessageId);
    expect(h.analyzer.calls).toBe(1);
    expect(h.answer.calls).toHaveLength(1);
    expect(count(h.t.db, 'turns', 'user_id = ?', h.userId)).toBe(1);
    expect(count(h.t.db, 'messages', "user_id = ? AND role = 'user'", h.userId)).toBe(1);
  });

  it('the same key with different text is a conflict and nothing runs', async () => {
    const h = harness();
    await h.run();
    await expect(h.run({ text: 'something else' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(h.analyzer.calls).toBe(1);
  });

  it('the same key while that turn is still running is refused with its turn id', async () => {
    const h = harness();
    const began = h.t.turns.begin(h.req(), T0, T0 + 60_000);
    expect('turnId' in began).toBe(true);
    await expect(h.run()).rejects.toBeInstanceOf(TurnStillRunningError);
    expect(h.analyzer.calls).toBe(0);
  });

  it('a second turn in a conversation with a running turn is refused and runs nothing', async () => {
    const h = harness();
    h.t.turns.begin(h.req({ idempotencyKey: 'first' }), T0, T0 + 60_000);
    await expect(h.run({ idempotencyKey: 'second', text: 'again' })).rejects.toBeInstanceOf(
      TurnInProgressError,
    );
    expect(h.analyzer.calls).toBe(0);
  });
});

describe('failure handling against SQLite', () => {
  it('a persistence failure sends the turn through fail(): FAILED, never a normal answer, and the error propagates', async () => {
    const h = harness();
    const entityId = insertEntity(h.t.db, { userId: h.userId, norm: 'zoom' });
    // a baseline that was never presented: the database layer refuses this completion
    const f = finding(1, {
      entityId,
      verdict: 'changed',
      baseline: {
        value: USD_90,
        presentedAt: T0 - 1_000,
        citations: [],
        assertionId: newId('asr'),
      },
    });
    const orchestrator = new DefaultTurnOrchestrator({
      turns: h.t.turns,
      analyzer: new FakeAnalyzer(
        analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Zoom')] }),
      ),
      research: new FakeResearch((r) => findingSet(r.turnId, [f])),
      answer: h.answer,
      memory: memoryOver(h.t),
      resolver: new DefaultTemporalResolver(),
      baselines: h.baselines,
      window: windowReader(h.t),
      clock: h.t.clock,
    });
    const events: SseEvent[] = [];
    await expect(
      orchestrator.run(h.req({ text: 'zoom?' }), (e) => events.push(e)),
    ).rejects.toBeInstanceOf(InvalidCompletionError);
    const row = h.t.db
      .prepare('SELECT state, status, error_code FROM turns WHERE user_id = ?')
      .get(h.userId) as { state: string; status: string; error_code: string };
    expect(row).toEqual({
      state: 'FAILED',
      status: 'failed',
      error_code: 'persistence:InvalidCompletionError',
    });
    // the transaction rolled back: no assistant message, no finding
    expect(count(h.t.db, 'messages', "user_id = ? AND role = 'assistant'", h.userId)).toBe(0);
    expect(count(h.t.db, 'findings', '1 = 1')).toBe(0);
    expect(events.some((e) => e.event === 'turn.completed')).toBe(false);
    expect(events.find((e) => e.event === 'error')?.data).toMatchObject({
      code: 'persistence_failed',
    });
  });

  it('a programmer error mid-turn is rethrown and the turn is finalised as failed, so nothing is left to recover', async () => {
    const h = harness({ analyzer: new FakeAnalyzer(new TypeError('bug')) });
    await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    const row = h.t.db
      .prepare('SELECT state, status, error_code FROM turns WHERE user_id = ?')
      .get(h.userId);
    expect(row).toEqual({ state: 'COMPLETED', status: 'failed', error_code: 'internal_error' });
    expect(h.t.turns.recoverRunning(T0 + 1)).toBe(0);
  });

  it('a degraded analysis stores a failed turn with a fixed reply through ANALYZING to PERSISTING', async () => {
    const h = harness({ analyzer: new FakeAnalyzer(analysis({ degraded: true })) });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(turnRow(h.t, result.turnId)).toMatchObject({
      state: 'COMPLETED',
      status: 'failed',
      error_code: 'analysis_degraded',
    });
    expect(result.metrics.statesVisited).toEqual(['RECEIVED', 'ANALYZING', 'PERSISTING']);
  });
});

describe('deadline and cancellation with the real budget', () => {
  it('a turn that outlives its deadline still persists, partial, with the deadline recorded', async () => {
    const seen: { aborted: boolean; reason: unknown } = { aborted: false, reason: null };
    const analyzer = new FakeAnalyzer(
      analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Asana')] }),
    );
    analyzer.analyze = async (_input, budget) => {
      // the analysis stage runs into the deadline: wait for the turn signal, never for the clock
      await new Promise<void>((resolve) =>
        budget.signal.addEventListener('abort', () => resolve()),
      );
      return analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Asana')] });
    };
    const research = new FakeResearch((r) => {
      seen.aborted = r.budget.signal.aborted;
      seen.reason = r.budget.signal.reason;
      const entityId = insertEntity(h.t.db, { userId: h.userId, norm: 'asana' });
      return findingSet(r.turnId, [{ ...unableFinding(1, 'deadline'), entityId }]);
    });
    const h = harness({ analyzer, research }, { deadlineMs: 60, realClock: true });
    const result = await h.run({ text: 'asana price?' });
    expect(seen.aborted).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.metrics.deadlineHit).toBe(true);
    expect(turnRow(h.t, result.turnId)?.state).toBe('COMPLETED'); // persistence is the only work past the deadline
  });

  it('server shutdown aborts the turn signal; a failing client sink does not', async () => {
    const shutdown = new AbortController();
    const reasons: unknown[] = [];
    const analyzer = new FakeAnalyzer(analysis());
    analyzer.analyze = (_input, budget) => {
      reasons.push(budget.signal.aborted);
      shutdown.abort();
      reasons.push(budget.signal.aborted, budget.signal.reason);
      return Promise.resolve(analysis({ degraded: true }));
    };
    const h = harness({ analyzer }, { shutdown: shutdown.signal });
    await h.run();
    expect(reasons[0]).toBe(false);
    expect(reasons[1]).toBe(true);
    expect(reasons[2]).toBeInstanceOf(TurnShutdownError);

    const quiet = harness();
    const result = await quiet.orchestrator.run(quiet.req(), () => {
      throw new Error('client disconnected');
    });
    expect(result.status).toBe('complete');
  });
});

function seedMessage(
  t: TestDb,
  userId: UserId,
  at: Ms,
  text: string,
  conversationId?: ConversationId,
) {
  t.clock.set(at);
  const conv = conversationId ?? t.conversations.create({ userId }).id;
  const m = t.messages.insert({
    userId,
    conversationId: conv,
    role: 'user',
    content: text,
    tz: 'UTC',
  });
  t.db
    .prepare(
      'INSERT INTO message_search (message_id, user_id, created_at, body, tags) VALUES (?, ?, ?, ?, ?)',
    )
    .run(m.id, userId, at, text, '');
  return { conversationId: conv, messageId: m.id };
}
