import { z } from 'zod';
import type { PersistedSentence, SentenceIssue, SentenceStatus } from '../shared/answer.js';
import type { AckRequest } from '../shared/delivery.js';
import type {
  BillingPeriod,
  NormalizedValue,
  Unit,
  VerificationCheck,
} from '../shared/evidence.js';
import type {
  ChangeWindow,
  CoverageFailure,
  Coverage,
  Finding,
  FindingCurrentStatus,
  PriceVerdict,
  PriceVerdictReason,
  ReleaseVerdict,
} from '../shared/findings.js';
import type { PendingSignal } from '../shared/belief.js';
import type { LlmErrorCode, LlmRole } from '../shared/llm.js';
import type { TerminalTurnStatus, TurnMetrics, TurnRequest, TurnState } from '../shared/turn.js';
import type { Intent } from '../shared/understanding.js';

/**
 * Runtime validation of data crossing the persistence boundary (contracts: JSON columns are "validated with
 * zod on both read and write"). Each schema is `satisfies`-checked against its contract type, so a contract
 * change that the schema does not follow stops compiling; `exhaustive` additionally fails the build if an
 * enum here forgets a value the contract has.
 */

/** Builds a z.enum that must list every member of `T`, so the contract and the schema cannot drift. */
function exhaustive<T extends string>() {
  return <const L extends readonly [T, ...T[]]>(
    values: L &
      ([Exclude<T, L[number]>] extends [never] ? unknown : { missing: Exclude<T, L[number]> }),
  ) => z.enum(values);
}

const id = <P extends string>(prefix: P) => z.templateLiteral([`${prefix}_`, z.string()]);
const usrId = id('usr');
const cnvId = id('cnv');
const trnId = id('trn');
const entId = id('ent');
const srcId = id('src');
const evId = id('ev');
const fndId = id('fnd');
const asrId = id('asr');
const msgId = id('msg');

// ── sentences ──

const sentenceStatus = exhaustive<SentenceStatus>()([
  'verified',
  'no_claims',
  'unverified',
  'unchecked',
  'truncated',
]);

const sentenceIssue = exhaustive<SentenceIssue>()([
  'malformed_placeholder',
  'unknown_ref',
  'inapplicable_variant',
  'render_mismatch',
  'free_number',
  'free_currency',
  'free_percent',
  'free_date',
  'unsupported_verdict_word',
  'unsupported_global_negative',
  'duplicate_text',
  'judge_unsupported',
  'judge_partial',
  'judge_unavailable',
]);

export const persistedSentenceSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
  template: z.string(),
  status: sentenceStatus,
  issues: z.array(sentenceIssue),
  placeholders: z.array(
    z.object({
      token: z.string(),
      findingId: fndId.optional(),
      messageId: msgId.optional(),
      snapshotId: srcId.optional(),
      rendered: z.string(),
    }),
  ),
}) satisfies z.ZodType<PersistedSentence>;

export const persistedSentencesSchema = z.array(persistedSentenceSchema);

// ── values, findings ──

const unit = exhaustive<Unit>()(['per_seat', 'flat', 'usage', 'unspecified']);
const billingPeriod = exhaustive<BillingPeriod>()([
  'monthly',
  'annual',
  'monthly_billed_annually',
  'one_time',
  'unspecified',
]);
const valueKind = exhaustive<NormalizedValue['valueKind']>()([
  'exact',
  'lower_bound',
  'upper_bound',
]);

export const normalizedValueSchema = z.object({
  amount: z.number(),
  currency: z.string().min(1),
  currencySymbol: z.string().nullable(),
  unit,
  usageUnit: z.string().nullable(),
  billingPeriod,
  valueKind,
}) satisfies z.ZodType<NormalizedValue>;

const coverageFailure = exhaustive<CoverageFailure>()([
  'search_timeout',
  'search_unavailable',
  'quota_exhausted',
  'extraction_failed',
  'deadline',
]);

const coverageSchema = z.object({
  searchesOk: z.number().int().min(0),
  searchesFailed: z.number().int().min(0),
  extractionFailed: z.boolean(),
  sourcesChecked: z.number().int().min(0),
  newestDatedSource: z.number().nullable(),
  freshOfficialFetched: z.boolean(),
  failure: coverageFailure.nullable(),
  releaseSources: z.number().int().min(0).optional(),
  newestDatedReleaseSource: z.number().nullable().optional(),
}) satisfies z.ZodType<Coverage>;

