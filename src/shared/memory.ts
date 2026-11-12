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
  /** ≤ 300 chars, or ≤ 600 for a topical recall hit */
  excerpt: string;
  matchedTerms: string[];
  score: number;
  /** Which candidate interval it fell into. */
  intervalIndex: number;
  /** The message's stored tags: normalised topic terms and entity names, written at enrichment. Absent in test doubles. */
  tags?: string[];
  /** Whose words the excerpt is. Set by topical recall; absent means a user message. */
  role?: 'user' | 'assistant';
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

/** What the user has said in one conversation so far, for a recall that names no day ("what have we talked about?"). */
export interface ConversationOverview {
  /** The most recent user messages of the conversation, oldest first, at most the limit asked for. */
  hits: MemoryCandidate[];
  /** How many user messages of the conversation matched, including those beyond the limit. */
  total: number;
  /** How many other conversations of the user hold at least one user message. */
  otherConversations: number;
}

/** Which stored messages a topical recall may return. */
export type TopicalRoles = 'user' | 'assistant' | 'both';

export interface TopicalRecallOptions {
  /** The turn being answered: its own user message is never returned. */
  excludeTurn: TurnId;
  /** At most this many hits (best matches first, then presented oldest first). */
  limit: number;
  /** The zone the local times are given in. */
  tz: string;
  roles: TopicalRoles;
}

export interface MemoryRetriever {
  messagesInIntervals(u: UserId, iv: DayInterval[], terms: string[]): MemoryCandidate[];
  /**
   * The user messages of one conversation written at or before `before`, leaving out the message of the turn
   * `excludeTurn` (the question being answered). Local times are given in `tz`.
   */
  conversationOverview(
    u: UserId,
    conversationId: ConversationId,
    excludeTurn: TurnId,
    before: Ms,
    limit: number,
    tz: string,
  ): ConversationOverview;
  searchAll(u: UserId, terms: string[], limit: number): MemoryCandidate[];
  /**
   * Messages of ALL the user's conversations whose indexed text matches the terms (full-text, bm25 best first,
   * capped), returned oldest first. An assistant message is returned only as the sentences the user was shown.
   */
  topicalRecall(u: UserId, terms: string[], opts: TopicalRecallOptions): MemoryCandidate[];
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
