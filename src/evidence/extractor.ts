import {
  LlmError,
  type EntityId,
  type ExtractionBatch,
  type EvidenceExtractor,
  type LlmPort,
  type RawEvidence,
  type SnapshotId,
  type SourceSnapshot,
  type TurnBudget,
  type AuthorityTier,
  type CoverageFailure,
} from '../shared/index.js';
import { estimateTokens, MAX_SNAPSHOT_CHARS } from './batcher.js';
import {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_SYSTEM_PROMPT,
  MAX_STATEMENTS_PER_ENTITY_KIND,
  buildExtractionMessage,
  extractionOutputSchema,
  type ExtractedStatement,
  type ExtractionPrompt,
  type PromptEntity,
  type PromptSource,
} from './prompts/extraction.js';

/** A batch call failed for a reason of the world (provider, deadline, invalid output), not of our code. */
export class ExtractionFailure extends Error {
  constructor(
    public readonly code:
      'rate_limited' | 'unavailable' | 'timeout' | 'invalid_output' | 'deadline' | 'rejected',
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionFailure';
  }

  /** R1: 429, 5xx, timeout and invalid output are retried once when admission allows. */
  get retryable(): boolean {
    return ['rate_limited', 'unavailable', 'timeout', 'invalid_output'].includes(this.code);
  }
}

export interface ExtractorEntity {
  id: EntityId;
  name: string;
  aliases: readonly string[];
}

export interface ExtractorDeps {
  llm: LlmPort;
  /** Looks up snapshots of a batch. A missing id is a programmer error and throws. */
  snapshots(ids: readonly SnapshotId[]): SourceSnapshot[];
  entities(ids: readonly EntityId[]): ExtractorEntity[];
  tierOf?: (s: SourceSnapshot, entityId: EntityId) => AuthorityTier;
  maxSnapshotChars?: number;
  extractionCapMs?: number;
  /** The system prompt to use; defaults to the one in use (v1). Lets an evaluation compare prompt versions. */
  prompt?: ExtractionPrompt;
}

export interface ExtractionDetail {
  evidence: RawEvidence[];
  droppedUnknownRef: number;
  droppedOverCap: number;
}

/**
 * One LLM call per batch. The model returns proposals keyed by short refs (S1, E2); this class maps them back
 * to real ids and drops anything citing a ref that was not in the batch (T0). It never decides truth.
 */
export class LlmEvidenceExtractor implements EvidenceExtractor {
  constructor(private readonly deps: ExtractorDeps) {}

  async extract(batch: ExtractionBatch, budget: TurnBudget): Promise<RawEvidence[]> {
    return (await this.extractDetailed(batch, budget)).evidence;
  }

  async extractDetailed(batch: ExtractionBatch, budget: TurnBudget): Promise<ExtractionDetail> {
    const cap = this.deps.extractionCapMs ?? 25_000;
    const maxChars = this.deps.maxSnapshotChars ?? MAX_SNAPSHOT_CHARS;
    const snaps = this.deps.snapshots(batch.snapshotIds);
    if (snaps.length !== batch.snapshotIds.length)
      throw new Error('extractor: a snapshot of the batch could not be found');
    const ents = this.deps.entities(batch.entityIds);
    if (ents.length !== batch.entityIds.length)
      throw new Error('extractor: an entity of the batch could not be found');

    const entityRefs = new Map<string, EntityId>();
    const promptEntities: PromptEntity[] = ents.map((e, i) => {
      const ref = `E${i + 1}`;
      entityRefs.set(ref, e.id);
      return { ref, name: e.name, aliases: e.aliases };
    });
    const sourceRefs = new Map<string, SnapshotId>();
    const promptSources: PromptSource[] = snaps.map((s, i) => {
      const ref = `S${i + 1}`;
      sourceRefs.set(ref, s.id);
      const first = ents[0];
      return {
        ref,
        snapshot: s,
        tier: this.deps.tierOf && first ? this.deps.tierOf(s, first.id) : 'C',
        text: s.text.slice(0, maxChars),
      };
    });

    if (budget.timeoutFor('extraction', cap) <= 0)
      throw new ExtractionFailure('deadline', 'no time left to start an extraction call');
    let statements: ExtractedStatement[];
    try {
      const out = await this.deps.llm.structured({
        role: 'extraction',
        system: this.deps.prompt?.system ?? EXTRACTION_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildExtractionMessage(promptEntities, promptSources) },
        ],
        schema: extractionOutputSchema,
        schemaName: 'evidence_extraction',
        maxTokens: EXTRACTION_MAX_TOKENS,
        signal: budget.signalFor('extraction', cap),
      });
      statements = out.value.statements;
    } catch (err) {
      if (err instanceof LlmError) {
        const code =
          err.code === 'cancelled'
            ? 'deadline'
            : err.code === 'refused' || err.code === 'bad_request'
              ? 'rejected'
              : err.code;
        throw new ExtractionFailure(code, err.message);
      }
      throw err;
    }

    const evidence: RawEvidence[] = [];
    const perKey = new Map<string, number>();
    let droppedUnknownRef = 0;
    let droppedOverCap = 0;
    for (const st of statements) {
      const snapshotId = sourceRefs.get(st.sourceId);
      const entityId = entityRefs.get(st.entityId);
      if (snapshotId === undefined || entityId === undefined) {
        droppedUnknownRef++;
        continue;
      }
      const k = `${entityId}|${st.kind}`;
      const n = perKey.get(k) ?? 0;
      if (n >= MAX_STATEMENTS_PER_ENTITY_KIND) {
        droppedOverCap++;
        continue;
      }
      perKey.set(k, n + 1);
      evidence.push(toRaw(st, snapshotId, entityId));
    }
    return { evidence, droppedUnknownRef, droppedOverCap };
  }
}

