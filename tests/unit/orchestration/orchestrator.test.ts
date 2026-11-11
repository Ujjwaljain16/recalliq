import { describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/shared/llm.js';
import { newId } from '../../../src/shared/ids.js';
import type { TemporalResolver } from '../../../src/shared/temporal.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import type { TurnRequest, TurnState } from '../../../src/shared/turn.js';
import type { TemporalMention } from '../../../src/shared/understanding.js';
import {
  ContractViolationError,
  TurnStillRunningError,
} from '../../../src/orchestration/errors.js';
import { DefaultTurnOrchestrator } from '../../../src/orchestration/orchestrator.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { FakeBudget } from '../../helpers/budget.js';
import {
  analysis,
  answerOf,
  CONV,
  entityRecord,
  FakeAnalyzer,
  FakeAnswer,
  FakeResearch,
  FakeTurnStore,
  FakeWindow,
  finding,
  findingSet,
  mention,
  messageHit,
  NOW,
  SpyBaselines,
  SpyMemory,
  sentence,
  TURN,
  unableFinding,
  USER,
} from './fakes.js';

class DisposableFake extends FakeBudget {
  disposed = 0;
  dispose() {
    this.disposed += 1;
  }
}

const REQ: TurnRequest = {
  userId: USER,
  conversationId: CONV,
  text: 'hello',
  tz: 'UTC',
  idempotencyKey: 'key-1',
};

interface Setup {
  analyzer?: FakeAnalyzer;
  research?: FakeResearch;
  answer?: FakeAnswer;
  memory?: SpyMemory;
  baselines?: SpyBaselines;
  store?: FakeTurnStore;
  req?: Partial<TurnRequest>;
}

function build(s: Setup = {}) {
  const store = s.store ?? new FakeTurnStore();
  const analyzer = s.analyzer ?? new FakeAnalyzer(analysis());
  const research = s.research ?? new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
  const answer =
    s.answer ?? new FakeAnswer(() => answerOf([sentence(0, 'Hi there.', { status: 'no_claims' })]));
  const memory = s.memory ?? new SpyMemory();
  const baselines = s.baselines ?? new SpyBaselines();
  const window = new FakeWindow();
  const budgets: DisposableFake[] = [];
  const deadlines: number[] = [];
  const orchestrator = new DefaultTurnOrchestrator({
    turns: store,
    analyzer,
    research,
    answer,
    memory,
    resolver: undefined as never,
    baselines,
    window,
    clock: new FixedClock(NOW),
    budgetFactory: (deadline) => {
      deadlines.push(deadline);
      const b = new DisposableFake(60_000, NOW);
      budgets.push(b);
      return b;
    },
  });
  const events: SseEvent[] = [];
  const run = (req: Partial<TurnRequest> = {}) =>
    orchestrator.run({ ...REQ, ...s.req, ...req }, (e) => events.push(e));
  return {
    store,
    analyzer,
    research,
    answer,
    memory,
    baselines,
    window,
    budgets,
    deadlines,
    events,
    run,
    orchestrator,
  };
}

/** Same, with the real temporal resolver (the recall and audit paths need it). */
function withResolver<T>(f: (resolver: TemporalResolver) => T): T {
  return f(new DefaultTemporalResolver());
}

function buildWithResolver(s: Setup = {}) {
  const store = s.store ?? new FakeTurnStore();
  const analyzer = s.analyzer ?? new FakeAnalyzer(analysis());
  const research = s.research ?? new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
  const answer =
    s.answer ?? new FakeAnswer(() => answerOf([sentence(0, 'Answer.', { status: 'no_claims' })]));
  const memory = s.memory ?? new SpyMemory();
  const baselines = s.baselines ?? new SpyBaselines();
  const budgets: DisposableFake[] = [];
  const events: SseEvent[] = [];
  return withResolver((resolver) => {
    const orchestrator = new DefaultTurnOrchestrator({
      turns: store,
      analyzer,
      research,
      answer,
      memory,
      resolver,
      baselines,
      window: new FakeWindow(),
      clock: new FixedClock(NOW),
      budgetFactory: () => {
        const b = new DisposableFake(60_000, NOW);
        budgets.push(b);
        return b;
      },
    });
    return {
      store,
      analyzer,
      research,
      answer,
      memory,
      baselines,
      budgets,
      events,
      run: (req: Partial<TurnRequest> = {}) =>
        orchestrator.run({ ...REQ, ...s.req, ...req }, (e) => events.push(e)),
    };
  });
}

const CHAT_STATES: TurnState[] = [
  'RECEIVED',
  'ANALYZING',
  'RESOLVING_CONTEXT',
  'SYNTHESIZING',
  'POST_VERIFYING',
  'PERSISTING',
];

describe('time zone reaches the answer pipeline', () => {
  it("passes the user's validated time zone, and UTC when it is unknown", async () => {
    const ok = build({ req: { tz: 'Asia/Kolkata' } });
    await ok.run();
    expect(ok.answer.calls[0]?.tz).toBe('Asia/Kolkata');

    const bad = build({ req: { tz: 'Mars/Olympus' } });
    await bad.run();
    expect(bad.answer.calls[0]?.tz).toBe('UTC');
  });
});

describe('chat lane through the coordinator', () => {
  it('walks the chat edges, completes, and touches nothing but the analyzer and the answer pipeline', async () => {
    const t = build();
    const result = await t.run();
    expect(t.store.states).toEqual(CHAT_STATES);
    expect(result).toMatchObject({
      turnId: TURN,
      status: 'complete',
      assistantMessageId: 'msg_a1',
    });
    expect(t.analyzer.calls).toBe(1);
    expect(t.answer.calls).toHaveLength(1);
    expect(t.memory.calls).toEqual([]);
    expect(t.baselines.calls).toEqual([]);
    expect(t.research.calls).toEqual([]);
    expect(t.answer.calls[0]?.findings).toBeNull();
    expect(t.store.completions).toHaveLength(1);
  });

  it('emits turn.started first and turn.completed last, with ordered progress between', async () => {
    const t = build();
    await t.run();
    const names = t.events.map((e) => e.event);
    expect(names[0]).toBe('turn.started');
    expect(names.at(-1)).toBe('turn.completed');
    expect(names).toContain('answer.completed');
    expect(t.events.flatMap((e) => (e.event === 'progress' ? [e.data.stage] : []))).toEqual([
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'SYNTHESIZING',
      'POST_VERIFYING',
    ]);
  });

  it('persists the events it emitted, the analysis and the context', async () => {
    const t = build();
    await t.run();
    const c = t.store.completions[0];
    expect(c?.events.map((e) => e.event)).toContain('progress');
    expect(c?.events.at(-1)?.event).toBe('turn.completed');
    expect(c?.analysis?.laneHint).toBe('chat');
    expect(c?.context?.lane).toBe('chat');
    expect(c?.touchedBeliefKeys).toEqual([]);
  });

  it('reports TTFP and TTFT as measured, and the states it visited', async () => {
    const t = build({
      answer: new FakeAnswer(() => answerOf([sentence(0, 'x', { status: 'no_claims' })])),
    });
    const result = await t.run();
    expect(result.metrics.statesVisited).toEqual(CHAT_STATES);
    expect(result.metrics.ttfpMs).toBe(0);
    expect(result.metrics.sentences.no_claims).toBe(1);
  });
});

describe('one absolute deadline, propagated', () => {
  it('creates one budget with deadline = start + 60 s and hands the same object to every stage', async () => {
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(
        analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('HubSpot')] }),
      ),
      memory: new SpyMemory({ entities: [entityRecord('HubSpot')] }),
    });
    await t.run();
    expect(t.budgets).toHaveLength(1);
    const budget = t.budgets[0];
    expect(budget?.deadline).toBe(NOW + 60_000);
    expect(t.analyzer.lastBudget).toBe(budget);
    expect(t.research.calls[0]?.budget).toBe(budget);
    expect(t.answer.budgets[0]).toBe(budget);
    expect(budget?.disposed).toBe(1);
  });

  it('disposes the budget even when the turn throws', async () => {
    const t = build({ analyzer: new FakeAnalyzer(new TypeError('bug')) });
    await expect(t.run()).rejects.toBeInstanceOf(TypeError);
    expect(t.budgets[0]?.disposed).toBe(1);
  });

  it('reports deadlineHit when the budget ran out', async () => {
    const t2 = build();
    const result = await t2.run();
    expect(result.metrics.deadlineHit).toBe(false);
    // exhaust the budget during analysis
    const exhaust = build();
    const run = exhaust.orchestrator.run(REQ, () => undefined);
    exhaust.budgets[0]?.spend(60_000);
    expect((await run).metrics.deadlineHit).toBe(true);
  });
});

