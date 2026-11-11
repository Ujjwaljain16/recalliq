import type { IanaTz, Ms } from '../../shared/ids.js';
import type { DecisionRecord, MemoryCandidate, ResolvedContext } from '../../shared/memory.js';
import type { DayInterval, ResolvedTemporal } from '../../shared/temporal.js';
import type { EntityMention, Lane } from '../../shared/understanding.js';
import { TURN_LIMITS } from '../config.js';
import type { ClarifyReason, LaneDeps, LaneInput, LaneOutcome } from './types.js';

export function emptyContext(lane: Lane): ResolvedContext {
  return { lane, temporal: [], memoryHits: [], decisions: [], entities: [], baselines: [] };
}

/** "2026-11-03 14:05" in the user's zone; UTC when the zone is unusable. Never throws. */
export function localTimeOf(at: Ms, tz: IanaTz): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  let parts: Record<string, string>;
  try {
    parts = format(tz);
  } catch {
    parts = format('UTC');
  }
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTemporal(input: LaneInput, deps: LaneDeps): ResolvedTemporal[] {
  if (input.analysis.temporal.length === 0) return [];
  return deps.resolver.resolve(input.analysis.temporal, input.tz, input.now);
}

export function emitContext(input: LaneInput, ctx: ResolvedContext): void {
  input.emit({
    event: 'context',
    data: {
      lane: ctx.lane,
      resolvedDates: ctx.temporal.map((t) => ({
        text: t.mention.text,
        localDates: t.candidates.map((c) => c.localDate),
      })),
      memoryHits: ctx.memoryHits.map((h) => ({
        messageId: h.messageId,
        localTime: h.localTime,
        excerpt: h.excerpt,
      })),
      decisionIds: ctx.decisions.map((d) => d.id),
    },
  });
}

export function clarifyOutcome(
  input: LaneInput,
  ctx: ResolvedContext,
  reason: ClarifyReason,
  question: string,
  options: Array<{ label: string; ref: string }>,
): LaneOutcome {
  const clarification = { question, options };
  input.emit({ event: 'clarification', data: clarification });
  return {
    kind: 'clarify',
    lane: 'clarify',
    ctx: { ...ctx, lane: 'clarify', clarification },
    reason,
    question,
    options,
  };
}

export interface EntityResolution {
  entities: ResolvedContext['entities'];
  /** A mention that matched more than one stored entity: the user must choose, we never pick. */
  ambiguous: { mention: EntityMention; options: ResolvedContext['entities'] } | null;
  /** More entities were mentioned than a turn handles. */
  capped: boolean;
}

/** Looks the analysis' entity mentions up in memory. One read; none when there is nothing to look up. */
export function resolveEntities(
  input: LaneInput,
  deps: LaneDeps,
  mentions: EntityMention[],
): EntityResolution {
  if (mentions.length === 0) return { entities: [], ambiguous: null, capped: false };
  const wanted = mentions.map((m) => m.normalized);
  const found = deps.memory.entitiesByAlias(input.userId, wanted);
  const matches = (e: ResolvedContext['entities'][number], normalized: string): boolean =>
    deps.normalize(e.name) === normalized ||
    e.aliases.some((a) => deps.normalize(a) === normalized);

  for (const mention of mentions) {
    const hits = found.filter((e) => matches(e, mention.normalized));
    if (new Set(hits.map((e) => e.id)).size > 1)
      return { entities: [], ambiguous: { mention, options: hits }, capped: false };
  }
  const unique = [...new Map(found.map((e) => [e.id, e])).values()];
  return {
    entities: unique.slice(0, TURN_LIMITS.maxEntities),
    ambiguous: null,
    capped: unique.length > TURN_LIMITS.maxEntities || mentions.length > TURN_LIMITS.maxEntities,
  };
}

export function ambiguousEntityOutcome(
  input: LaneInput,
  ctx: ResolvedContext,
  resolution: EntityResolution,
): LaneOutcome | null {
  if (!resolution.ambiguous) return null;
  const { mention, options } = resolution.ambiguous;
  return clarifyOutcome(
    input,
    ctx,
    'ambiguous_entity',
    `More than one of your saved companies matches "${mention.text}". Which one do you mean?`,
    options.map((e) => ({ label: e.name, ref: `entity:${e.id}` })),
  );
}

export function candidateAsHit(
  base: Pick<MemoryCandidate, 'conversationId' | 'messageId' | 'turnId' | 'createdAt'>,
  localTime: string,
  excerpt: string,
): MemoryCandidate {
  return {
    ...base,
    localTime,
    excerpt: excerpt.slice(0, 300),
    matchedTerms: [],
    score: 0,
    intervalIndex: 0,
  };
}

export function emitEntityCap(input: LaneInput): void {
  input.emit({
    event: 'warning',
    data: {
      code: 'entity_cap',
      text: `I can check up to ${TURN_LIMITS.maxEntities} companies at a time, so I will cover the first ${TURN_LIMITS.maxEntities}.`,
    },
  });
}

