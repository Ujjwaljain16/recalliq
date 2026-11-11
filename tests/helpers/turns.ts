import { randomUUID } from 'node:crypto';
import type { PersistedSentence } from '../../src/shared/answer.js';
import type { NormalizedValue } from '../../src/shared/evidence.js';
import type { Finding } from '../../src/shared/findings.js';
import {
  newId,
  type ConversationId,
  type EntityId,
  type EvidenceId,
  type MessageId,
  type TurnId,
  type UserId,
} from '../../src/shared/ids.js';
import type { TurnCompletion } from '../../src/shared/repositories.js';
import type { TerminalTurnStatus, TurnMetrics, TurnState } from '../../src/shared/turn.js';
import { insertEntity, T0, type TestDb } from './db.js';

export const USD_90: NormalizedValue = {
  amount: 90,
  currency: 'USD',
  currencySymbol: 'US$',
  unit: 'per_seat',
  usageUnit: null,
  billingPeriod: 'monthly',
  valueKind: 'exact',
};

export const RENDERED_PRICE = 'US$90 per user per month [1]';

export function emptyMetrics(): TurnMetrics {
  return {
    ttfpMs: null,
    ttftMs: null,
    ttcMs: 1,
    deadlineHit: false,
    llmCalls: [],
    searches: { total: 0, ok: 0, failed: 0, cached: 0, notAdmitted: 0, costUsd: 0 },
    extraction: { batches: 0, retries: 0, splits: 0 },
    verification: { pass: 0, weak: 0, fail: 0, byCheck: {} },
    sentences: { verified: 0, no_claims: 0, unverified: 0, unchecked: 0, truncated: 0 },
    judgeCalls: 0,
    statesVisited: [],
  };
}

/** The path a chat or recall turn takes (architecture §4): five transitions to PERSISTING. */
export const CHAT_PATH: readonly TurnState[] = [
  'ANALYZING',
  'RESOLVING_CONTEXT',
  'SYNTHESIZING',
  'POST_VERIFYING',
  'PERSISTING',
];

/** Starts a turn through the repository (so the user message and turn row are real). */
export function startTurn(
  t: TestDb,
  userId: UserId,
  conversationId: ConversationId,
  opts: { key?: string; text?: string; retryOfTurnId?: TurnId } = {},
): { turnId: TurnId; userMessageId: MessageId } {
  const result = t.turns.begin(
    {
      userId,
      conversationId,
      text: opts.text ?? 'What does HubSpot charge?',
      tz: 'Europe/London',
      idempotencyKey: opts.key ?? randomUUID(),
      ...(opts.retryOfTurnId ? { retryOfTurnId: opts.retryOfTurnId } : {}),
    },
    t.clock.now(),
    t.clock.now() + 60_000,
  );
  if ('existing' in result) throw new Error('expected a new turn, got an existing one');
  return result;
}

export function advance(
  t: TestDb,
  userId: UserId,
  turnId: TurnId,
  path: readonly TurnState[] = CHAT_PATH,
): void {
  for (const state of path) t.turns.setState(userId, turnId, state);
}

export interface AnswerSpec {
  turnId: TurnId;
  userId: UserId;
  entityId: EntityId;
  /** Total number of sentences in the answer. */
  sentences: number;
  /** Indexes of sentences that carry the finding's price (placeholder F1). */
  claimsAt: readonly number[];
  /** Highest sentence index fully streamed. */
  streamedThrough: number;
  status?: TerminalTurnStatus;
  evidenceIds?: EvidenceId[];
  /** Replaces fields of the built completion, for the tests that need a deliberately odd one. */
  override?: Partial<TurnCompletion>;
}

export function buildFinding(entityId: EntityId, ord = 1): Finding {
  return {
    id: newId('fnd'),
    ord,
    entityId,
    entityName: 'HubSpot',
    intent: 'pricing',
    beliefKey: null,
    currentStatus: 'confirmed',
    verdict: null,
    verdictReason: null,
    current: {
      value: USD_90,
      displayedAt: T0,
      verifiedAt: T0,
      citations: [],
      pendingSignals: [],
    },
    coverage: {
      searchesOk: 1,
      searchesFailed: 0,
      extractionFailed: false,
      sourcesChecked: 1,
      newestDatedSource: T0,
      freshOfficialFetched: true,
      failure: null,
    },
    evidenceIds: [],
  };
}

