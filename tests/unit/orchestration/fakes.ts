import type { AnswerPipeline, PersistedSentence } from '../../../src/shared/answer.js';
import type { Finding, FindingSet } from '../../../src/shared/findings.js';
import {
  newId,
  type ConversationId,
  type EntityId,
  type MessageId,
  type Ms,
  type TurnId,
  type UserId,
} from '../../../src/shared/ids.js';
import type { Baseline, MemoryCandidate, MemoryRetriever } from '../../../src/shared/memory.js';
import type {
  ResearchRequest,
  ResearchService,
  TurnAnalyzer,
} from '../../../src/shared/pipeline.js';
import type { TurnCompletion } from '../../../src/shared/repositories.js';
import type { TurnState, TurnStatus } from '../../../src/shared/turn.js';
import { canTransition, isFinalState } from '../../../src/shared/turn-state-machine.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import type { TurnAnalysis } from '../../../src/shared/understanding.js';
import type {
  BaselineQuery,
  BaselineSource,
  ConversationWindowReader,
  TurnStore,
  UnverifiedClaim,
} from '../../../src/orchestration/ports.js';
import type { LaneDeps, LaneInput } from '../../../src/orchestration/lanes/types.js';
import { DefaultResearchPlanner, normalizeEntityName } from '../../../src/orchestration/planner.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { FakeBudget } from '../../helpers/budget.js';

export const NOW: Ms = Date.UTC(2026, 10, 11, 15); // Wednesday 11 Nov 2026, 15:00 UTC

export const USER = 'usr_u1' as UserId;
export const CONV = 'cnv_c1' as ConversationId;
export const TURN = 'trn_t1' as TurnId;

export function analysis(over: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    laneHint: 'chat',
    intents: [],
    temporal: [],
    entities: [],
    references: [],
    topicTerms: [],
    asksStillCorrect: false,
    queries: [],
    alternateQueries: [],
    userFacts: [],
    degraded: false,
    ...over,
  };
}

export function mention(text: string) {
  return { text, normalized: normalizeEntityName(text) };
}

export function coverage(over: Partial<Finding['coverage']> = {}): Finding['coverage'] {
  return {
    searchesOk: 1,
    searchesFailed: 0,
    extractionFailed: false,
    sourcesChecked: 1,
    newestDatedSource: NOW,
    freshOfficialFetched: true,
    failure: null,
    ...over,
  };
}

export function finding(ord: number, over: Partial<Finding> = {}): Finding {
  return {
    id: newId('fnd'),
    ord,
    entityId: newId('ent'),
    entityName: `Entity${ord}`,
    intent: 'pricing',
    beliefKey: null,
    currentStatus: 'confirmed',
    verdict: null,
    verdictReason: null,
    coverage: coverage(),
    evidenceIds: [],
    ...over,
  };
}

export function unableFinding(
  ord: number,
  failure: Finding['coverage']['failure'] = 'search_unavailable',
) {
  return finding(ord, {
    currentStatus: 'unable_to_verify',
    verdict: 'unable_to_verify',
    verdictReason: failure,
    coverage: coverage({ searchesOk: 0, searchesFailed: 1, failure }),
  });
}

export function findingSet(turnId: TurnId, findings: Finding[]): FindingSet {
  return { turnId, createdAt: NOW, findings, sources: {} };
}

export function sentence(
  index: number,
  text: string,
  over: Partial<PersistedSentence> = {},
): PersistedSentence {
  return { index, text, template: text, status: 'verified', issues: [], placeholders: [], ...over };
}

