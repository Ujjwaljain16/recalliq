import type { Db } from '../db/index.js';
import type { FindingAssembler } from '../belief/assembler.js';
import { type EntityAssemblyInput } from '../belief/assembler.js';
import { decodePriceKey, plannedTwinKey } from '../belief/belief-key.js';
import type { BeliefRepository } from '../belief/repository.js';
import type { EntailmentJudge } from '../evidence/entailment.js';
import type { ExtractionRunner } from '../evidence/extractor.js';
import type { EvidenceRepository } from '../evidence/repository.js';
import type {
  AuthorityClassifier,
  Baseline,
  Coverage,
  CoverageFailure,
  EntityContext,
  EntityId,
  EvidenceVerifier,
  ExtractionBatcher,
  Finding,
  FindingSet,
  Intent,
  Ms,
  RawEvidence,
  ResearchExecutor,
  ResearchRequest,
  ResearchService,
  SearchOutcome,
  SnapshotId,
  SnapshotReader,
  SourceSnapshot,
  VerifiedEvidence,
} from '../shared/index.js';

/** Default release look-back when neither a baseline nor a temporal mention gives the start of the interval. */
export const DEFAULT_RELEASE_LOOKBACK_MS = 30 * 86_400_000;

export interface ResearchServiceDeps {
  db: Db;
  executor: ResearchExecutor;
  snapshots: SnapshotReader;
  batcher: ExtractionBatcher;
  runner: ExtractionRunner;
  verifier: EvidenceVerifier;
  classifier: AuthorityClassifier;
  evidence: EvidenceRepository;
  beliefs: BeliefRepository;
  assembler: FindingAssembler;
  judge?: EntailmentJudge;
}

type EntityRow = ResearchRequest['ctx']['entities'][number];

interface EntityState {
  entity: EntityRow;
  intents: Intent[];
  searchesOk: number;
  searchesFailed: number;
  searchFailure: CoverageFailure | null;
  extractionFailure: Extract<CoverageFailure, 'extraction_failed' | 'deadline'> | null;
  snapshots: Map<SnapshotId, SourceSnapshot>;
  verified: VerifiedEvidence[];
}

function mapSearchFailure(code: SearchOutcome['errorCode']): CoverageFailure {
  switch (code) {
    case 'timeout':
      return 'search_timeout';
    case 'quota_exhausted':
      return 'quota_exhausted';
    case 'deadline':
    case 'cancelled':
      return 'deadline';
    default:
      return 'search_unavailable';
  }
}

const isTierA = (e: VerifiedEvidence) => e.authorityTier === 'A1' || e.authorityTier === 'A2';

/**
 * Search, snapshots, extraction, T0 to T3, belief resolution, verdicts, findings.
 *
 * Failures of the world (a search outcome that failed, an extraction that failed, the deadline) become
 * `Coverage.failure` and `unable_to_verify` findings. Everything else propagates: a database error (including
 * an ownership or immutability trigger rejecting a write), a thrown error from the executor, or a bug. Only
 * `ExtractionFailure` (inside the runner) and `LlmError` (inside the judge) are ever caught.
 */
export class PipelineResearchService implements ResearchService {
  constructor(private readonly d: ResearchServiceDeps) {}

