import { isGenericCategory } from '../../llm/analysis/generic-categories.js';
import { resolveRecall } from '../../memory/recall.js';
import type { ConversationId } from '../../shared/ids.js';
import type { MemoryCandidate, ResolvedContext } from '../../shared/memory.js';
import type { EntityMention } from '../../shared/understanding.js';
import { TURN_LIMITS } from '../config.js';
import { clarifyOutcome, emitContext } from './common.js';
import type { LaneDeps, LaneInput, LaneOutcome } from './types.js';

/**
 * The earlier conversation a turn points at ("on Monday we shortlisted ...", "last Tuesday I asked ..."): the
 * same decision for the audit and the research lane. Only a `reference_conversation` mention triggers it; the
 * decision itself is the pure `resolveRecall` over the resolver and the message retriever.
 */
export type DayRecall =
  | { kind: 'not_referenced' }
  | { kind: 'clarify'; outcome: LaneOutcome }
  | { kind: 'none'; localDates: string[] }
  | { kind: 'found'; hits: MemoryCandidate[]; conversationIds: ConversationId[] };

const LABEL_CHARS = 80;

/** "2026-11-10 10:00: first 80 characters", the label of an option that quotes a candidate conversation. */
function optionLabel(hit: MemoryCandidate): string {
  return `${hit.localTime}: ${hit.excerpt.slice(0, LABEL_CHARS)}`;
}

/**
 * The user message that started this turn is stored before the lane runs, so a day that includes now (earlier
 * today) would find it: a message of the current conversation at or after the turn's start is not an earlier one.
 * Hits that match fewer topic terms than the best hit are dropped, so retrieval is not the whole day.
 */
function withoutThisTurn(
  input: LaneInput,
  deps: LaneDeps,
): Pick<LaneDeps['memory'], 'messagesInIntervals'> {
  return {
    messagesInIntervals: (u, iv, terms) => {
      const own = (h: MemoryCandidate): boolean =>
        h.conversationId === input.conversationId && h.createdAt >= input.now;
      const found = deps.memory.messagesInIntervals(u, iv, terms).filter((h) => !own(h));
      // Topic terms are OR-ed by the retriever. A message that matches fewer of them than the best match is a
      // weaker, probably unrelated hit (a Postgres question on the other candidate day): it is left out.
      const best = Math.max(0, ...found.map((h) => h.matchedTerms.length));
      return best > 0 ? found.filter((h) => h.matchedTerms.length === best) : found;
    },
  };
}

export function recallDay(input: LaneInput, deps: LaneDeps, base: ResolvedContext): DayRecall {
  if (!input.analysis.temporal.some((t) => t.role === 'reference_conversation')) {
    return { kind: 'not_referenced' };
  }
  const found = resolveRecall(
    { resolver: deps.resolver, memory: withoutThisTurn(input, deps) },
    {
      userId: input.userId,
      mentions: input.analysis.temporal,
      topicTerms: input.analysis.topicTerms,
      tz: input.tz,
      now: input.now,
    },
  );
  if (found.kind === 'clarify') {
    emitContext(input, base);
    // Candidate conversations are quoted briefly so the user can tell them apart.
    const options = found.options.map((o) => {
      if (!o.ref.startsWith('conv:')) return o;
      const label = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}): (.*)$/s.exec(o.label);
      return label ? { ...o, label: `${label[1]}: ${(label[2] ?? '').slice(0, LABEL_CHARS)}` } : o;
    });
    return {
      kind: 'clarify',
      outcome: clarifyOutcome(input, base, found.reason, found.question, options),
    };
  }
  if (found.kind === 'none') return { kind: 'none', localDates: found.localDates };
  return {
    kind: 'found',
    hits: found.hits,
    conversationIds: found.conversationIds as ConversationId[],
  };
}