export class FakeAnalyzer implements TurnAnalyzer {
  calls = 0;
  lastBudget: unknown = null;
  constructor(private readonly result: TurnAnalysis | Error) {}
  analyze(
    _input: Parameters<TurnAnalyzer['analyze']>[0],
    budget: Parameters<TurnAnalyzer['analyze']>[1],
  ) {
    this.calls += 1;
    this.lastBudget = budget;
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

export class FakeResearch implements ResearchService {
  calls: ResearchRequest[] = [];
  constructor(private readonly make: (req: ResearchRequest) => FindingSet | Error) {}
  run(req: ResearchRequest): Promise<FindingSet> {
    this.calls.push(req);
    const out = this.make(req);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export type AnswerResult = Awaited<ReturnType<AnswerPipeline['run']>>;

export class FakeAnswer implements AnswerPipeline {
  calls: Array<Parameters<AnswerPipeline['run']>[0]> = [];
  budgets: unknown[] = [];
  constructor(
    private readonly make: (input: Parameters<AnswerPipeline['run']>[0]) => AnswerResult | Error,
  ) {}
  run(input: Parameters<AnswerPipeline['run']>[0], budget: Parameters<AnswerPipeline['run']>[1]) {
    this.calls.push(input);
    this.budgets.push(budget);
    const out = this.make(input);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export function answerOf(
  sentences: PersistedSentence[],
  over: Partial<AnswerResult> = {},
): AnswerResult {
  return {
    sentences,
    streamedThrough: sentences.length - 1,
    interrupted: false,
    template: sentences.map((s) => s.template).join(' '),
    rendered: sentences.map((s) => s.text).join(' '),
    ...over,
  };
}

export class SpyMemory implements MemoryRetriever {
  calls: string[] = [];
  constructor(
    private readonly data: {
      messages?: MemoryCandidate[];
      entities?: ReturnType<MemoryRetriever['entitiesByAlias']>;
      decisions?: ReturnType<MemoryRetriever['decisions']>;
    } = {},
  ) {}
  messagesInIntervals(...args: Parameters<MemoryRetriever['messagesInIntervals']>) {
    this.calls.push('messagesInIntervals');
    const [, iv] = args;
    return (this.data.messages ?? [])
      .map((m) => ({
        ...m,
        intervalIndex: iv.findIndex((i) => m.createdAt >= i.startMs && m.createdAt < i.endMs),
      }))
      .filter((m) => m.intervalIndex >= 0);
  }
  searchAll() {
    this.calls.push('searchAll');
    return [];
  }
  decisions() {
    this.calls.push('decisions');
    return this.data.decisions ?? [];
  }
  entitiesByAlias(_u: UserId, normalized: string[]) {
    this.calls.push('entitiesByAlias');
    return (this.data.entities ?? []).filter(
      (e) =>
        normalized.includes(normalizeEntityName(e.name)) ||
        e.aliases.some((a) => normalized.includes(normalizeEntityName(a))),
    );
  }
}

export class SpyBaselines implements BaselineSource {
  calls: string[] = [];
  constructor(
    private readonly eligibleData: Baseline[] = [],
    private readonly unverifiedData: UnverifiedClaim[] = [],
  ) {}
  eligible(q: BaselineQuery) {
    this.calls.push(`eligible:${q.conversationIds.join(',')}`);
    return this.eligibleData;
  }
  unverified(q: BaselineQuery) {
    this.calls.push(`unverified:${q.conversationIds.join(',')}`);
    return this.unverifiedData;
  }
}

export class FakeWindow implements ConversationWindowReader {
  calls = 0;
  constructor(
    private readonly messages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ) {}
  recent() {
    this.calls += 1;
    return this.messages;
  }
}

/** An in-memory TurnStore that enforces the real 19-edge table and the finality rules. */
export class FakeTurnStore implements TurnStore {
  state: TurnState = 'RECEIVED';
  status: TurnStatus = 'running';
  states: TurnState[] = ['RECEIVED'];
  completions: TurnCompletion[] = [];
  failed: string[] = [];
  beginCalls = 0;
  existing: { existing: TurnId; status: TurnStatus } | null = null;
  completeError: Error | null = null;
  setStateErrorAt: { state: TurnState; error: Error } | null = null;
  assistantMessageId: MessageId | null = null;

  begin() {
    this.beginCalls += 1;
    if (this.existing) return this.existing;
    return { turnId: TURN, userMessageId: 'msg_u1' as MessageId };
  }
  setState(_u: UserId, _t: TurnId, s: TurnState) {
    if (this.setStateErrorAt?.state === s) throw this.setStateErrorAt.error;
    if (this.status !== 'running') throw new Error(`turn is ${this.status}`);
    if (isFinalState(s) || !canTransition(this.state, s)) {
      throw new Error(`illegal transition ${this.state} -> ${s}`);
    }
    this.state = s;
    this.states.push(s);
  }
  complete(_u: UserId, _t: TurnId, c: TurnCompletion) {
    if (this.completeError) throw this.completeError;
    if (this.state !== 'PERSISTING') throw new Error(`complete() in ${this.state}`);
    this.completions.push(c);
    this.state = 'COMPLETED';
    this.status = c.status;
    if (c.assistant) this.assistantMessageId = `msg_a1` as MessageId;
  }
  fail(_u: UserId, _t: TurnId, code: string) {
    if (this.state !== 'PERSISTING') throw new Error(`fail() in ${this.state}`);
    this.failed.push(code);
    this.state = 'FAILED';
    this.status = 'failed';
  }
  get() {
    return { assistantMessageId: this.assistantMessageId, status: this.status };
  }
  ack(): { renderedThrough: number; newlyPresented: number } {
    throw new Error('not used');
  }
  recoverRunning(): number {
    return 0;
  }
  deleteConversation(): void {
    throw new Error('not used');
  }
}

export function laneDeps(over: Partial<LaneDeps> = {}): LaneDeps {
  return {
    memory: new SpyMemory(),
    resolver: new DefaultTemporalResolver(),
    baselines: new SpyBaselines(),
    research: new FakeResearch((r) => findingSet(r.turnId, [])),
    planner: new DefaultResearchPlanner(),
    normalize: normalizeEntityName,
    ...over,
  };
}

export interface LaneHarness {
  input: LaneInput;
  events: SseEvent[];
  states: TurnState[];
}

export function laneInput(a: TurnAnalysis, over: Partial<LaneInput> = {}): LaneHarness {
  const events: SseEvent[] = [];
  const states: TurnState[] = [];
  const input: LaneInput = {
    userId: USER,
    conversationId: CONV,
    turnId: TURN,
    tz: 'UTC',
    analysis: a,
    now: NOW,
    budget: new FakeBudget(60_000, NOW),
    emit: (e) => events.push(e),
    progress: (s, text) => {
      states.push(s);
      events.push({ event: 'progress', data: { stage: s, text } });
    },
    ...over,
  };
  return { input, events, states };
}

export function entityRecord(
  name: string,
  over: { id?: EntityId; aliases?: string[]; domains?: string[] } = {},
) {
  return {
    id: over.id ?? newId('ent'),
    name,
    aliases: over.aliases ?? [name.toLowerCase()],
    plans: [],
    officialDomains: over.domains ?? [`${name.toLowerCase()}.com`],
  };
}

export function messageHit(at: Ms, conversationId: ConversationId, text: string): MemoryCandidate {
  return {
    conversationId,
    messageId: newId('msg'),
    turnId: null,
    createdAt: at,
    localTime: '09:00',
    excerpt: text,
    matchedTerms: [],
    score: 1,
    intervalIndex: 0,
  };
}