describe('recall lane through the coordinator', () => {
  const yesterday: TemporalMention = {
    text: 'yesterday',
    expr: { kind: 'yesterday' },
    role: 'reference_conversation',
  };

  it('answers from stored records via synthesis', async () => {
    const hit = messageHit(Date.UTC(2026, 10, 10, 12), CONV, 'What does Notion cost?');
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [yesterday] })),
      memory: new SpyMemory({ messages: [hit] }),
    });
    const result = await t.run();
    expect(result.status).toBe('complete');
    expect(t.store.states).toEqual(CHAT_STATES);
    expect(t.answer.calls[0]?.recall.get(hit.messageId)?.text).toBe('What does Notion cost?');
    expect(t.baselines.calls).toEqual([]);
  });

  it('never claims a conversation occurred when recall found no record', async () => {
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [yesterday] })),
      memory: new SpyMemory({ messages: [] }),
    });
    const result = await t.run();
    expect(t.answer.calls).toEqual([]); // no model is asked to write about a conversation that is not there
    expect(result.status).toBe('complete');
    const text = t.store.completions[0]?.assistant?.rendered ?? '';
    expect(text).toMatch(/no record of a conversation/i);
    expect(
      t.store.completions[0]?.assistant?.sentences.every((s) => s.status === 'no_claims'),
    ).toBe(true);
    expect(t.store.completions[0]?.assertions).toEqual([]);
    // SYNTHESIZING to PERSISTING is an existing edge (no POST_VERIFYING for a fixed reply)
    expect(t.store.states).toEqual([
      'RECEIVED',
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'SYNTHESIZING',
      'PERSISTING',
    ]);
  });

  it('an ambiguous date ends the turn with status clarify and a typed question', async () => {
    const lastTuesday: TemporalMention = {
      text: 'last Tuesday',
      expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
      role: 'reference_conversation',
    };
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(analysis({ laneHint: 'recall', temporal: [lastTuesday] })),
      memory: new SpyMemory({
        messages: [
          messageHit(Date.UTC(2026, 10, 3, 12), CONV, 'a'),
          messageHit(Date.UTC(2026, 10, 10, 12), CONV, 'b'),
        ],
      }),
    });
    const result = await t.run();
    expect(result.status).toBe('clarify');
    expect(t.answer.calls).toEqual([]);
    expect(t.store.states).toEqual([
      'RECEIVED',
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'CLARIFYING',
      'PERSISTING',
    ]);
    const clarification = t.events.find((e) => e.event === 'clarification');
    const refs = (clarification?.data as { options: Array<{ ref: string }> }).options
      .map((o) => o.ref)
      .sort();
    expect(refs).toEqual(['day:2026-11-03', 'day:2026-11-10']);
    expect(t.store.completions[0]?.context?.clarification?.options).toHaveLength(2);
  });
});

