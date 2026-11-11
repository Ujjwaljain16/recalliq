import type { SentenceIssue, SentenceKind, SentenceStatus } from '../shared/answer.js';
import type { DeliveryState } from '../shared/delivery.js';
import type { AuthorityTier } from '../shared/evidence.js';
import type { ConversationId, MessageId, Ms, SnapshotId, TurnId, UserId } from '../shared/ids.js';
import type { SseEvent } from '../shared/sse.js';
import type { TurnStatus } from '../shared/turn.js';
import type { Lane } from '../shared/understanding.js';

/** Read models the HTTP layer returns. Everything is derived from stored rows, never from the live stream. */

export interface ConversationSummary {
  id: ConversationId;
  title: string | null;
  /** The start of the first user message, for a list that has no stored title. */
  preview: string | null;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface SentenceView {
  index: number;
  text: string;
  status: SentenceStatus;
  issues: SentenceIssue[];
  /** What the sentence rests on (verified finding or quoted source); absent for neither and for older messages. */
  kind?: SentenceKind;
  /** Derived from the message's streamed and rendered extents (src/shared/delivery.ts). */
  delivery: DeliveryState;
}

export interface SourceView {
  /** Position in the turn's `source` events, 1-based: what an `[n]` marker in the answer text refers to. */
  n: number;
  sourceId: SnapshotId;
  url: string;
  domain: string;
  title: string | null;
  tier: AuthorityTier;
}

export interface MessageView {
  id: MessageId;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'interrupted';
  createdAt: Ms;
  turnId: TurnId | null;
  /** Assistant only: highest sentence index fully written to the stream (-1: none). */
  streamedThrough: number | null;
  /** Highest sentence index the browser acknowledged as rendered (-1: none). */
  renderedThrough: number;
  sentences: SentenceView[] | null;
  sources: SourceView[];
  /** Assistant only: the options of a clarifying question, to offer as choices. */
  clarification: { question: string; options: Array<{ label: string; ref: string }> } | null;
  /** The turn this message belongs to: its outcome, so a turn with no stored answer can be shown honestly. */
  turn: { status: TurnStatus; lane: Lane | null; errorCode: string | null } | null;
}

/** Everything the HTTP layer needs to read beyond the repositories' own methods. All methods are user-scoped. */
export interface ConversationView {
  list(userId: UserId, limit: number): ConversationSummary[];
  /** null when the conversation does not exist or belongs to someone else. */
  messages(userId: UserId, conversationId: ConversationId): MessageView[] | null;
  hasRunningTurn(userId: UserId, conversationId: ConversationId): boolean;
  /** The events of a finished turn, in order, ending with `turn.completed`. null when unknown. */
  replay(userId: UserId, turnId: TurnId): SseEvent[] | null;
}
