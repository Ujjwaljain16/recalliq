import type { EntityId, SnapshotId } from './ids.js';
import type { TurnBudget } from './infrastructure.js';
import type { ResolvedContext } from './memory.js';
import type { SearchErrorCode, SearchRequest } from './search.js';
import type { EventSink } from './sse.js';
import type { Intent, TurnAnalysis } from './understanding.js';
import type { Ms } from './ids.js';

export interface QuerySpec {
  id: string;
  entityId: EntityId | null;
  intent: Intent | 'official_domain_discovery';
  round: 1 | 2;
  request: SearchRequest;
}

export interface ResearchPlan {
  specs: QuerySpec[];
  fallback: QuerySpec[];
  budget: { maxSearches: number; maxPerEntity: number; concurrency: number };
}

export interface SearchOutcome {
  spec: QuerySpec;
  status: 'ok' | 'empty' | 'failed' | 'cached';
  errorCode?: SearchErrorCode | 'deadline';
  snapshotIds: SnapshotId[];
}

export interface ResearchPlanner {
  plan(ctx: ResolvedContext, a: TurnAnalysis, now: Ms): ResearchPlan;
}

export interface ResearchExecutor {
  execute(
    plan: ResearchPlan,
    round: 1 | 2,
    budget: TurnBudget,
    emit: EventSink,
  ): Promise<SearchOutcome[]>;
}