describe('research and audit through the coordinator', () => {
  const hubspot = entityRecord('HubSpot');
  const researching = analysis({
    laneHint: 'research',
    intents: ['pricing'],
    entities: [mention('HubSpot')],
  });

  it('walks the research edges to PERSISTING', async () => {
    const research = new FakeResearch((r) => ({
      ...findingSet(r.turnId, [finding(1)]),
      sources: { src_a: {} as never },
    }));
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research,
    });
    const result = await t.run();
    expect(result.status).toBe('complete');
    expect(t.store.states).toEqual([
      'RECEIVED',
      'ANALYZING',
      'RESOLVING_CONTEXT',
      'PLANNING',
      'SEARCHING',
      'EXTRACTING',
      'VERIFYING',
      'RESOLVING_BELIEFS',
      'SYNTHESIZING',
      'POST_VERIFYING',
      'PERSISTING',
    ]);
    expect(t.answer.calls[0]?.findings?.findings).toHaveLength(1);
  });

  it('a failed provider is never reported as a successful search: the turn is partial and says so', async () => {
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1), unableFinding(2)]));
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research,
    });
    const result = await t.run();
    expect(result.status).toBe('partial');
    expect(t.events.find((e) => e.event === 'warning')?.data).toMatchObject({
      code: 'search_partial',
    });
    expect(result.metrics.searches).toMatchObject({ ok: 1, failed: 1, total: 2 });
    // the finding set the answer is built from still carries the failure
    expect(t.answer.calls[0]?.findings?.findings[1]?.currentStatus).toBe('unable_to_verify');
  });

  it('a total search outage (every finding unable_to_verify) is partial, never complete', async () => {
    const research = new FakeResearch((r) =>
      findingSet(r.turnId, [unableFinding(1, 'quota_exhausted')]),
    );
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research,
    });
    expect((await t.run()).status).toBe('partial');
  });

  it('never says nothing changed when any finding is unable_to_verify (late guard downgrades the sentence)', async () => {
    const research = new FakeResearch((r) =>
      findingSet(r.turnId, [finding(1, { verdict: 'unchanged_confirmed' }), unableFinding(2)]),
    );
    const answer = new FakeAnswer(() =>
      answerOf([
        sentence(0, 'Nothing changed.', { status: 'verified' }),
        sentence(1, 'Entity2 could not be checked.', { status: 'verified' }),
      ]),
    );
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research,
      answer,
    });
    await t.run();
    const stored = t.store.completions[0]?.assistant?.sentences;
    expect(stored?.[0]).toMatchObject({
      status: 'unverified',
      issues: ['unsupported_global_negative'],
    });
    expect(stored?.[1]?.status).toBe('verified');
    expect(t.events.find((e) => e.event === 'verification')?.data).toMatchObject({
      index: 0,
      status: 'unverified',
    });
  });

  it('lets a legitimate global negative through when every verdict supports it', async () => {
    const research = new FakeResearch((r) =>
      findingSet(r.turnId, [finding(1, { verdict: 'unchanged_confirmed' })]),
    );
    const answer = new FakeAnswer(() => answerOf([sentence(0, 'Nothing changed.')]));
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research,
      answer,
    });
    await t.run();
    expect(t.store.completions[0]?.assistant?.sentences[0]?.status).toBe('verified');
    expect(t.events.some((e) => e.event === 'verification')).toBe(false);
  });

  it('recall + asksStillCorrect runs the audit lane, with baselines in the context', async () => {
    const lastTuesday: TemporalMention = {
      text: 'yesterday',
      expr: { kind: 'yesterday' },
      role: 'reference_conversation',
    };
    const hit = messageHit(Date.UTC(2026, 10, 10, 12), 'cnv_old', 'HubSpot price?');
    const baseline = {
      assertionId: newId('asr'),
      entityId: hubspot.id,
      presentedAt: Date.UTC(2026, 10, 10, 12),
    };
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(
        analysis({
          laneHint: 'recall',
          asksStillCorrect: true,
          temporal: [lastTuesday],
          intents: ['pricing'],
          entities: [mention('HubSpot')],
        }),
      ),
      memory: new SpyMemory({ entities: [hubspot], messages: [hit] }),
      baselines: new SpyBaselines([baseline as never]),
    });
    await t.run();
    expect(t.baselines.calls[0]).toBe('eligible:cnv_old');
    expect(t.research.calls[0]?.ctx.lane).toBe('audit');
    expect(t.research.calls[0]?.ctx.baselines).toHaveLength(1);
  });

  it('a research service failure propagates: no answer, no completion, the turn is not finished', async () => {
    const boom = Object.assign(new Error('trigger rejected write'), {
      code: 'SQLITE_CONSTRAINT_TRIGGER',
    });
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research: new FakeResearch(() => boom),
    });
    await expect(t.run()).rejects.toBe(boom);
    expect(t.answer.calls).toEqual([]);
    expect(t.store.completions).toEqual([]);
    expect(t.store.failed).toEqual([]); // not in PERSISTING: fail() is for persistence only
    expect(t.store.status).toBe('running');
  });

  it('a self-contradicting finding set is a defect, not a result', async () => {
    const lie = finding(1, {
      coverage: { ...finding(1).coverage, failure: 'search_timeout' },
    });
    const t = buildWithResolver({
      analyzer: new FakeAnalyzer(researching),
      memory: new SpyMemory({ entities: [hubspot] }),
      research: new FakeResearch((r) => findingSet(r.turnId, [lie])),
    });
    await expect(t.run()).rejects.toBeInstanceOf(ContractViolationError);
    expect(t.store.completions).toEqual([]);
  });
});

