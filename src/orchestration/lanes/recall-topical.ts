import { sanitizeTerms } from '../../db/repositories/memory-retriever.js';
import type { MemoryCandidate } from '../../shared/memory.js';
import type { TurnAnalysis } from '../../shared/understanding.js';
import { emitContext, emptyContext, resolveTemporal } from './common.js';
import type { LaneDeps, LaneInput, LaneOutcome, RecallTexts } from './types.js';

/** How many earlier messages a topical recall hands to the answer. */
export const MAX_TOPICAL_RECALL = 8;
const MAX_SHOWN_TERMS = 5;
const MAX_SHOWN_TERM_CHARS = 40;

/** Words that carry no topic: searching for them would match nearly every message. */
const FILLER = new Set(
  (
    'a an and are as at be but by can did do does for from had has have how i if in is it its me my of on or ' +
    'our so that the their them there these they this to was we were what when where which who why will with ' +
    'you your about again also any earlier previous conversation conversations remind mentioned told said ' +
    'talked discussed chat last time'
  ).split(' '),
);

/** The words an earlier message must be searched for: topic terms and entity names, else the web queries. */
export function topicalTerms(analysis: TurnAnalysis): string[] {
  const named = [...analysis.topicTerms, ...analysis.entities.map((e) => e.normalized)];
  const pool = named.length > 0 ? named : analysis.queries;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of pool) {
    const words = sanitizeTerms([term]).filter((w) => w.length > 1 && !FILLER.has(w));
    if (words.length === 0) continue;
    const phrase = words.join(' ');
    if (!seen.has(phrase)) {
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What the user is told was searched for: the terms in plain letters and digits, never raw model text. */
function shownTerms(terms: string[]): string {
  return terms
    .slice(0, MAX_SHOWN_TERMS)
    .map((t) => t.slice(0, MAX_SHOWN_TERM_CHARS))
    .join(', ');
}

/** Assistant messages are quoted as what was said, so the answer cannot mistake them for the user's own words. */
function quoted(hit: MemoryCandidate): { text: string; localTime: string } {
  return {
    text: hit.role === 'assistant' ? `My earlier answer: ${hit.excerpt}` : hit.excerpt,
    localTime: hit.localTime,
  };
}

/**
 * A recall that names no day but a subject ("remind me what you said about X", "how many Italian restaurants have I
 * tried?"): the user's stored messages of every conversation (and the assistant sentences that were shown) that
 * match the subject, best matches first, shown oldest first. The opening sentence is written in code. Nothing
 * found is a fixed reply that invents nothing. The turn's own message is never returned.
 */
export function topicalRecall(input: LaneInput, deps: LaneDeps, terms: string[]): LaneOutcome {
  const base = { ...emptyContext('recall'), temporal: resolveTemporal(input, deps) };
  const hits = deps.memory.topicalRecall(input.userId, terms, {
    excludeTurn: input.turnId,
    limit: MAX_TOPICAL_RECALL,
    tz: input.tz,
    roles: 'both',
  });
  const about = shownTerms(terms);
  if (hits.length === 0) {
    emitContext(input, base);
    return {
      kind: 'reply',
      lane: 'recall',
      ctx: base,
      reason: 'no_record',
      sentences: [
        `I couldn't find anything about ${about} in your earlier conversations.`,
        'Tell me when it came up, or what else you remember about it, and I will look again.',
      ],
    };
  }
  const ctx = { ...base, memoryHits: hits };
  emitContext(input, ctx);
  const recall: RecallTexts = new Map(hits.map((h) => [h.messageId, quoted(h)]));
  return {
    kind: 'synthesize',
    lane: 'recall',
    ctx,
    findings: null,
    recall,
    lead: [`I found ${plural(hits.length, 'earlier message', 'earlier messages')} about ${about}:`],
  };
}
