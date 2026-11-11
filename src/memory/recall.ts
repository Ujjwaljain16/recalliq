import type { IanaTz, Ms, UserId } from '../shared/ids.js';
import type { MemoryCandidate, MemoryRetriever } from '../shared/memory.js';
import type { ResolvedTemporal, TemporalResolver } from '../shared/temporal.js';
import type { TemporalMention } from '../shared/understanding.js';

/**
 * The recall / clarify decision (architecture §7, "what counts as plausible"). Pure orchestration over
 * an injected resolver and retriever, so it is deterministic and makes no model call.
 *
 *  - exactly one plausible answer -> `answer`, and the resolved date is stated;
 *  - several (two candidate days both matching, or several conversations) -> `clarify`, never an
 *    arbitrary pick;
 *  - nothing stored -> `none`, which is an honest "no record", never a guess;
 *  - a date that could not be worked out -> `clarify` asking for the date.
 *
 * Without topic terms every user message in the interval is listed and no disambiguation is needed,
 * except between two candidate days.
 */

export interface RecallDeps {
  resolver: TemporalResolver;
  memory: Pick<MemoryRetriever, 'messagesInIntervals'>;
}

export interface RecallRequest {
  userId: UserId;
  mentions: TemporalMention[];
  topicTerms: string[];
  tz: IanaTz;
  now: Ms;
}

export interface ClarifyOption {
  label: string;
  /** `day:<localDate>` or `conv:<conversationId>`: what the user's choice resolves to. */
  ref: string;
}

export type RecallOutcome =
  | {
      kind: 'answer';
      localDate: string;
      conversationIds: string[];
      hits: MemoryCandidate[];
      /** True when the retriever returned its maximum, so more messages may exist. */
      truncated: boolean;
    }
  | {
      kind: 'clarify';
      reason: 'ambiguous_day' | 'ambiguous_conversation' | 'unresolved_date' | 'no_date';
      question: string;
      options: ClarifyOption[];
    }
  | { kind: 'none'; localDates: string[]; searchedTerms: string[] };

const MAX_HITS = 8;

function firstReference(resolved: ResolvedTemporal[]): ResolvedTemporal | undefined {
  return resolved.find((r) => r.mention.role === 'reference_conversation');
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function resolveRecall(deps: RecallDeps, req: RecallRequest): RecallOutcome {
  const resolved = deps.resolver.resolve(req.mentions, req.tz, req.now);
  const target = firstReference(resolved);
  if (!target) {
    return {
      kind: 'clarify',
      reason: 'no_date',
      question: 'Which day do you mean?',
      options: [],
    };
  }
  if (target.status === 'unresolved' || target.candidates.length === 0) {
    return {
      kind: 'clarify',
      reason: 'unresolved_date',
      question: `I couldn't work out which day "${target.mention.text}" refers to. Which date do you mean?`,
      options: [],
    };
  }

  const hits = deps.memory.messagesInIntervals(req.userId, target.candidates, req.topicTerms);
  const localDates = target.candidates.map((c) => c.localDate);
  if (hits.length === 0) {
    return { kind: 'none', localDates, searchedTerms: req.topicTerms };
  }

  // Which of the candidate days actually have a match? Stored data decides between candidate days.
  const intervalsWithHits = distinct(hits.map((h) => h.intervalIndex)).sort((a, b) => a - b);
  if (intervalsWithHits.length > 1) {
    return {
      kind: 'clarify',
      reason: 'ambiguous_day',
      question: 'I found matches on more than one day. Which one do you mean?',
      options: intervalsWithHits.map((i) => ({
        label: target.candidates[i]?.localDate ?? `day ${i}`,
        ref: `day:${target.candidates[i]?.localDate ?? i}`,
      })),
    };
  }
  const only = intervalsWithHits[0] ?? 0;
  const localDate = target.candidates[only]?.localDate ?? localDates[0] ?? '';

  // With topic terms, more than one matching conversation on that day is a question, not a guess.
  const conversations = distinct(hits.map((h) => h.conversationId));
  if (req.topicTerms.length > 0 && conversations.length > 1) {
    return {
      kind: 'clarify',
      reason: 'ambiguous_conversation',
      question: `More than one conversation on ${localDate} matches. Which one do you mean?`,
      options: conversations.map((id) => {
        const first = hits.find((h) => h.conversationId === id);
        return {
          label: `${first?.localTime ?? localDate}: ${first?.excerpt ?? ''}`,
          ref: `conv:${id}`,
        };
      }),
    };
  }

  return {
    kind: 'answer',
    localDate,
    conversationIds: conversations,
    hits,
    truncated: hits.length >= MAX_HITS,
  };
}
