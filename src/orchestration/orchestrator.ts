import type { AnswerPipeline, PersistedSentence } from '../shared/answer.js';
import type { FindingSet } from '../shared/findings.js';
import type { MessageId, Ms, TurnId, UserId } from '../shared/ids.js';
import type { Clock, Logger, TurnBudget } from '../shared/infrastructure.js';
import type { MemoryRetriever, ResolvedContext } from '../shared/memory.js';
import type { ResearchService, TurnAnalyzer } from '../shared/pipeline.js';
import type { ResearchPlanner } from '../shared/research.js';
import type { EventSink, SseEvent } from '../shared/sse.js';
import type { TemporalResolver } from '../shared/temporal.js';
import type {
  TerminalTurnStatus,
  TurnMetrics,
  TurnOrchestrator,
  TurnRequest,
  TurnResult,
  TurnState,
} from '../shared/turn.js';
import type { TurnCompletion } from '../shared/repositories.js';
import type { Lane, TurnAnalysis } from '../shared/understanding.js';
import { DEFAULT_TURN_BUDGET_CONFIG, TURN_LIMITS, type TurnBudgetConfig } from './config.js';
import {
  classifyError,
  clientCodeFor,
  errorCodeFor,
  failureCodeFor,
  isDatabaseBusy,
  propagates,
  TurnStillRunningError,
  withBoundedRetry,
} from './errors.js';
import { guardGlobalNegatives, hasUnableToVerify } from './findings-guard.js';
import { auditLane } from './lanes/audit.js';
import { chatLane } from './lanes/chat.js';
import { isValidTimeZone } from './lanes/common.js';
import { clarifyLane } from './lanes/clarify.js';
import { recallLane } from './lanes/recall.js';
import { researchLane } from './lanes/research.js';
import type { LaneDeps, LaneHandler, LaneOutcome } from './lanes/types.js';
import { DefaultResearchPlanner, normalizeEntityName } from './planner.js';
import type { BaselineSource, ConversationWindowReader, TurnStore } from './ports.js';
import {
  buildAssertions,
  buildBaselineEvents,
  buildEnrichment,
  citationsOf,
  countSentences,
  deterministicAnswer,
  statusForFindings,
  type DeterministicAnswer,
} from './prepare.js';
import { routeTurn } from './routing.js';
import { DeadlineTurnBudget } from './turn-budget.js';

export type DisposableBudget = TurnBudget & { dispose(): void };

export interface OrchestratorDeps {
  turns: TurnStore;
  analyzer: TurnAnalyzer;
  research: ResearchService;
  answer: AnswerPipeline;
  memory: MemoryRetriever;
  resolver: TemporalResolver;
  baselines: BaselineSource;
  window: ConversationWindowReader;
  clock: Clock;
  planner?: ResearchPlanner;
  logger?: Logger;
  budgetConfig?: TurnBudgetConfig;
  /** Server shutdown. A client disconnect is not an input of the coordinator at all. */
  shutdown?: AbortSignal;
  /** Replaces the real budget (tests of other modules use FakeBudget). */
  budgetFactory?: (deadline: Ms) => DisposableBudget;
}

const OUTAGE_REPLY = [
  'I could not process that request just now.',
  'Please try again in a moment.',
];

const LANES: Record<Lane, LaneHandler> = {
  chat: chatLane,
  recall: recallLane,
  research: researchLane,
  audit: auditLane,
  clarify: clarifyLane,
};

/** What the turn ends with, before persistence. */
interface Ending {
  status: TerminalTurnStatus;
  answer: {
    rendered: string;
    template: string;
    sentences: PersistedSentence[];
    streamedThrough: number;
    messageStatus: 'complete' | 'interrupted';
  } | null;
  findings: FindingSet | null;
  ctx: ResolvedContext | null;
  errorCode?: string;
}

