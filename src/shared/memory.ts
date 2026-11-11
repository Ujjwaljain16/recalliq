import type { PriceBeliefKey } from './belief.js';
import type { NormalizedValue, VerifiedEvidence } from './evidence.js';
import type {
  AssertionId,
  ConversationId,
  DecisionId,
  EntityId,
  MessageId,
  Ms,
  TurnId,
  UserId,
} from './ids.js';
import type { DayInterval, ResolvedTemporal } from './temporal.js';
import type { DecisionPayload, Lane } from './understanding.js';

export interface MemoryCandidate {
  conversationId: ConversationId;
  messageId: MessageId;
  turnId: TurnId | null;
  createdAt: Ms;
  localTime: string;
  /** ≤ 300 chars */
  excerpt: string;
  matchedTerms: string[];
  score: number;
  /** Which candidate interval it fell into. */
  intervalIndex: number;
}

export interface DecisionRecord {
  id: DecisionId;
  payload: DecisionPayload;
  entityIds: EntityId[];
  createdAt: Ms;
  messageId: MessageId;
  version: number;
}

/** From PRESENTED assertions only. */
export interface Baseline {
  assertionId: AssertionId;
  beliefKey: string;
  key: PriceBeliefKey;
  entityId: EntityId;
  /** T0 = presentedAt. */
  value: NormalizedValue;
  presentedAt: Ms;
  /** As stored. */
  evidence: VerifiedEvidence[];
  evidenceStatusAtT0: 'pass_current' | 'pass_stale' | 'weak' | 'missing';
}

export interface ResolvedContext {
  lane: Lane;
  temporal: ResolvedTemporal[];
  memoryHits: MemoryCandidate[];
  decisions: DecisionRecord[];
  entities: Array<{
    id: EntityId;
    name: string;
    aliases: string[];
    plans: string[];
    officialDomains: string[];
    /** Explicit owner-registry domains only; see EntityContext.ownedDomains. */
    ownedDomains?: string[];
  }>;
  baselines: Baseline[];
  reuseFindingSetFromTurn?: TurnId;
  clarification?: { question: string; options: Array<{ label: string; ref: string }> };
}

export interface MemoryRetriever {
  messagesInIntervals(u: UserId, iv: DayInterval[], terms: string[]): MemoryCandidate[];
  searchAll(u: UserId, terms: string[], limit: number): MemoryCandidate[];
  decisions(
    u: UserId,
    kind: DecisionPayload['kind'] | null,
    iv: DayInterval[] | null,
  ): DecisionRecord[];
  entitiesByAlias(u: UserId, normalized: string[]): ResolvedContext['entities'];
}

export interface BaselineLoader {
  load(u: UserId, turnIds: TurnId[], entityIds: EntityId[]): Baseline[];
}