function toRaw(st: ExtractedStatement, snapshotId: SnapshotId, entityId: EntityId): RawEvidence {
  const fields: RawEvidence['fields'] = {
    plan: st.plan,
    planNorm: st.planNorm,
    attribute: st.kind,
    value: st.value,
    conditions: st.conditions,
  };
  if (st.releaseTitle !== null) fields.releaseTitle = st.releaseTitle;
  if (st.releaseKind !== null) fields.releaseKind = st.releaseKind;
  return {
    snapshotRef: snapshotId,
    entityRef: entityId,
    kind: st.kind,
    fields,
    quote: st.quote,
    contextQuote: st.contextQuote,
    polarity: st.polarity,
    modality: st.modality,
    effectiveFromText: st.effectiveFromText,
    eventDateText: st.eventDateText,
    significance: st.significance,
    significanceReason: st.significanceReason,
  };
}

/** A process-wide limit on concurrent LLM calls (`LLM_CONCURRENCY = 4`). */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new RangeError('Semaphore limit must be at least 1');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export interface RunnerExtractor {
  extractDetailed(batch: ExtractionBatch, budget: TurnBudget): Promise<ExtractionDetail>;
}

export interface ExtractionRunResult {
  evidence: RawEvidence[];
  /** Entities with no extraction at all: their findings become unable_to_verify. */
  failedEntities: Map<EntityId, Extract<CoverageFailure, 'extraction_failed' | 'deadline'>>;
  stats: {
    batches: number;
    retries: number;
    splits: number;
    droppedUnknownRef: number;
    droppedOverCap: number;
  };
}

/**
 * R1 failure handling. A failing batch is retried once if admitted, then split into one call per entity if
 * admitted; an entity that still has nothing is reported failed. One batch failing never blocks the others.
 * Only `ExtractionFailure` is handled: any other error is a bug and propagates.
 */
export class ExtractionRunner {
  constructor(
    private readonly extractor: RunnerExtractor,
    private readonly semaphore: Semaphore = new Semaphore(4),
  ) {}

  async run(
    batches: ExtractionBatch[],
    byEntity: Map<EntityId, SourceSnapshot[]>,
    budget: TurnBudget,
  ): Promise<ExtractionRunResult> {
    const result: ExtractionRunResult = {
      evidence: [],
      failedEntities: new Map(),
      stats: {
        batches: batches.length,
        retries: 0,
        splits: 0,
        droppedUnknownRef: 0,
        droppedOverCap: 0,
      },
    };
    const parts = await Promise.all(batches.map((b) => this.runBatch(b, byEntity, budget, result)));
    for (const p of parts) result.evidence.push(...p);
    return result;
  }

  private async attempt(
    batch: ExtractionBatch,
    budget: TurnBudget,
    r: ExtractionRunResult,
  ): Promise<RawEvidence[]> {
    const d = await this.semaphore.run(() => this.extractor.extractDetailed(batch, budget));
    r.stats.droppedUnknownRef += d.droppedUnknownRef;
    r.stats.droppedOverCap += d.droppedOverCap;
    return d.evidence;
  }

  private fail(batch: ExtractionBatch, err: ExtractionFailure, r: ExtractionRunResult): void {
    for (const id of batch.entityIds)
      r.failedEntities.set(id, err.code === 'deadline' ? 'deadline' : 'extraction_failed');
  }

  private async runBatch(
    batch: ExtractionBatch,
    byEntity: Map<EntityId, SourceSnapshot[]>,
    budget: TurnBudget,
    r: ExtractionRunResult,
  ): Promise<RawEvidence[]> {
    let failure: ExtractionFailure;
    try {
      return await this.attempt(batch, budget, r);
    } catch (err) {
      if (!(err instanceof ExtractionFailure)) throw err;
      failure = err;
    }
    if (failure.retryable && budget.admit('extraction_retry')) {
      r.stats.retries++;
      try {
        return await this.attempt(batch, budget, r);
      } catch (err) {
        if (!(err instanceof ExtractionFailure)) throw err;
        failure = err;
      }
    }
    if (
      failure.code !== 'deadline' &&
      failure.code !== 'rejected' &&
      batch.entityIds.length > 1 &&
      budget.admit('extraction_split')
    ) {
      r.stats.splits++;
      const own = new Set(batch.snapshotIds);
      const outs = await Promise.all(
        batch.entityIds.map(async (entityId): Promise<RawEvidence[]> => {
          const snaps = (byEntity.get(entityId) ?? []).filter((s) => own.has(s.id));
          const single: ExtractionBatch = {
            id: `${batch.id}_${entityId}`,
            entityIds: [entityId],
            snapshotIds: snaps.map((s) => s.id),
            estTokens: snaps.reduce(
              (n, s) => n + estimateTokens(Math.min(s.text.length, MAX_SNAPSHOT_CHARS)),
              0,
            ),
            trimmed: batch.trimmed.filter((id) => snaps.some((s) => s.id === id)),
          };
          try {
            return await this.attempt(single, budget, r);
          } catch (err) {
            if (!(err instanceof ExtractionFailure)) throw err;
            this.fail(single, err, r);
            return [];
          }
        }),
      );
      return outs.flat();
    }
    this.fail(batch, failure, r);
    return [];
  }
}