  async run(req: ResearchRequest): Promise<FindingSet> {
    const { ctx, userId, turnId, now, budget } = req;
    const intents: Intent[] = req.analysis.intents.length > 0 ? req.analysis.intents : ['pricing'];
    const planIds = new Set(
      [...req.plan.specs, ...req.plan.fallback].flatMap((s) => (s.entityId ? [s.entityId] : [])),
    );
    for (const b of ctx.baselines) planIds.add(b.entityId);
    const chosen = ctx.entities.filter((e) => planIds.has(e.id));
    const entities = chosen.length > 0 ? chosen : ctx.entities;
    const states = new Map<EntityId, EntityState>(
      entities.map((entity) => [
        entity.id,
        {
          entity,
          intents,
          searchesOk: 0,
          searchesFailed: 0,
          searchFailure: null,
          extractionFailure: null,
          snapshots: new Map(),
          verified: [],
        },
      ]),
    );
    const allSnapshots = new Map<SnapshotId, SourceSnapshot>();

    const round = async (n: 1 | 2, plan: ResearchRequest['plan']) => {
      const outcomes = await this.d.executor.execute(plan, n, budget, req.emit);
      await this.process(req, states, allSnapshots, outcomes);
    };

    await round(1, req.plan);
    if (req.plan.fallback.length > 0 && !budget.signal.aborted && budget.admit('fallback_round')) {
      const needing = new Set(
        [...states.values()].filter((s) => this.needsFallback(s)).map((s) => s.entity.id),
      );
      const fallback = req.plan.fallback.filter(
        (s) => s.entityId !== null && needing.has(s.entityId),
      );
      if (fallback.length > 0) await round(2, { ...req.plan, fallback });
    }

    // Beliefs: re-resolve every key the user has for these entities, at `now`.
    const touched = new Set<string>();
    for (const s of states.values()) {
      for (const e of s.verified) if (e.beliefKey?.startsWith('price:')) touched.add(e.beliefKey);
      for (const b of this.d.beliefs.forEntity(userId, s.entity.id)) touched.add(b.key);
    }
    for (const b of ctx.baselines) if (states.has(b.entityId)) touched.add(b.beliefKey);
    this.d.beliefs.updateKeys(userId, [...touched], now, turnId);

    const inputs: EntityAssemblyInput[] = [];
    for (const s of states.values()) {
      const beliefs = this.d.beliefs.forEntity(userId, s.entity.id);
      const baselines = ctx.baselines
        .filter((b) => b.entityId === s.entity.id)
        .map((b) => this.reverify(req, b, s.entity, ctx.entities));
      const keys = new Set([...beliefs.map((b) => b.key), ...baselines.map((b) => b.beliefKey)]);
      const evidenceByKey = new Map<string, VerifiedEvidence[]>();
      for (const k of keys) {
        const wanted = decodePriceKey(k).arrangement === 'list' ? [k, plannedTwinKey(k)] : [k];
        evidenceByKey.set(
          k,
          this.d.evidence.passForKeys(userId, wanted).map((x) => x.evidence),
        );
      }
      const releaseEvidence = this.d.evidence.passReleasesForEntity(userId, s.entity.id);
      for (const e of [...evidenceByKey.values()].flat().concat(releaseEvidence)) {
        if (!allSnapshots.has(e.snapshotId)) {
          const got = this.d.snapshots.getMany(userId, [e.snapshotId])[0];
          if (got) allSnapshots.set(got.id, got);
        }
      }
      const failed = this.coverage(s, evidenceByKey);
      inputs.push({
        entity: s.entity,
        intents: s.intents,
        coverage: failed,
        beliefs,
        evidenceByKey,
        releaseEvidence,
        baselines,
        releaseSince: this.releaseSince(req, baselines),
      });
    }

    const set = this.d.assembler.assemble({
      turnId,
      createdAt: now,
      entities: inputs,
      snapshots: allSnapshots,
    });
    this.emitAll(req, set, allSnapshots);
    return set;
  }

  private needsFallback(s: EntityState): boolean {
    const price = s.intents.includes('pricing')
      ? s.verified.some((e) => e.kind === 'price' && e.verification.status === 'pass' && isTierA(e))
      : true;
    const release = s.intents.includes('releases')
      ? s.verified.some((e) => e.kind === 'release' && e.verification.status === 'pass')
      : true;
    return !(price && release);
  }

