import { FindingAssembler } from '../../belief/assembler.js';
import { RuleChangeDetector } from '../../belief/detector.js';
import type { BeliefRepository } from '../../belief/repository.js';
import type { Db } from '../../db/index.js';
import { DomainAuthorityClassifier, registrableDomain } from '../../evidence/authority.js';
import { AdaptiveBatcher } from '../../evidence/batcher.js';
import { EntailmentJudge } from '../../evidence/entailment.js';
import { ExtractionRunner, LlmEvidenceExtractor } from '../../evidence/extractor.js';
import { EvidenceRepository } from '../../evidence/repository.js';
import { RuleEvidenceVerifier } from '../../evidence/verifier.js';
import { normalizeEntityName } from '../../orchestration/planner.js';
import { SearchResearchExecutor } from '../../research/executor.js';
import { PipelineResearchService } from '../../research/service.js';
import { SnapshotStore } from '../../sources/snapshot-store.js';
import type { Origin } from '../../shared/ids.js';
import type { Clock, TurnBudget } from '../../shared/infrastructure.js';
import type { LlmPort } from '../../shared/llm.js';
import type { ResearchService } from '../../shared/pipeline.js';
import type { ResearchPlan, ResearchExecutor, SearchOutcome } from '../../shared/research.js';
import type { SearchPort } from '../../shared/search.js';
import type { EventSink } from '../../shared/sse.js';
import { EntityDirectory, nameMatchesDomain, type EntityRow } from './entities.js';

export interface TurnResearchDeps {
  db: Db;
  clock: Clock;
  search: SearchPort;
  llm: LlmPort;
  /** Stored on every snapshot and entity: 'live' for the real provider, 'synthetic' or 'recorded' for replay. */
  origin: Origin;
  beliefs: BeliefRepository;
}

/**
 * Learns an entity's official domain from the result of an official-site discovery search: a hit whose domain
 * name evidently is the entity's name (nameMatchesDomain). It runs between the search and the verification of
 * the same round, so the pages of that round are classified with the domain it found.
 */
class DomainLearningExecutor implements ResearchExecutor {
  constructor(
    private readonly inner: ResearchExecutor,
    private readonly learn: (outcomes: SearchOutcome[]) => void,
  ) {}

  async execute(
    plan: ResearchPlan,
    round: 1 | 2,
    budget: TurnBudget,
    emit: EventSink,
  ): Promise<SearchOutcome[]> {
    const outcomes = await this.inner.execute(plan, round, budget, emit);
    this.learn(outcomes);
    return outcomes;
  }
}

/**
 * The ResearchService the orchestrator calls: one per application, delegating to a PipelineResearchService built
 * for the turn, because the search executor is bound to a user and a turn. The planner ran before any entity of
 * a first question existed, so this class first gives each such entity a row, and rewrites the plan's specs
 * to name it. It appends the new rows to the request's own `ctx.entities`, so the answer and the stored context
 * see them. All search, extraction, verification, belief and finding logic is the real pipeline's.
 */
export class PerTurnResearchService implements ResearchService {
  private readonly directory: EntityDirectory;

  constructor(private readonly d: TurnResearchDeps) {
    this.directory = new EntityDirectory(d.db, d.clock, d.origin);
  }

  async run(req: Parameters<ResearchService['run']>[0]): ReturnType<ResearchService['run']> {
    const plan = this.materialize(req);
    const snapshots = new SnapshotStore(this.d.db);
    const classifier = new DomainAuthorityClassifier();
    const entities = req.ctx.entities;
    const executor = new DomainLearningExecutor(
      new SearchResearchExecutor({
        db: this.d.db,
        port: this.d.search,
        clock: this.d.clock,
        userId: req.userId,
        turnId: req.turnId,
        origin: this.d.origin,
      }),
      (outcomes) => this.learnDomains(req, snapshots, outcomes),
    );
    const extractor = new LlmEvidenceExtractor({
      llm: this.d.llm,
      snapshots: (ids) => snapshots.getMany(req.userId, [...ids]),
      entities: (ids) =>
        entities
          .filter((e) => ids.includes(e.id))
          .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases })),
      tierOf: (s, id) =>
        classifier.classify(s, entities.find((e) => e.id === id)?.officialDomains ?? []),
    });
    const service = new PipelineResearchService({
      db: this.d.db,
      executor,
      snapshots,
      batcher: new AdaptiveBatcher({
        tierOf: (s, id) =>
          classifier.classify(s, entities.find((e) => e.id === id)?.officialDomains ?? []),
      }),
      runner: new ExtractionRunner(extractor),
      verifier: new RuleEvidenceVerifier(),
      classifier,
      evidence: new EvidenceRepository(this.d.db),
      beliefs: this.d.beliefs,
      assembler: new FindingAssembler({ detector: new RuleChangeDetector() }),
      judge: new EntailmentJudge({ llm: this.d.llm }),
    });
    return service.run({ ...req, plan });
  }

  /** The planner names an entity it has no row for by `<normalised name>:<intent>:<suffix>:<round>`. */
  private materialize(req: Parameters<ResearchService['run']>[0]): ResearchPlan {
    const keyOf = (id: string): string => id.split(':').slice(0, -3).join(':');
    const specs = [...req.plan.specs, ...req.plan.fallback];
    const needed = new Set(specs.filter((s) => s.entityId === null).map((s) => keyOf(s.id)));
    if (needed.size === 0) return req.plan;
    const rows = new Map<string, EntityRow>();
    for (const mention of req.analysis.entities) {
      const key = normalizeEntityName(mention.text);
      if (!needed.has(key) || rows.has(key)) continue;
      const row = this.directory.ensure(req.userId, mention);
      rows.set(key, row);
      const existing = req.ctx.entities.find((e) => e.id === row.id);
      if (existing === undefined) req.ctx.entities.push(row);
    }
    const rewrite = (s: ResearchPlan['specs'][number]): ResearchPlan['specs'][number] => {
      const row = s.entityId === null ? rows.get(keyOf(s.id)) : undefined;
      return row === undefined ? s : { ...s, entityId: row.id };
    };
    return {
      ...req.plan,
      specs: req.plan.specs.map(rewrite),
      fallback: req.plan.fallback.map(rewrite),
    };
  }

  private learnDomains(
    req: Parameters<ResearchService['run']>[0],
    snapshots: SnapshotStore,
    outcomes: SearchOutcome[],
  ): void {
    for (const o of outcomes) {
      if (o.spec.intent !== 'official_domain_discovery' || o.spec.entityId === null) continue;
      const entity = req.ctx.entities.find((e) => e.id === o.spec.entityId);
      if (entity === undefined) continue;
      for (const snap of snapshots.getMany(req.userId, o.snapshotIds)) {
        if (nameMatchesDomain(entity.name, snap.domain)) {
          this.directory.addDomain(entity, registrableDomain(snap.domain), 'name_match');
        }
      }
    }
  }
}