describe('analysis and synthesis failures', () => {
  it('a degraded analysis gets a fixed reply through ANALYZING to PERSISTING, status failed', async () => {
    const t = build({ analyzer: new FakeAnalyzer(analysis({ degraded: true })) });
    const result = await t.run();
    expect(result.status).toBe('failed');
    expect(t.store.states).toEqual(['RECEIVED', 'ANALYZING', 'PERSISTING']);
    expect(t.answer.calls).toEqual([]);
    expect(t.events.find((e) => e.event === 'warning')?.data).toMatchObject({
      code: 'analysis_degraded',
    });
    expect(t.store.completions[0]?.errorCode).toBe('analysis_degraded');
    expect(t.store.completions[0]?.assistant?.sentences[0]?.status).toBe('no_claims');
  });

  it('a provider error thrown by the analyzer becomes the same fixed reply', async () => {
    const t = build({ analyzer: new FakeAnalyzer(new LlmError('unavailable', 'down')) });
    expect((await t.run()).status).toBe('failed');
    expect(t.store.states).toEqual(['RECEIVED', 'ANALYZING', 'PERSISTING']);
  });

  it('a programmer error in the analyzer propagates and is never an answer', async () => {
    const t = build({ analyzer: new FakeAnalyzer(new TypeError('x is undefined')) });
    await expect(t.run()).rejects.toBeInstanceOf(TypeError);
    expect(t.store.completions).toEqual([]);
    expect(t.store.failed).toEqual([]);
  });

  it('a provider error from the answer pipeline becomes a fixed failed reply (SYNTHESIZING to PERSISTING)', async () => {
    const t = build({ answer: new FakeAnswer(() => new LlmError('unavailable', 'down')) });
    const result = await t.run();
    expect(result.status).toBe('failed');
    expect(t.store.states.slice(-2)).toEqual(['SYNTHESIZING', 'PERSISTING']);
    expect(t.store.completions[0]?.errorCode).toBe('synthesis_external_retryable');
  });

  it('a defect in the answer pipeline propagates', async () => {
    const t = build({ answer: new FakeAnswer(() => new RangeError('bad index')) });
    await expect(t.run()).rejects.toBeInstanceOf(RangeError);
    expect(t.store.completions).toEqual([]);
  });

  it('an interrupted stream persists an interrupted message and status, through SYNTHESIZING to PERSISTING', async () => {
    const t = build({
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
    const result = await t.run();
    expect(result.status).toBe('interrupted');
    expect(t.store.completions[0]?.assistant).toMatchObject({
      messageStatus: 'interrupted',
      streamedThrough: 0,
    });
    expect(t.store.states.slice(-2)).toEqual(['SYNTHESIZING', 'PERSISTING']);
  });

  it('an answer with no sentences is a failed fixed reply, not an empty message', async () => {
    const t = build({ answer: new FakeAnswer(() => answerOf([])) });
    const result = await t.run();
    expect(result.status).toBe('failed');
    expect(t.store.completions[0]?.assistant?.rendered).toMatch(/could not process/);
  });
});

describe('persistence', () => {
  const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  it('a failing complete() goes through fail() once and the original error propagates', async () => {
    const store = new FakeTurnStore();
    store.completeError = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const t = build({ store });
    await expect(t.run()).rejects.toBe(store.completeError);
    expect(store.failed).toEqual(['persistence:sqlite_ioerr']);
    expect(store.status).toBe('failed');
    expect(t.events.find((e) => e.event === 'error')?.data).toMatchObject({
      code: 'persistence_failed',
    });
    expect(t.events.some((e) => e.event === 'turn.completed')).toBe(false);
  });

  it('a malformed completion (our bug) still ends the turn through fail() and is rethrown, not answered', async () => {
    const store = new FakeTurnStore();
    store.completeError = new TypeError('bad completion');
    const t = build({ store });
    await expect(t.run()).rejects.toBeInstanceOf(TypeError);
    expect(store.failed).toHaveLength(1);
  });

  it('retries a busy database once and then succeeds', async () => {
    const store = new FakeTurnStore();
    let calls = 0;
    const real = store.complete.bind(store);
    store.complete = (...args) => {
      calls += 1;
      if (calls === 1) throw busy();
      real(...args);
    };
    const t = build({ store });
    expect((await t.run()).status).toBe('complete');
    expect(calls).toBe(2);
    expect(store.failed).toEqual([]);
  });

  it('gives up after one retry: two busy results fail the turn, there is no infinite retry', async () => {
    const store = new FakeTurnStore();
    let calls = 0;
    store.complete = () => {
      calls += 1;
      throw busy();
    };
    const t = build({ store });
    await expect(t.run()).rejects.toThrow('database is locked');
    expect(calls).toBe(2);
    expect(store.failed).toHaveLength(1);
  });

  it('an illegal transition is a defect: it propagates and no failure edge is invented', async () => {
    const store = new FakeTurnStore();
    store.setStateErrorAt = { state: 'RESOLVING_CONTEXT', error: new Error('illegal transition') };
    const t = build({ store });
    await expect(t.run()).rejects.toThrow('illegal transition');
    expect(store.state).toBe('ANALYZING');
    expect(store.failed).toEqual([]);
    expect(store.completions).toEqual([]);
  });

  it('a failing fail() does not hide the original error', async () => {
    const store = new FakeTurnStore();
    store.completeError = new Error('first');
    store.fail = () => {
      throw new Error('second');
    };
    const t = build({ store });
    await expect(t.run()).rejects.toThrow('first');
  });
});

describe('idempotent begin', () => {
  it('returns the stored outcome of a finished turn without running anything', async () => {
    const store = new FakeTurnStore();
    store.existing = { existing: 'trn_old', status: 'partial' };
    store.assistantMessageId = 'msg_old';
    const t = build({ store });
    const result = await t.run();
    expect(result).toMatchObject({
      turnId: 'trn_old',
      status: 'partial',
      assistantMessageId: 'msg_old',
    });
    expect(t.analyzer.calls).toBe(0);
    expect(t.answer.calls).toEqual([]);
    expect(store.states).toEqual(['RECEIVED']);
    expect(t.events).toEqual([]);
    expect(t.budgets).toHaveLength(0);
  });

  it('refuses to run a second time while the same key is still running', async () => {
    const store = new FakeTurnStore();
    store.existing = { existing: 'trn_busy', status: 'running' };
    const t = build({ store });
    await expect(t.run()).rejects.toBeInstanceOf(TurnStillRunningError);
    expect(t.analyzer.calls).toBe(0);
  });

  it('propagates begin() errors (conflict, turn in progress) untouched', async () => {
    const store = new FakeTurnStore();
    const conflict = new Error('idempotency conflict');
    store.begin = () => {
      throw conflict;
    };
    await expect(build({ store }).run()).rejects.toBe(conflict);
  });
});

describe('cancellation and the client', () => {
  it('a client sink that throws (a disconnect) does not abort or change the turn', async () => {
    const t = build();
    const result = await t.orchestrator.run(REQ, () => {
      throw new Error('client gone');
    });
    expect(result.status).toBe('complete');
    expect(t.store.completions).toHaveLength(1);
    expect(t.budgets[0]?.signal.aborted).toBe(false);
  });

  it('falls back to UTC for an invalid time zone and says so', async () => {
    const t = build({ req: { tz: 'Mars/Olympus' } });
    await t.run();
    const first = t.events.find((e) => e.event === 'progress');
    expect(first?.data).toMatchObject({ stage: 'ANALYZING' });
    expect(JSON.stringify(first?.data)).toContain('using UTC');
  });

  it('keeps only verbatim-quoted decisions from the model in the stored enrichment', async () => {
    const t = build({
      req: { text: 'Please shortlist HubSpot' },
      analyzer: new FakeAnalyzer(
        analysis({
          userFacts: [
            {
              kind: 'shortlist',
              quote: 'shortlist HubSpot',
              data: { kind: 'shortlist', entities: ['HubSpot'] },
            },
            { kind: 'shortlist', quote: 'made up', data: { kind: 'shortlist' } },
          ],
        }),
      ),
    });
    await t.run();
    expect(t.store.completions[0]?.enrichment.decisions.map((d) => d.quote)).toEqual([
      'shortlist HubSpot',
    ]);
  });

  it('passes the conversation window truncated to 1500 characters per message', async () => {
    const store = new FakeTurnStore();
    const analyzer = new FakeAnalyzer(analysis());
    let seen: Array<{ content: string }> = [];
    analyzer.analyze = (input) => {
      seen = input.window;
      return Promise.resolve(analysis());
    };
    const o = new DefaultTurnOrchestrator({
      turns: store,
      analyzer,
      research: new FakeResearch((r) => findingSet(r.turnId, [])),
      answer: new FakeAnswer(() => answerOf([sentence(0, 'x', { status: 'no_claims' })])),
      memory: new SpyMemory(),
      resolver: undefined as never,
      baselines: new SpyBaselines(),
      window: new FakeWindow([{ role: 'user', content: 'a'.repeat(5_000) }]),
      clock: new FixedClock(NOW),
      budgetFactory: () => new DisposableFake(60_000, NOW),
    });
    await o.run(REQ, () => undefined);
    expect(seen[0]?.content).toHaveLength(1_500);
  });
});