  /** Records outcomes, reads snapshots, extracts, verifies, judges and stores. */
  private async process(
    req: ResearchRequest,
    states: Map<EntityId, EntityState>,
    allSnapshots: Map<SnapshotId, SourceSnapshot>,
    outcomes: SearchOutcome[],
  ): Promise<void> {
    const { userId, turnId, now, budget, ctx } = req;
    const ids = new Map<EntityId, SnapshotId[]>();
    for (const o of outcomes) {
      const st = o.spec.entityId ? states.get(o.spec.entityId) : undefined;
      if (!st) continue;
      if (o.status === 'failed') {
        st.searchesFailed++;
        st.searchFailure ??= mapSearchFailure(o.errorCode);
      } else st.searchesOk++;
      const list = ids.get(st.entity.id) ?? [];
      list.push(...o.snapshotIds);
      ids.set(st.entity.id, list);
    }
    const wanted = [...new Set([...ids.values()].flat())];
    const read = new Map(this.d.snapshots.getMany(userId, wanted).map((s) => [s.id, s]));

    // Per entity: keep each distinct (url_norm, sha256) once, and skip snapshots with no text.
    const byEntity = new Map<EntityId, SourceSnapshot[]>();
    for (const [entityId, list] of ids) {
      const st = states.get(entityId);
      if (!st) continue;
      const seen = new Set<string>();
      const kept: SourceSnapshot[] = [];
      for (const id of list) {
        const s = read.get(id);
        if (!s) continue;
        allSnapshots.set(s.id, s);
        st.snapshots.set(s.id, s);
        const fp = `${s.urlNorm}|${s.sha256}`;
        if (seen.has(fp) || s.text.trim().length === 0) continue;
        seen.add(fp);
        kept.push(s);
      }
      if (kept.length > 0) byEntity.set(entityId, kept);
    }
    if (byEntity.size === 0) return;

    const batches = this.d.batcher.pack(byEntity);
    const run = await this.d.runner.run(batches, byEntity, budget);
    for (const [entityId, code] of run.failedEntities) {
      const st = states.get(entityId);
      if (st) st.extractionFailure = code;
    }

    const snapshotsById = new Map<string, SourceSnapshot>();
    for (const list of byEntity.values()) for (const s of list) snapshotsById.set(s.id, s);
    const verified: Array<{ entityId: EntityId; ev: VerifiedEvidence }> = [];
    for (const raw of run.evidence) {
      const st = states.get(raw.entityRef as EntityId);
      const snap = snapshotsById.get(raw.snapshotRef);
      if (!st || !snap) continue; // T0: a citation outside the run; the extractor already maps refs, this is a backstop.
      let ev = this.d.verifier.verify(
        raw,
        snap,
        this.entityContext(st.entity, ctx.entities),
        this.d.classifier.classify(snap, st.entity.officialDomains),
        now,
      );
      if (this.d.judge) ev = (await this.d.judge.refine(ev, budget)).evidence;
      st.verified.push(ev);
      verified.push({ entityId: st.entity.id, ev });
    }
    this.d.evidence.insertMany(
      userId,
      turnId,
      verified.map((v) => v.ev),
      now,
    );
  }

  private entityContext(e: EntityRow, all: ResearchRequest['ctx']['entities']): EntityContext {
    const norm = (s: string) => s.trim();
    return {
      id: e.id,
      aliases: [...new Set([e.name, ...e.aliases].map(norm).filter((x) => x.length > 0))],
      plans: e.plans,
      officialDomains: e.officialDomains,
      ...(e.ownedDomains ? { ownedDomains: e.ownedDomains } : {}),
      otherEntityAliases: [
        ...new Set(
          all
            .filter((o) => o.id !== e.id)
            .flatMap((o) => [o.name, ...o.aliases])
            .map(norm)
            .filter((x) => x.length > 0),
        ),
      ],
    };
  }