/**
 * The turn coordinator (ADR-01): deterministic, lane routed, one absolute deadline.
 *
 * Responsibilities, and only these: persist the turn through the repository, call the analyzer, route, run
 * one lane handler, call the answer pipeline, prepare the completion and persist it. It contains no search,
 * extraction, verification, belief or prompt logic.
 *
 * State progression uses only edges of the table in src/shared/turn-state-machine.ts, and only `setState`,
 * `complete` and `fail`:
 *   chat/recall:  RECEIVED, ANALYZING, RESOLVING_CONTEXT, SYNTHESIZING, POST_VERIFYING, PERSISTING
 *   research/audit: ... RESOLVING_CONTEXT, PLANNING, SEARCHING, [EXTRACTING, VERIFYING,] RESOLVING_BELIEFS,
 *                   SYNTHESIZING, POST_VERIFYING, PERSISTING
 *   clarify:      ... RESOLVING_CONTEXT, CLARIFYING, PERSISTING
 *   fixed reply:  ... RESOLVING_CONTEXT, SYNTHESIZING, PERSISTING
 *   analysis down: ANALYZING, PERSISTING
 *   unexpected error: any non-final state, PERSISTING (ADR-39)
 *
 * Errors (ADR-39). A provider failure inside the analyzer or the answer pipeline becomes a fixed reply with
 * status `failed`. Any other error thrown before persistence (a replay fixture miss, a programmer error, a
 * database failure outside the final write) is never turned into an answer: the coordinator moves the turn to
 * PERSISTING, finalises it through `complete()` with status `failed`, an error code naming the class and no
 * assistant message, tells the client with an SSE error event, logs it and rethrows the original error. If the
 * finalising write fails, `fail()` is used when the turn reached PERSISTING; if the turn could not even be moved
 * there, it stays running for `recoverRunning`. A failure of the final `complete()` goes through `fail()`.
 */
export class DefaultTurnOrchestrator implements TurnOrchestrator {
  private readonly laneDeps: LaneDeps;
  private readonly budgetConfig: TurnBudgetConfig;

  constructor(private readonly deps: OrchestratorDeps) {
    this.budgetConfig = deps.budgetConfig ?? DEFAULT_TURN_BUDGET_CONFIG;
    this.laneDeps = {
      memory: deps.memory,
      resolver: deps.resolver,
      baselines: deps.baselines,
      research: deps.research,
      planner: deps.planner ?? new DefaultResearchPlanner(),
      normalize: normalizeEntityName,
    };
  }

  async run(req: TurnRequest, clientEmit: EventSink): Promise<TurnResult> {
    const { turns, clock } = this.deps;
    const startedAt = clock.now();
    const deadline = startedAt + this.budgetConfig.deadlineMs;
    const busy = { maxAttempts: TURN_LIMITS.persistenceAttempts, shouldRetry: isDatabaseBusy };

    const began = withBoundedRetry(() => turns.begin(req, startedAt, deadline), busy);
    if ('existing' in began) {
      // Idempotent begin: the same key returns the existing turn. A finished one reports its stored outcome.
      if (began.status === 'running') throw new TurnStillRunningError(began.existing);
      const stored = turns.get(req.userId, began.existing);
      return {
        turnId: began.existing,
        status: began.status,
        assistantMessageId: stored?.assistantMessageId ?? null,
        metrics: emptyMetrics(0, ['RECEIVED']),
      };
    }

    const budget = this.makeBudget(deadline);
    try {
      return await this.runTurn(
        req,
        began.turnId,
        began.userMessageId,
        startedAt,
        budget,
        clientEmit,
      );
    } finally {
      budget.dispose();
    }
  }

  private makeBudget(deadline: Ms): DisposableBudget {
    if (this.deps.budgetFactory) return this.deps.budgetFactory(deadline);
    return new DeadlineTurnBudget({
      clock: this.deps.clock,
      deadline,
      config: this.budgetConfig,
      ...(this.deps.shutdown ? { shutdown: this.deps.shutdown } : {}),
    });
  }

