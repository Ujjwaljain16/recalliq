import type { IanaTz, Ms } from '../../shared/ids.js';
import type { MemoryCandidate, ResolvedContext } from '../../shared/memory.js';
import type { ResolvedTemporal } from '../../shared/temporal.js';
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
