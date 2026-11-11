import { BeliefRepository } from '../../belief/repository.js';
import { DEFAULT_BELIEF_POLICY, RuleBeliefResolver } from '../../belief/resolver.js';
import { MessageRepository } from '../../db/index.js';
import { LlmTurnAnalyzer } from '../../llm/analysis/analyzer.js';
import { LlmAnswerPipeline } from '../../answer/pipeline.js';
import type { Origin } from '../../shared/ids.js';
import type { LlmPort } from '../../shared/llm.js';
import type { SearchPort } from '../../shared/search.js';
import type { ComponentEnv, ComponentKind, Components } from '../components.js';
import { SqliteMemoryRetriever } from '../memory-adapter.js';
import { LoaderBaselineSource, MessageWindowReader } from '../store-adapters.js';
import type { MissLog } from './replay-providers.js';
import { StrictAnswerPipeline, StrictTurnAnalyzer } from './strict.js';
import { PerTurnResearchService } from './turn-research.js';

export interface ProviderPorts {
  kind: Exclude<ComponentKind, 'scripted'>;
  llm: LlmPort;
  search: SearchPort;
  /** Origin written on snapshots and entities: 'live' for the real providers, otherwise the fixture's class. */
  origin: Origin;
  /** Replay only: makes a fixture miss stop the turn even where a module would turn it into a degraded reply. */
  missLog?: MissLog;
}

/**
 * The real application components over two provider ports. The live and the replay sets are both built here,
 * so they differ only in the ports (and the origin they stamp): analyzer, research, verification, beliefs,
 * baselines, memory and answer pipeline are the same code.
 */
export function buildRealComponents(env: ComponentEnv, ports: ProviderPorts): Components {
  const beliefs = new BeliefRepository({
    db: env.db,
    resolver: new RuleBeliefResolver(),
    policy: DEFAULT_BELIEF_POLICY,
    clock: env.clock,
  });
  const analyzer = new LlmTurnAnalyzer({ llm: ports.llm, logger: env.logger });
  const answer = new LlmAnswerPipeline({ llm: ports.llm, logger: env.logger });
  return {
    kind: ports.kind,
    analyzer: ports.missLog ? new StrictTurnAnalyzer(analyzer, ports.missLog) : analyzer,
    research: new PerTurnResearchService({
      db: env.db,
      clock: env.clock,
      search: ports.search,
      llm: ports.llm,
      origin: ports.origin,
      beliefs,
    }),
    answer: ports.missLog ? new StrictAnswerPipeline(answer, ports.missLog) : answer,
    baselines: new LoaderBaselineSource(env.db),
    window: new MessageWindowReader(new MessageRepository(env.db, env.clock)),
    memory: new SqliteMemoryRetriever(env.db),
  };
}