  private async runTurn(
    req: TurnRequest,
    turnId: TurnId,
    userMessageId: MessageId,
    startedAt: Ms,
    budget: DisposableBudget,
    clientEmit: EventSink,
  ): Promise<TurnResult> {
    const { turns, clock, logger } = this.deps;
    const userId: UserId = req.userId;
    const busy = { maxAttempts: TURN_LIMITS.persistenceAttempts, shouldRetry: isDatabaseBusy };

    const events: SseEvent[] = [];
    const statesVisited: TurnState[] = ['RECEIVED'];
    let ttfpMs: number | null = null;
    let ttftMs: number | null = null;

    // A client that went away must not stop the turn (ADR-17): a failing sink is logged and ignored.
    const emit: EventSink = (e) => {
      events.push(e);
      const elapsed = clock.now() - startedAt;
      if (ttfpMs === null && e.event === 'progress') ttfpMs = elapsed;
      if (ttftMs === null && e.event === 'answer.delta') ttftMs = elapsed;
      try {
        clientEmit(e);
      } catch (error) {
        logger?.warn({ turnId, error: String(error) }, 'event sink failed; the turn continues');
      }
    };
    const setState = (state: TurnState): void => {
      withBoundedRetry(() => turns.setState(userId, turnId, state), busy);
      statesVisited.push(state);
    };
    const progress = (state: TurnState, text: string): void => {
      setState(state);
      emit({ event: 'progress', data: { stage: state, text } });
    };

    let analysis: TurnAnalysis | null = null;
    let ending: Ending;
    let metrics: TurnMetrics;
    let completedEvent: SseEvent;
    let completion: TurnCompletion;
    try {
      emit({ event: 'turn.started', data: { turnId, userMessageId } });
      const tz = isValidTimeZone(req.tz) ? req.tz : 'UTC';
      progress(
        'ANALYZING',
        tz === req.tz ? 'Understanding your message' : `Unknown time zone "${req.tz}"; using UTC`,
      );

      const window = this.deps.window
        .recent(userId, req.conversationId, userMessageId, TURN_LIMITS.windowMessages)
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, TURN_LIMITS.windowMessageChars),
        }));

      // 1. Analysis. The contract returns `degraded: true` instead of throwing; a thrown provider failure is
      //    treated the same way, anything else is a defect and propagates.
      try {
        analysis = await this.deps.analyzer.analyze(
          { userMessage: req.text, window, tz, now: startedAt },
          budget,
        );
      } catch (error) {
        if (propagates(classifyError(error, budget.signal))) throw error;
        logger?.warn(
          { turnId, error: String(error) },
          'analysis failed; replying deterministically',
        );
      }

      if (analysis === null || analysis.degraded) {
        emit({
          event: 'warning',
          data: { code: 'analysis_degraded', text: 'I could not fully understand the request.' },
        });
        // ANALYZING -> PERSISTING: the edge for an LLM outage (architecture section 4).
        ending = this.fixedEnding(emit, OUTAGE_REPLY, 'failed', null, null, 'analysis_degraded');
      } else {
        progress('RESOLVING_CONTEXT', 'Looking at what is stored');
        ending = await this.runLane({
          req,
          turnId,
          userId,
          tz,
          analysis,
          startedAt,
          budget,
          emit,
          progress,
          setState,
          window,
        });
      }
      // 2. Persistence. The only work allowed past the deadline. Moving to PERSISTING and building the
      //    completion are inside the same guard: a failure here still ends in a terminal turn.
      setState('PERSISTING');
      const ttcMs = clock.now() - startedAt;
      metrics = buildMetrics({
        ttfpMs,
        ttftMs,
        ttcMs,
        deadlineHit: budget.remaining() === 0,
        findings: ending.findings,
        sentences: ending.answer?.sentences ?? [],
        statesVisited,
      });
      completedEvent = {
        event: 'turn.completed',
        data: { status: ending.status, metrics: { ttfpMs, ttftMs, ttcMs } },
      };
      completion = {
        status: ending.status,
        assistant: ending.answer,
        findings: ending.findings,
        assertions: ending.answer ? buildAssertions(ending.answer.sentences, ending.findings) : [],
        baselineEvents: buildBaselineEvents(ending.findings),
        touchedBeliefKeys: [],
        enrichment: buildEnrichment(analysis, req.text),
        analysis,
        context: ending.ctx,
        events: [...events, completedEvent],
        metrics,
        ...(ending.errorCode !== undefined ? { errorCode: ending.errorCode } : {}),
      };
    } catch (error) {
      this.abandon(error, {
        turnId,
        userId,
        startedAt,
        budget,
        emit,
        events,
        statesVisited,
        setState,
        analysis,
        ttfpMs,
        ttftMs,
      });
      throw error;
    }

    try {
      withBoundedRetry(() => turns.complete(userId, turnId, completion), busy);
    } catch (error) {
      // Persistence itself failed: the one case that goes through fail(). The error is never an answer.
      try {
        turns.fail(userId, turnId, errorCodeFor(error));
      } catch (failError) {
        logger?.error(
          { turnId, error: String(failError) },
          'fail() after a persistence failure also failed',
        );
      }
      emit({
        event: 'error',
        data: {
          code: 'persistence_failed',
          text: 'The answer could not be saved.',
          recoverable: false,
        },
      });
      throw error;
    }

    const stored = turns.get(userId, turnId);
    const assistantMessageId = stored?.assistantMessageId ?? null;
    if (ending.answer && assistantMessageId !== null) {
      clientEmitSafe(clientEmit, {
        event: 'answer.completed',
        data: {
          assistantMessageId,
          sentences: ending.answer.sentences.map((s) => ({
            index: s.index,
            status: s.status,
            issues: s.issues,
          })),
          citations: citationsOf(ending.answer.sentences, ending.findings),
        },
      });
    }
    clientEmitSafe(clientEmit, completedEvent);
    return { turnId, status: ending.status, assistantMessageId, metrics };
  }

  /**
   * An unexpected error before persistence (ADR-39): finalise the turn as failed so it never stays running.
   * Writes no assistant message and invents no answer. Never throws: the caller rethrows the original error.
   */
  private abandon(
    error: unknown,
    c: {
      turnId: TurnId;
      userId: UserId;
      startedAt: Ms;
      budget: TurnBudget;
      emit: EventSink;
      events: SseEvent[];
      statesVisited: TurnState[];
      setState: (s: TurnState) => void;
      analysis: TurnAnalysis | null;
      ttfpMs: number | null;
      ttftMs: number | null;
    },
  ): void {
    const { turns, clock, logger } = this.deps;
    const busy = { maxAttempts: TURN_LIMITS.persistenceAttempts, shouldRetry: isDatabaseBusy };
    const code = failureCodeFor(error, c.budget.signal);
    logger?.error(
      { turnId: c.turnId, code, error: String(error) },
      'unexpected error; finalising the turn as failed',
    );
    c.emit({
      event: 'error',
      data: {
        code: clientCodeFor(code),
        text: 'The request could not be completed.',
        recoverable: false,
      },
    });

    // Any non-final state has an edge to PERSISTING. If that move fails (the database is the failing
    // component) the finalising write is still attempted once, because the move may have been applied before
    // the error surfaced; if it is refused too, the turn stays running and the next restart marks it
    // interrupted.
    try {
      if (c.statesVisited[c.statesVisited.length - 1] !== 'PERSISTING') c.setState('PERSISTING');
    } catch (stateError) {
      logger?.error(
        { turnId: c.turnId, error: String(stateError) },
        'could not move the failed turn to PERSISTING',
      );
    }

    const metrics = buildMetrics({
      ttfpMs: c.ttfpMs,
      ttftMs: c.ttftMs,
      ttcMs: clock.now() - c.startedAt,
      deadlineHit: c.budget.remaining() === 0,
      findings: null,
      sentences: [],
      statesVisited: c.statesVisited,
    });
    const completion: TurnCompletion = {
      status: 'failed',
      assistant: null,
      findings: null,
      assertions: [],
      baselineEvents: [],
      touchedBeliefKeys: [],
      enrichment: { tags: [], entities: [], decisions: [] },
      analysis: c.analysis,
      context: null,
      events: [...c.events],
      metrics,
      errorCode: code,
    };
    try {
      withBoundedRetry(() => turns.complete(c.userId, c.turnId, completion), busy);
    } catch (completeError) {
      try {
        turns.fail(c.userId, c.turnId, errorCodeFor(completeError));
      } catch (failError) {
        logger?.error(
          { turnId: c.turnId, error: String(failError) },
          'the failed turn could not be finalised; left for restart recovery',
        );
      }
    }
  }

  private async runLane(c: {
    req: TurnRequest;
    turnId: TurnId;
    userId: UserId;
    tz: string;
    analysis: TurnAnalysis;
    startedAt: Ms;
    budget: TurnBudget;
    emit: EventSink;
    progress: (s: TurnState, text: string) => void;
    setState: (s: TurnState) => void;
    window: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<Ending> {
    const route = routeTurn(c.analysis);
    const outcome: LaneOutcome = await LANES[route.lane](
      {
        userId: c.userId,
        conversationId: c.req.conversationId,
        turnId: c.turnId,
        tz: c.tz,
        analysis: c.analysis,
        now: c.startedAt,
        budget: c.budget,
        emit: c.emit,
        progress: c.progress,
      },
      this.laneDeps,
    );

    switch (outcome.kind) {
      case 'clarify': {
        c.progress('CLARIFYING', 'Asking which one you mean');
        return this.fixedEnding(c.emit, [outcome.question], 'clarify', null, outcome.ctx);
      }
      case 'reply': {
        c.progress('SYNTHESIZING', 'Answering');
        return this.fixedEnding(c.emit, outcome.sentences, 'complete', null, outcome.ctx);
      }
      case 'synthesize': {
        if (hasUnableToVerify(outcome.findings)) {
          c.emit({
            event: 'warning',
            data: {
              code: 'search_partial',
              text: 'Some of the checks could not be completed. I will say which.',
            },
          });
        }
        c.progress('SYNTHESIZING', 'Writing the answer');
        // Sentences written in code open the answer: they are released first and the model's sentences follow
        // them, numbered after them. No model call is involved in them.
        const lead = deterministicAnswer(outcome.lead ?? []);
        const k = lead.sentences.length;
        for (const sentence of lead.sentences) {
          c.emit({
            event: 'answer.delta',
            data: {
              sentenceIndex: sentence.index,
              text: (sentence.index === 0 ? '' : ' ') + sentence.text,
            },
          });
          c.emit({
            event: 'answer.sentence_end',
            data: { index: sentence.index, status: sentence.status, issues: sentence.issues },
          });
        }
        const pipelineEmit: EventSink = (e) => {
          if (k === 0) return c.emit(e);
          switch (e.event) {
            case 'answer.delta':
              return c.emit({
                event: 'answer.delta',
                data: {
                  sentenceIndex: e.data.sentenceIndex + k,
                  text: e.data.sentenceIndex === 0 ? ' ' + e.data.text : e.data.text,
                },
              });
            case 'answer.sentence_end':
              return c.emit({ event: e.event, data: { ...e.data, index: e.data.index + k } });
            case 'verification':
              return c.emit({ event: e.event, data: { ...e.data, index: e.data.index + k } });
            default:
              return c.emit(e);
          }
        };
        let result: Awaited<ReturnType<AnswerPipeline['run']>>;
        try {
          result = await this.deps.answer.run(
            {
              findings: outcome.findings,
              recall: outcome.recall,
              ctx: outcome.ctx,
              userMessage: c.req.text,
              window: c.window,
              tz: c.tz,
            },
            c.budget,
            pipelineEmit,
          );
        } catch (error) {
          const cls = classifyError(error, c.budget.signal);
          if (propagates(cls)) throw error;
          this.deps.logger?.warn(
            { turnId: c.turnId, cls },
            'synthesis failed; replying deterministically',
          );
          return this.fixedEnding(
            c.emit,
            OUTAGE_REPLY,
            'failed',
            outcome.findings,
            outcome.ctx,
            `synthesis_${cls}`,
          );
        }
        if (result.sentences.length === 0) {
          return this.fixedEnding(
            c.emit,
            OUTAGE_REPLY,
            'failed',
            outcome.findings,
            outcome.ctx,
            'synthesis_empty',
          );
        }

        if (k > 0) {
          result = {
            ...result,
            sentences: [
              ...lead.sentences,
              ...result.sentences.map((x) => ({ ...x, index: x.index + k })),
            ],
            streamedThrough: result.streamedThrough + k,
            template: lead.template + ' ' + result.template,
            rendered: lead.rendered + ' ' + result.rendered,
          };
        }

        // Defence in depth for the global-negative rule: only ever a downgrade, announced like T3b.
        const guarded = guardGlobalNegatives(result.sentences, outcome.findings);
        for (const index of guarded.changed) {
          const s = guarded.sentences[index];
          if (s)
            c.emit({ event: 'verification', data: { index, status: s.status, issues: s.issues } });
        }

        const interrupted = result.interrupted;
        if (!interrupted) c.progress('POST_VERIFYING', 'Checking the answer');
        return {
          status: interrupted ? 'interrupted' : statusForFindings(outcome.findings),
          answer: {
            rendered: result.rendered,
            template: result.template,
            sentences: guarded.sentences,
            streamedThrough: result.streamedThrough,
            messageStatus: interrupted ? 'interrupted' : 'complete',
          },
          findings: outcome.findings,
          ctx: outcome.ctx,
        };
      }
    }
  }

  /** An ending whose text is written in code: streamed as sentences with no claims, no model involved. */
  private fixedEnding(
    emit: EventSink,
    texts: string[],
    status: TerminalTurnStatus,
    findings: FindingSet | null,
    ctx: ResolvedContext | null,
    errorCode?: string,
  ): Ending {
    const answer: DeterministicAnswer = deterministicAnswer(texts);
    for (const s of answer.sentences) {
      emit({ event: 'answer.delta', data: { sentenceIndex: s.index, text: s.text } });
      emit({
        event: 'answer.sentence_end',
        data: { index: s.index, status: s.status, issues: s.issues },
      });
    }
    return {
      status,
      answer: {
        rendered: answer.rendered,
        template: answer.template,
        sentences: answer.sentences,
        streamedThrough: answer.streamedThrough,
        messageStatus: 'complete',
      },
      findings,
      ctx,
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }
}

function clientEmitSafe(sink: EventSink, e: SseEvent): void {
  try {
    sink(e);
  } catch {
    /* a gone client does not change the stored outcome */
  }
}

function emptyMetrics(ttcMs: number, statesVisited: TurnState[]): TurnMetrics {
  return {
    ttfpMs: null,
    ttftMs: null,
    ttcMs,
    deadlineHit: false,
    llmCalls: [],
    searches: { total: 0, ok: 0, failed: 0, cached: 0, notAdmitted: 0, costUsd: 0 },
    extraction: { batches: 0, retries: 0, splits: 0 },
    verification: { pass: 0, weak: 0, fail: 0, byCheck: {} },
    sentences: { verified: 0, no_claims: 0, unverified: 0, unchecked: 0, truncated: 0 },
    judgeCalls: 0,
    statesVisited,
  };
}

/**
 * Metrics the coordinator can know. Search counts are the sums of the findings' coverage (so a search shared by
 * several findings is counted per finding); LLM calls, cache hits, cost and the extraction and verification
 * counters belong to modules that do not report them to the coordinator and stay zero. Nothing is invented.
 */
function buildMetrics(m: {
  ttfpMs: number | null;
  ttftMs: number | null;
  ttcMs: number;
  deadlineHit: boolean;
  findings: FindingSet | null;
  sentences: PersistedSentence[];
  statesVisited: TurnState[];
}): TurnMetrics {
  const base = emptyMetrics(m.ttcMs, [...m.statesVisited]);
  const findings = m.findings?.findings ?? [];
  const ok = findings.reduce((n, f) => n + f.coverage.searchesOk, 0);
  const failed = findings.reduce((n, f) => n + f.coverage.searchesFailed, 0);
  return {
    ...base,
    ttfpMs: m.ttfpMs,
    ttftMs: m.ttftMs,
    deadlineHit: m.deadlineHit,
    searches: { ...base.searches, total: ok + failed, ok, failed },
    sentences: countSentences(m.sentences),
  };
}