/** Several conversations on the day and nothing else to decide between them: a question with one option each. */
export function severalConversations(
  input: LaneInput,
  base: ResolvedContext,
  hits: MemoryCandidate[],
): LaneOutcome | null {
  const ids = [...new Set(hits.map((h) => h.conversationId))];
  if (ids.length <= 1) return null;
  const first = ids.flatMap((id) => {
    const hit = hits.find((h) => h.conversationId === id);
    return hit ? [hit] : [];
  });
  emitContext(input, { ...base, memoryHits: hits });
  return clarifyOutcome(
    input,
    { ...base, memoryHits: hits },
    'ambiguous_conversation',
    "I found more than one conversation that day, so I can't tell which one you mean. Which one is it? I'll answer from the one you pick.",
    first.map((h) => ({ label: optionLabel(h), ref: `conv:${h.conversationId}` })),
  );
}

export interface Derived {
  /** Stored entities, in the order the earlier message gives them. */
  entities: ResolvedContext['entities'];
  /** Names the earlier message tags as companies that have no stored entity yet. */
  unresolved: EntityMention[];
  capped: boolean;
}

const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}.+#&'-]*[\p{L}\p{N}+#])?/gu;
const MAX_NGRAM = 3;
const LOOKUP_CHUNK = 16;
const MAX_LOOKUPS = 160;

/**
 * Companies taken from a recalled message, conservatively and without a model:
 *  - the entities the user already has whose normalised name or alias equals a word, or a run of up to three
 *    words, of the message text (exact match only);
 *  - the message's stored tags (normalised entity names written at enrichment) that are not a generic category
 *    and that the message text really writes with a capital letter, so a topic word such as "pricing" is not
 *    taken for a company.
 * Nothing the message does not contain is ever returned.
 */
export function deriveFromRecall(
  input: LaneInput,
  deps: LaneDeps,
  hits: MemoryCandidate[],
): Derived {
  interface Candidate {
    norm: string;
    /** The tag's own spelling in the text, when it is a tag written with a capital letter. */
    display: string | null;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate): void => {
    if (c.norm.length < 2 || /^\d+$/.test(c.norm) || isGenericCategory(c.norm)) return;
    if (seen.has(c.norm)) return;
    seen.add(c.norm);
    candidates.push(c);
  };

  for (const hit of hits) {
    const words = hit.excerpt.match(WORD) ?? [];
    for (const tag of hit.tags ?? []) {
      const norm = deps.normalize(tag);
      const written = words.find((w) => deps.normalize(w) === norm && /^\p{Lu}/u.test(w));
      add({ norm, display: written ?? null });
    }
    for (let n = 1; n <= MAX_NGRAM; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        add({ norm: deps.normalize(words.slice(i, i + n).join(' ')), display: null });
      }
    }
  }

  const stored: ResolvedContext['entities'] = [];
  const wanted = candidates.map((c) => c.norm).slice(0, MAX_LOOKUPS);
  for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
    stored.push(...deps.memory.entitiesByAlias(input.userId, wanted.slice(i, i + LOOKUP_CHUNK)));
  }
  const matches = (e: ResolvedContext['entities'][number], norm: string): boolean =>
    deps.normalize(e.name) === norm || e.aliases.some((a) => deps.normalize(a) === norm);

  type Item = { entity: ResolvedContext['entities'][number] } | { mention: EntityMention };
  const items: Item[] = [];
  const takenIds = new Set<string>();
  const coveredWords = new Set<string>();
  for (const c of candidates) {
    const entity = stored.find((e) => matches(e, c.norm));
    if (entity === undefined || takenIds.has(entity.id)) continue;
    takenIds.add(entity.id);
    items.push({ entity });
    for (const w of deps.normalize(entity.name).split(' ')) coveredWords.add(w);
  }
  for (const c of candidates) {
    if (c.display === null || coveredWords.has(c.norm)) continue;
    if (stored.some((e) => matches(e, c.norm))) continue;
    items.push({ mention: { text: c.display, normalized: c.norm } });
  }

  const kept = items.slice(0, TURN_LIMITS.maxEntities);
  return {
    entities: kept.flatMap((i) => ('entity' in i ? [i.entity] : [])),
    unresolved: kept.flatMap((i) => ('mention' in i ? [i.mention] : [])),
    capped: items.length > TURN_LIMITS.maxEntities,
  };
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}
