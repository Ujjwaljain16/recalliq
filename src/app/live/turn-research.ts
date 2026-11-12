import { RepairingVerifier } from '../../evidence/repair.js';
import { FindingAssembler } from '../../belief/assembler.js';
import { RuleChangeDetector } from '../../belief/detector.js';
import type { BeliefRepository } from '../../belief/repository.js';
import type { Db } from '../../db/index.js';
import { DomainAuthorityClassifier } from '../../evidence/authority.js';
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
import type { Clock } from '../../shared/infrastructure.js';
import type { LlmPort } from '../../shared/llm.js';
import type { ResearchService } from '../../shared/pipeline.js';
import type { ResearchPlan } from '../../shared/research.js';
import type { SearchPort } from '../../shared/search.js';
import { EntityDirectory, type EntityRow } from './entities.js';
import type { OfficialDomains } from './registry.js';

export interface TurnResearchDeps {
  db: Db;
  clock: Clock;
  search: SearchPort;
  llm: LlmPort;
  /** Stored on every snapshot and entity: 'live' for the real provider, 'synthetic' or 'recorded' for replay. */
  origin: Origin;
  beliefs: BeliefRepository;
  registry: OfficialDomains;
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
    // Official-domain status comes only from the owner's registry and the entity's own stored domains.
    this.d.registry.apply(req.ctx.entities);
    const snapshots = new SnapshotStore(this.d.db);
    const classifier = new DomainAuthorityClassifier();
    const entities = req.ctx.entities;
    const executor = new SearchResearchExecutor({
      db: this.d.db,
      port: this.d.search,
      clock: this.d.clock,
      userId: req.userId,
      turnId: req.turnId,
      origin: this.d.origin,
    });
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
      verifier: new RepairingVerifier(new RuleEvidenceVerifier()),
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
}
