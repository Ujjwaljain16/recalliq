import type { ExtractionBatch, VerifiedEvidence } from '../../shared/evidence.js';
import type { Ms } from '../../shared/ids.js';
import type { BudgetStage, TurnBudget } from '../../shared/infrastructure.js';
import type { LlmPort } from '../../shared/llm.js';
import { DomainAuthorityClassifier } from '../authority.js';
import { estimateTokens, MAX_SNAPSHOT_CHARS } from '../batcher.js';
import { ExtractionFailure, LlmEvidenceExtractor } from '../extractor.js';
import type { ExtractionPrompt } from '../prompts/extraction.js';
import { RuleEvidenceVerifier } from '../verifier.js';
import type { EntityRegistry } from './registry.js';
import { entityContextOf, entityIdOf, snapshotIdOf, snapshotOf } from './build.js';
import type { CalibrationPage, CalibrationSet } from './gold.js';
import { scorePage, type PageScore } from './scoring.js';

/**
 * A budget for an evaluation: a fixed time allowance per page, real timers, no stage reserves.
 */
export class EvalBudget implements TurnBudget {
  private readonly controller = new AbortController();
  readonly deadline: Ms;

  constructor(
    totalMs: Ms,
    private readonly now: () => Ms = () => Date.now(),
  ) {
    this.deadline = this.now() + totalMs;
    setTimeout(
      () => this.controller.abort(new DOMException('eval budget', 'TimeoutError')),
      totalMs,
    ).unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  remaining(): Ms {
    return Math.max(0, this.deadline - this.now());
  }
  timeoutFor(_stage: BudgetStage, capMs: Ms): Ms {
    return Math.min(capMs, this.remaining());
  }
  signalFor(stage: BudgetStage, capMs: Ms): AbortSignal {
    return AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, this.timeoutFor(stage, capMs))),
    ]);
  }
  admit(): boolean {
    return this.remaining() > 0;
  }
}

export interface PageRun {
  pageId: string;
  /** Every statement proposed (price or not) with the verifier's verdict. */
  statements: VerifiedEvidence[];
  extractionFailure: string | null;
  droppedUnknownRef: number;
  droppedOverCap: number;
}

export interface RunOptions {
  llm: LlmPort;
  /** The prompt under test; defaults to the extractor's own (the one in use). */
  prompt?: ExtractionPrompt;
  /** The verifier clock: only the planned-price cue reads it. */
  now: Ms;
  /** An optional owner registry (entity name to owned domains); default none. */
  registry?: EntityRegistry;
  /** Only these pages (by id); default all. */
  pageIds?: readonly string[];
  /** Time allowance per page call. Default 60 s. */
  perPageMs?: Ms;
  onPage?: (run: PageRun, index: number, total: number) => void;
}

const classifier = new DomainAuthorityClassifier();

/**
 * The real extraction path over the gold pages: LlmEvidenceExtractor (prompt, batching message, ref mapping,
 * caps) and RuleEvidenceVerifier (T0 to T2), one entity and one snapshot per call, sequentially. A provider
 * failure is recorded for the page and the run goes on; any other error is a bug and propagates.
 */
export async function runExtraction(set: CalibrationSet, opts: RunOptions): Promise<PageRun[]> {
  const wanted = opts.pageIds ? new Set(opts.pageIds) : null;
  const pages = set.pages.filter((p) => wanted === null || wanted.has(p.id));
  const runs: PageRun[] = [];
  for (const p of pages) {
    const run = await runPage(p, opts);
    runs.push(run);
    opts.onPage?.(run, runs.length, pages.length);
  }
  return runs;
}

async function runPage(p: CalibrationPage, opts: RunOptions): Promise<PageRun> {
  const snapshot = snapshotOf(p.id, p.page);
  const entity = entityContextOf(p.id, p.gold, opts.registry);
  const tier = classifier.classify(snapshot, entity.officialDomains);
  const extractor = new LlmEvidenceExtractor({
    llm: opts.llm,
    snapshots: () => [snapshot],
    entities: () => [{ id: entity.id, name: p.gold.entity.name, aliases: entity.aliases }],
    tierOf: () => tier,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
  });
  const batch: ExtractionBatch = {
    id: `eval_${p.id}`,
    entityIds: [entityIdOf(p.id)],
    snapshotIds: [snapshotIdOf(p.id)],
    estTokens: estimateTokens(Math.min(snapshot.text.length, MAX_SNAPSHOT_CHARS)),
    trimmed: snapshot.text.length > MAX_SNAPSHOT_CHARS ? [snapshot.id] : [],
  };
  const verifier = new RuleEvidenceVerifier();
  try {
    const detail = await extractor.extractDetailed(batch, new EvalBudget(opts.perPageMs ?? 60_000));
    return {
      pageId: p.id,
      statements: detail.evidence.map((raw) =>
        verifier.verify(raw, snapshot, entity, tier, opts.now),
      ),
      extractionFailure: null,
      droppedUnknownRef: detail.droppedUnknownRef,
      droppedOverCap: detail.droppedOverCap,
    };
  } catch (err) {
    if (!(err instanceof ExtractionFailure)) throw err;
    return {
      pageId: p.id,
      statements: [],
      extractionFailure: `${err.code}: ${err.message}`.slice(0, 300),
      droppedUnknownRef: 0,
      droppedOverCap: 0,
    };
  }
}

/** Scores every run against its page's gold. A run for a page that is not in the set is a programming error. */
export function scoreRuns(set: CalibrationSet, runs: readonly PageRun[]): PageScore[] {
  return runs.map((r) => {
    const p = set.pages.find((x) => x.id === r.pageId);
    if (!p) throw new Error(`scoreRuns: no calibration page ${r.pageId}`);
    return scorePage({
      pageId: p.id,
      categories: p.gold.categories,
      text: p.page.text,
      gold: p.gold,
      statements: r.statements,
      ...(r.extractionFailure !== null ? { extractionFailure: r.extractionFailure } : {}),
    });
  });
}
