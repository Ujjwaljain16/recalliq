import type { AppConfig } from '../config/env.js';
import type { Db } from '../db/index.js';
import type { BaselineSource, ConversationWindowReader } from '../orchestration/ports.js';
import type { AnswerPipeline } from '../shared/answer.js';
import type { Clock, Logger } from '../shared/infrastructure.js';
import type { MemoryRetriever } from '../shared/memory.js';
import type { ResearchService, TurnAnalyzer } from '../shared/pipeline.js';

/** Which set of components is running. The web client shows a banner for `scripted`. */
export type ComponentKind = 'scripted' | 'live';

/** What the turn orchestrator is composed from, apart from the turn repository and the clock. */
export interface Components {
  kind: ComponentKind;
  analyzer: TurnAnalyzer;
  research: ResearchService;
  answer: AnswerPipeline;
  baselines: BaselineSource;
  window: ConversationWindowReader;
  memory: MemoryRetriever;
}

/** What a component set may need to build itself. */
export interface ComponentEnv {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: AppConfig;
}

export type ComponentFactory = (env: ComponentEnv) => Components;

/** Shown in the interface whenever the scripted set is active. */
export const SCRIPTED_BANNER = 'Scripted demo responses, no real search or model';