const pendingSignalSchema = z.object({
  kind: exhaustive<PendingSignal['kind']>()(['lower_tier_newer', 'planned_due']),
  value: normalizedValueSchema,
  effectiveFrom: z.number().nullable(),
  evidenceIds: z.array(evId),
}) satisfies z.ZodType<PendingSignal>;

const changeWindowSchema = z.object({
  after: z.number(),
  notAfter: z.number(),
}) satisfies z.ZodType<ChangeWindow>;

const priceVerdict = exhaustive<PriceVerdict>()([
  'changed',
  'baseline_incorrect',
  'differs_timing_unknown',
  'unchanged_confirmed',
  'no_evidence_of_change',
  'contested',
  'unable_to_verify',
]);
const releaseVerdict = exhaustive<ReleaseVerdict>()([
  'releases_found',
  'none_found',
  'unable_to_verify',
]);
const verdictReason = exhaustive<PriceVerdictReason>()([
  'unsupported_at_time',
  'other_value_in_effect_at_T0',
  'timing_conflict',
  'same_source_bracketing',
  'stated_effective_date',
  'listed_differently',
  'insufficient_coverage',
  'search_timeout',
  'search_unavailable',
  'quota_exhausted',
  'extraction_failed',
  'deadline',
]);
const direction = exhaustive<NonNullable<Finding['direction']>>()(['up', 'down', 'other']);
const significance = exhaustive<'major' | 'minor'>()(['major', 'minor']);