/** How many stored earlier messages the opening sentences quote at most. */
const MAX_QUOTED_MESSAGES = 3;

/**
 * Opening sentences written in code: what the user asked on the day they pointed at, with its local time, quoting the
 * stored text as stored (the retriever's excerpt, whitespace collapsed and ending in an ellipsis when it was cut).
 * No model is involved, so nothing here can describe a conversation that was not found.
 */
export function askedSentences(hits: MemoryCandidate[]): string[] {
  const sorted = [...hits].sort((a, b) => a.createdAt - b.createdAt);
  const shown = sorted.slice(0, MAX_QUOTED_MESSAGES);
  const out = shown.map((h, i) => {
    const [day, time] = h.localTime.split(' ');
    const when = time === undefined ? h.localTime : `${day} at ${time}`;
    const verb = h.excerpt.includes('?') ? 'asked' : 'wrote';
    return `${i === 0 ? 'On' : 'Also on'} ${when} you ${verb}: "${h.excerpt}"`;
  });
  if (sorted.length > shown.length) {
    out.push(`There were ${sorted.length - shown.length} more messages from you that day.`);
  }
  return out;
}

export const NO_EARLIER_ANSWER_TO_COMPARE =
  'I have no earlier answer of my own on record to compare against, so I cannot establish whether anything changed since then.';
export const NO_VERIFIED_EARLIER_ANSWER =
  'My earlier answer on this was never verified, so I cannot use it as a baseline and cannot establish whether anything changed since then.';

export type ShortlistResolution =
  | { kind: 'none' }
  | { kind: 'clarify'; outcome: LaneOutcome }
  | {
      kind: 'found';
      decisions: DecisionRecord[];
      /** Stored entities, in shortlist order, at most the per-turn cap. */
      entities: ResolvedContext['entities'];
      /** Names on the shortlist with no stored entity yet: researched by name, like any named company. */
      unresolved: EntityMention[];
      capped: boolean;
    };

/**
 * The shortlist stored on a day the user pointed at ("On Monday we shortlisted 5 CRM tools"). Exactly one stored
 * shortlist decision on those days gives the entities to research; none leaves the turn as it was; several is a
 * clarifying question, never a pick.
 */
export function resolveShortlist(
  input: LaneInput,
  deps: LaneDeps,
  base: ResolvedContext,
  intervals: DayInterval[],
): ShortlistResolution {
  if (intervals.length === 0) return { kind: 'none' };
  const decisions = deps.memory.decisions(input.userId, 'shortlist', intervals);
  if (decisions.length === 0) return { kind: 'none' };
  const dates = [...new Set(intervals.map((i) => i.localDate))].join(' or ');
  if (decisions.length > 1) {
    emitContext(input, { ...base, decisions });
    return {
      kind: 'clarify',
      outcome: clarifyOutcome(
        input,
        { ...base, decisions },
        'ambiguous_shortlist',
        `I found more than one saved shortlist on ${dates}. Which one do you mean?`,
        decisions.map((d) => ({
          label: d.payload.label ?? (d.payload.entities ?? []).join(', '),
          ref: `decision:${d.id}`,
        })),
      ),
    };
  }
  const only = decisions[0];
  if (only === undefined) return { kind: 'none' };

  const seen = new Set<string>();
  const mentions: EntityMention[] = [];
  for (const text of only.payload.entities ?? []) {
    const normalized = deps.normalize(text);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    mentions.push({ text, normalized });
  }
  if (mentions.length === 0) return { kind: 'none' };

  const all = deps.memory.entitiesByAlias(
    input.userId,
    mentions.map((m) => m.normalized),
  );
  const matches = (e: ResolvedContext['entities'][number], normalized: string): boolean =>
    deps.normalize(e.name) === normalized ||
    e.aliases.some((a) => deps.normalize(a) === normalized);
  for (const mention of mentions) {
    const hits = all.filter((e) => matches(e, mention.normalized));
    if (new Set(hits.map((e) => e.id)).size > 1) {
      const ctx = { ...base, decisions };
      emitContext(input, ctx);
      const outcome = ambiguousEntityOutcome(input, ctx, {
        entities: [],
        ambiguous: { mention, options: hits },
        capped: false,
      });
      if (outcome) return { kind: 'clarify', outcome };
    }
  }
  const ordered = mentions.map((m) => ({ m, e: all.find((e) => matches(e, m.normalized)) }));
  const kept = ordered.slice(0, TURN_LIMITS.maxEntities);
  const entities = [
    ...new Map(kept.flatMap((k) => (k.e ? [[k.e.id, k.e] as const] : []))).values(),
  ];
  return {
    kind: 'found',
    decisions,
    entities,
    unresolved: kept.filter((k) => k.e === undefined).map((k) => k.m),
    capped: ordered.length > TURN_LIMITS.maxEntities,
  };
}