/** A consistent TurnCompletion: one finding, one assertion per claim sentence, sentences as rendered. */
export function buildCompletion(spec: AnswerSpec): TurnCompletion {
  const finding = buildFinding(spec.entityId);
  const interrupted = spec.status === 'interrupted';
  const sentences: PersistedSentence[] = Array.from({ length: spec.sentences }, (_, index) => {
    const claims = spec.claimsAt.includes(index);
    return {
      index,
      text: claims ? `HubSpot costs ${RENDERED_PRICE}.` : `Sentence ${index}.`,
      template: claims ? 'HubSpot costs [[F1]].' : `Sentence ${index}.`,
      status: claims ? ('verified' as const) : ('no_claims' as const),
      issues: [],
      placeholders: claims
        ? [{ token: '[[F1]]', findingId: finding.id, rendered: RENDERED_PRICE }]
        : [],
    };
  });
  const base: TurnCompletion = {
    status: spec.status ?? 'complete',
    assistant: {
      rendered: sentences.map((s) => s.text).join(' '),
      template: sentences.map((s) => s.template).join(' '),
      sentences,
      streamedThrough: spec.streamedThrough,
      messageStatus: interrupted ? 'interrupted' : 'complete',
    },
    findings: { turnId: spec.turnId, createdAt: T0, findings: [finding], sources: {} },
    assertions: spec.claimsAt.map((sentenceIndex) => ({
      findingId: finding.id,
      sentenceIndex,
      placeholder: 'F1',
      beliefKey: null,
      renderedText: RENDERED_PRICE,
      value: USD_90,
      evidenceIds: spec.evidenceIds ?? [],
    })),
    baselineEvents: [],
    touchedBeliefKeys: [],
    enrichment: { tags: [], entities: [], decisions: [] },
    analysis: null,
    context: {
      lane: 'chat',
      temporal: [],
      memoryHits: [],
      decisions: [],
      entities: [],
      baselines: [],
    },
    events: [
      {
        event: 'turn.completed',
        data: {
          status: spec.status ?? 'complete',
          metrics: { ttfpMs: null, ttftMs: null, ttcMs: 1 },
        },
      },
    ],
    metrics: emptyMetrics(),
  };
  return { ...base, ...spec.override };
}

export interface CompletedAnswer {
  userId: UserId;
  conversationId: ConversationId;
  turnId: TurnId;
  entityId: EntityId;
  assistantMessageId: MessageId;
}

/**
 * Drives a whole turn through the real repository: begin, advance to PERSISTING, complete. Returns the ids
 * needed to acknowledge and inspect it.
 */
export function completedAnswer(
  t: TestDb,
  spec: Omit<AnswerSpec, 'turnId' | 'userId' | 'entityId'> & {
    userId?: UserId;
    conversationId?: ConversationId;
    retryOfTurnId?: TurnId;
  },
): CompletedAnswer {
  const userId = spec.userId ?? t.users.create();
  const conversationId = spec.conversationId ?? t.conversations.create({ userId }).id;
  const { turnId } = startTurn(t, userId, conversationId, {
    ...(spec.retryOfTurnId ? { retryOfTurnId: spec.retryOfTurnId } : {}),
  });
  advance(t, userId, turnId);
  const entityId = insertEntity(t.db, { userId, norm: `hubspot-${turnId}` });
  t.turns.complete(userId, turnId, buildCompletion({ ...spec, turnId, userId, entityId }));
  const turn = t.turns.get(userId, turnId);
  if (!turn?.assistantMessageId) throw new Error('turn has no assistant message after complete()');
  return { userId, conversationId, turnId, entityId, assistantMessageId: turn.assistantMessageId };
}