export const findingSchema = z.object({
  id: fndId,
  ord: z.number().int().min(1),
  entityId: entId,
  entityName: z.string(),
  intent: exhaustive<Intent>()(['pricing', 'releases', 'general']),
  beliefKey: z.string().nullable(),
  currentStatus: exhaustive<FindingCurrentStatus>()([
    'confirmed',
    'contested',
    'stale',
    'unknown',
    'unable_to_verify',
  ]),
  verdict: z.union([priceVerdict, releaseVerdict]).nullable(),
  verdictReason: verdictReason.nullable(),
  direction: direction.optional(),
  changeWindow: changeWindowSchema.optional(),
  effectiveFrom: z.number().optional(),
  current: z
    .object({
      value: normalizedValueSchema.nullable(),
      displayedAt: z.number().nullable(),
      verifiedAt: z.number().nullable(),
      citations: z.array(srcId),
      contested: z
        .array(
          z.object({
            value: normalizedValueSchema,
            evidenceIds: z.array(evId),
            conditions: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      pendingSignals: z.array(pendingSignalSchema),
    })
    .optional(),
  baseline: z
    .object({
      value: normalizedValueSchema,
      presentedAt: z.number(),
      citations: z.array(srcId),
      assertionId: asrId,
    })
    .optional(),
  releases: z
    .array(
      z.object({
        title: z.string(),
        kind: exhaustive<'launch' | 'change' | 'removal'>()(['launch', 'change', 'removal']),
        eventDate: z.number().nullable(),
        providerPublishedAt: z.number().nullable(),
        significance: significance.nullable(),
        announcedBeforeBaseline: z.boolean(),
        citations: z.array(srcId),
      }),
    )
    .optional(),
  derived: z
    .array(
      z.object({
        label: z.string(),
        amount: z.number(),
        currency: z.string(),
        currencySymbol: z.string().nullable(),
        formula: z.string(),
      }),
    )
    .optional(),
  coverage: coverageSchema,
  evidenceIds: z.array(evId),
}) satisfies z.ZodType<Finding>;

// ── turns ──

const terminalStatus = exhaustive<TerminalTurnStatus>()([
  'complete',
  'partial',
  'clarify',
  'interrupted',
  'failed',
]);

export const turnStateSchema = exhaustive<TurnState>()([
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
  'PERSISTING',
  'COMPLETED',
  'FAILED',
]);

/** Text limits from architecture §15 (messages are capped at 4,000 characters). */
export const turnRequestSchema = z.object({
  userId: usrId,
  conversationId: cnvId,
  text: z.string().min(1).max(4000),
  tz: z.string().min(1).max(64),
  idempotencyKey: z.string().min(1).max(128),
  retryOfTurnId: trnId.optional(),
}) satisfies z.ZodType<TurnRequest>;

export const ackRequestSchema = z.object({
  renderedThrough: z.number().int().min(-1),
  complete: z.boolean(),
}) satisfies z.ZodType<AckRequest>;

const llmRole = exhaustive<LlmRole>()(['analysis', 'extraction', 'synthesis', 'judge']);
const llmErrorCode = exhaustive<LlmErrorCode>()([
  'rate_limited',
  'unavailable',
  'timeout',
  'cancelled',
  'refused',
  'invalid_output',
  'bad_request',
]);
const verificationCheck = exhaustive<VerificationCheck>()([
  'quote_verbatim',
  'context_verbatim',
  'context_association',
  'subject_binding',
  'competitor_attribution',
  'plan_binding',
  'intervening_tier',
  'value_presence',
  'currency',
  'unit',
  'billing_period',
  'date_presence',
  'negation',
  'historical_cue',
  'conditional_cue',
  'planned_cue',
]);
const count = z.number().int().min(0);

export const turnMetricsSchema = z.object({
  ttfpMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  ttcMs: z.number(),
  deadlineHit: z.boolean(),
  llmCalls: z.array(
    z.object({
      role: llmRole,
      model: z.string(),
      usage: z.object({
        inputTokens: count,
        outputTokens: count,
        cacheReadTokens: count,
        cacheWriteTokens: count,
      }),
      latencyMs: z.number(),
      ok: z.boolean(),
      errorCode: llmErrorCode.optional(),
    }),
  ),
  searches: z.object({
    total: count,
    ok: count,
    failed: count,
    cached: count,
    notAdmitted: count,
    costUsd: z.number(),
  }),
  extraction: z.object({ batches: count, retries: count, splits: count }),
  verification: z.object({
    pass: count,
    weak: count,
    fail: count,
    byCheck: z.partialRecord(verificationCheck, z.object({ weak: count, fail: count })),
  }),
  sentences: z.object({
    verified: count,
    no_claims: count,
    unverified: count,
    unchecked: count,
    truncated: count,
  }),
  judgeCalls: count,
  statesVisited: z.array(turnStateSchema),
}) satisfies z.ZodType<TurnMetrics>;

/**
 * The parts of a TurnCompletion that the persistence layer stores and relies on. `analysis`, `context` and `events` are
 * checked only as JSON-shaped envelopes here: their full schemas arrive with their producers (turn analysis,
 * memory, and the SSE writer). See docs/questions.md, "JSON columns are only partly validated".
 */
export const turnCompletionSchema = z.object({
  status: terminalStatus,
  assistant: z
    .object({
      rendered: z.string(),
      template: z.string(),
      sentences: persistedSentencesSchema,
      streamedThrough: z.number().int().min(-1),
      messageStatus: exhaustive<'complete' | 'interrupted'>()(['complete', 'interrupted']),
    })
    .nullable(),
  findings: z
    .object({
      turnId: trnId,
      createdAt: z.number(),
      findings: z.array(findingSchema),
      sources: z.record(srcId, z.object({}).loose()),
    })
    .nullable(),
  assertions: z.array(
    z.object({
      findingId: fndId,
      sentenceIndex: z.number().int().min(0),
      placeholder: z.string().regex(/^F[1-9]\d{0,2}(:baseline|:verdict|:derived:\d+)?$/),
      beliefKey: z.string().nullable(),
      renderedText: z.string().min(1),
      value: normalizedValueSchema.nullable(),
      evidenceIds: z.array(evId),
    }),
  ),
  baselineEvents: z.array(
    z.object({
      assertionId: asrId,
      status: exhaustive<
        | 'reaffirmed'
        | 'superseded_world_changed'
        | 'retracted_was_wrong'
        | 'contested'
        | 'unverifiable_now'
        | 'differs_timing_unknown'
      >()([
        'reaffirmed',
        'superseded_world_changed',
        'retracted_was_wrong',
        'contested',
        'unverifiable_now',
        'differs_timing_unknown',
      ]),
      reason: z.string(),
      evidenceIds: z.array(evId),
    }),
  ),
  touchedBeliefKeys: z.array(z.string()),
  enrichment: z.object({
    tags: z.array(z.string()),
    entities: z.array(z.unknown()),
    decisions: z.array(z.unknown()),
  }),
  analysis: z.record(z.string(), z.unknown()).nullable(),
  context: z.record(z.string(), z.unknown()).nullable(),
  events: z.array(z.object({ event: z.string(), data: z.unknown() })),
  metrics: turnMetricsSchema,
  errorCode: z.string().optional(),
});