  /** Re-verification of a baseline's stored evidence under the current rules (architecture §8 row 3). */
  private reverify(
    req: ResearchRequest,
    b: Baseline,
    entity: EntityRow,
    all: ResearchRequest['ctx']['entities'],
  ): Baseline {
    const snaps = new Map(
      this.d.snapshots
        .getMany(
          req.userId,
          b.evidence.map((e) => e.snapshotId),
        )
        .map((s) => [s.id, s]),
    );
    const ctx = this.entityContext(entity, all);
    const evidence = b.evidence.map((old): VerifiedEvidence => {
      const snap = snaps.get(old.snapshotId);
      if (!snap)
        return {
          ...old,
          verification: {
            status: 'fail',
            checks: [
              {
                check: 'quote_verbatim',
                outcome: 'fail',
                detail: 'the source snapshot is no longer available',
              },
            ],
          },
          beliefKey: null,
        };
      const raw: RawEvidence = {
        snapshotRef: old.snapshotId,
        entityRef: old.entityId,
        kind: old.kind,
        fields: old.fields,
        quote: old.quote,
        contextQuote: old.contextQuote,
        polarity: old.polarity,
        modality: old.modality,
        effectiveFromText: null,
        eventDateText: null,
        significance: old.significance,
        significanceReason: null,
      };
      const v = this.d.verifier.verify(raw, snap, ctx, old.authorityTier, req.now);
      return { ...old, verification: v.verification, beliefKey: v.beliefKey };
    });
    return { ...b, evidence };
  }

  private coverage(s: EntityState, evidenceByKey: Map<string, VerifiedEvidence[]>): Coverage {
    const snaps = [...s.snapshots.values()];
    const dated = snaps
      .map((x) => x.providerLastUpdatedAt ?? x.providerPublishedAt)
      .filter((x): x is Ms => x !== null);
    const tierAPass =
      s.verified.some((e) => e.verification.status === 'pass' && isTierA(e) && e.freshFetch) ||
      [...evidenceByKey.values()]
        .flat()
        .some(
          (e) => isTierA(e) && e.freshFetch && e.observedAt >= 0 && s.snapshots.has(e.snapshotId),
        );
    let failure: CoverageFailure | null = null;
    if (s.extractionFailure !== null) failure = s.extractionFailure;
    else if (s.searchFailure !== null && !tierAPass) failure = s.searchFailure;
    return {
      searchesOk: s.searchesOk,
      searchesFailed: s.searchesFailed,
      extractionFailed: s.extractionFailure !== null,
      sourcesChecked: snaps.length,
      newestDatedSource: dated.length > 0 ? Math.max(...dated) : null,
      freshOfficialFetched: snaps.some(
        (x) =>
          x.freshFetch &&
          x.crawlStatus === 'ok' &&
          s.verified.some((e) => e.snapshotId === x.id && isTierA(e)),
      ),
      failure,
    };
  }

  private releaseSince(req: ResearchRequest, baselines: readonly Baseline[]): Ms {
    if (baselines.length > 0) return Math.min(...baselines.map((b) => b.presentedAt));
    const since = req.ctx.temporal
      .filter((t) => t.mention.role === 'change_since')
      .flatMap((t) => t.candidates.map((c) => c.startMs));
    return since.length > 0 ? Math.min(...since) : req.now - DEFAULT_RELEASE_LOOKBACK_MS;
  }

  private emitAll(
    req: ResearchRequest,
    set: FindingSet,
    snapshots: Map<SnapshotId, SourceSnapshot>,
  ): void {
    for (const [id, src] of Object.entries(set.sources)) {
      const sid = id as SnapshotId;
      const snap = snapshots.get(sid);
      req.emit({
        event: 'source',
        data: {
          sourceId: sid,
          url: src.url,
          domain: src.domain,
          title: src.title,
          tier: src.tier,
          freshFetch: snap ? snap.freshFetch && snap.crawlStatus === 'ok' : false,
          observedAt: src.observedAt,
          providerPublishedAt: snap?.providerPublishedAt ?? null,
        },
      });
    }
    for (const f of set.findings satisfies Finding[]) req.emit({ event: 'finding', data: f });
  }
}
