import type { IanaTz, Ms } from '../../shared/ids.js';
import type { FindingSet } from '../../shared/findings.js';
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
    `More than one of your saved companies matches "${mention.text}", so I don't want to guess. Which one do you mean? I'll check the one you pick.`,
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
        `I found more than one saved shortlist on ${dates}, so I can't tell which one you mean. Which one is it? I'll check the companies on it.`,
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

const CHANGE_PROVEN = new Set(['changed', 'unchanged_confirmed']);

/** The local date the "since" question starts from: the day of the recalled message, else the since anchor. */
function sinceDate(
  input: LaneInput,
  temporal: ResolvedTemporal[],
  hits: MemoryCandidate[],
): string | null {
  const recalled = [...hits].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (recalled !== undefined) return recalled.localTime.split(' ')[0] ?? null;
  const since = temporal.find((t) => t.mention.role === 'change_since');
  const past = (since?.candidates ?? []).filter((c) => c.startMs <= input.now);
  const latest = past.sort((a, b) => b.startMs - a.startMs)[0];
  return latest?.localDate ?? null;
}

/**
 * Written in code, never by a model. When the user asks what changed since a day, a price seen now says nothing
 * about a change unless the system has an earlier price of its own to compare with. For the companies with
 * neither a baseline nor a change verdict (changed or unchanged_confirmed) this says so, with the date, before
 * the findings. Companies that have a verdict are not named. Null when the user asked no such question, nothing
 * about prices was researched, or every company has a verdict.
 */
export function changeNotEstablishedSentence(
  input: LaneInput,
  ctx: ResolvedContext,
  findings: FindingSet | null,
  hits: MemoryCandidate[],
): string | null {
  if (!input.analysis.temporal.some((t) => t.role === 'change_since')) return null;
  const all = findings?.findings ?? [];
  const asksPrices =
    input.analysis.intents.includes('pricing') || all.some((f) => f.intent === 'pricing');
  if (!asksPrices) return null;

  const universe = new Map<string, string>();
  for (const f of all) universe.set(String(f.entityId), f.entityName);
  if (universe.size === 0) for (const e of ctx.entities) universe.set(String(e.id), e.name);
  if (universe.size === 0) return null;

  const covered = new Set<string>(ctx.baselines.map((b) => String(b.entityId)));
  for (const f of all) {
    if ((f.verdict !== null && CHANGE_PROVEN.has(f.verdict)) || f.baseline !== undefined) {
      covered.add(String(f.entityId));
    }
  }
  const uncovered = [...universe].filter(([id]) => !covered.has(id)).map(([, name]) => name);
  if (uncovered.length === 0) return null;

  const date = sinceDate(input, ctx.temporal, hits);
  const from = date === null ? 'that day' : date;
  const names =
    uncovered.length === universe.size
      ? ''
      : ` for ${
          uncovered.length === 1
            ? (uncovered[0] ?? '')
            : `${uncovered.slice(0, -1).join(', ')} and ${uncovered[uncovered.length - 1] ?? ''}`
        }`;
  return `I have no earlier prices of my own on record from before ${from}${names}, so I cannot establish whether anything changed since then; what follows is what I could find now.`;
}

/**
 * "Monday 9 November" for a "YYYY-MM-DD" local date, with the year when it is not the user's current year. Pure
 * calendar arithmetic on the date itself, so a daylight-saving change cannot move it to another day.
 */
export function peopleDate(localDate: string, now: Ms, tz: IanaTz): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) return localDate;
  const [, y = '', mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).formatToParts(date);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const text = `${part('weekday')} ${part('day')} ${part('month')}`;
  return localTimeOf(now, tz).startsWith(`${y}-`) ? text : `${text} ${y}`;
}

/** The most recent candidate day that has started by `now`; the earliest candidate when none has. */
export function mostRecentPastDay(candidates: DayInterval[], now: Ms): DayInterval | undefined {
  const past = candidates.filter((c) => c.startMs <= now);
  if (past.length === 0) return [...candidates].sort((a, b) => a.startMs - b.startMs)[0];
  return past.reduce((latest, c) => (c.startMs > latest.startMs ? c : latest));
}

/**
 * The one day a sentence names for a time reference, in the people format: the most recent past candidate
 * ("Monday" said on a Thursday is the Monday of this week). `reference_conversation` looks only at a day the user
 * says they talked; `any` takes the first resolved reference of any role. Null when there is none.
 */
export function dayOf(
  input: LaneInput,
  temporal: ResolvedTemporal[],
  role: 'reference_conversation' | 'any',
): string | null {
  const mention = temporal.find(
    (t) =>
      (role === 'any' || t.mention.role === role) &&
      t.status !== 'unresolved' &&
      t.candidates.length > 0,
  );
  const day = mention === undefined ? undefined : mostRecentPastDay(mention.candidates, input.now);
  return day === undefined ? null : peopleDate(day.localDate, input.now, input.tz);
}

/** Written in code: nothing is stored for the day the user pointed at. One date, never a list. */
export function noRecordSentence(day: string, about = ''): string {
  return `I have no record of a conversation${about} on ${day}.`;
}

/**
 * Written in code when nothing is stored for the day the user pointed at and the turn goes on to look the subject
 * up: says once that no change since then (or no earlier answer) can be established. Before findings it adds that
 * what follows is current (`findings`); before a question it ends there.
 */
export function noRecordConsequence(input: LaneInput, day: string, findings: boolean): string {
  const since = input.analysis.temporal.some((t) => t.role === 'change_since');
  const consequence = since
    ? "so I can't say what changed since then"
    : 'so I have nothing earlier to compare with';
  const tail = findings ? '; here is what I found now.' : '.';
  return `I have no record of a conversation on ${day}, ${consequence}${tail}`;
}

export const TELL_ME_WHAT_YOU_ASKED =
  "Tell me what the question was and I'll check it against current sources.";
export const FIRST_CONVERSATION = 'This looks like our first conversation.';

/** True when the user has no stored message at all before this turn, in this or any other conversation. */
export function isFirstConversation(input: LaneInput, deps: LaneDeps): boolean {
  const overview = deps.memory.conversationOverview(
    input.userId,
    input.conversationId,
    input.turnId,
    input.now,
    0,
    input.tz,
  );
  return overview.total === 0 && overview.otherConversations === 0;
}

const NUMBER_WORDS = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const NOT_A_NOUN = /\b(?:we|i|you|they|them|ones|those|these|it|that|which|me|us|your|my|our)\b/i;

/** A short noun phrase the user wrote ("CRM tools", "Postgres hosting"), or null when it is not one. */
function nounPhrase(text: string): string | null {
  const t = text.trim();
  if (!/^[\p{L}\p{N} .&+-]{2,48}$/u.test(t) || NOT_A_NOUN.test(t)) return null;
  return t.split(/\s+/).length <= 4 ? t : null;
}

/** "5 CRM tools" -> "five CRM tools"; "the CRM tools" -> "CRM tools"; anything else -> "companies". */
function setLabel(input: LaneInput): string {
  const ref = input.analysis.references.find((r) => r.kind === 'entity_set');
  const text = (ref?.text ?? '').trim().replace(/^(?:the|those|these|our|my)\s+/i, '');
  const m = /^(\d{1,2})\s+(.+)$/.exec(text);
  const count = m === null ? null : Number(m[1]);
  const noun = nounPhrase(m === null ? text : (m[2] ?? '')) ?? 'companies';
  if (count === null || count < 1) return noun;
  return `${NUMBER_WORDS[count] ?? String(count)} ${noun}`;
}

/** What the turn will check, from its intents: "their current pricing and recent releases". */
export function whatIWillCheck(input: LaneInput): string {
  const pricing = input.analysis.intents.includes('pricing');
  const releases = input.analysis.intents.includes('releases');
  if (pricing && !releases) return 'their current pricing';
  if (releases && !pricing) return 'their recent releases';
  return 'their current pricing and recent releases';
}

/**
 * The user points at a set of companies ("the 5 CRM tools") that nothing stored names: a question written in code,
 * never a search for a guessed set. It says why it asks (no such shortlist on record, with the day when there is
 * one) and what the answer will be used for, and offers up to three other stored shortlists when there are any.
 */
export function unknownShortlistOutcome(
  input: LaneInput,
  deps: LaneDeps,
  ctx: ResolvedContext,
  opening: { noRecordDay: string | null; asked: string[] },
): LaneOutcome {
  const day = dayOf(input, ctx.temporal, 'any');
  const why =
    opening.noRecordDay !== null
      ? `I have no record of a conversation on ${opening.noRecordDay}, so I don't have that shortlist on record.`
      : day !== null
        ? `I don't have a shortlist from ${day} on record.`
        : "I don't have that shortlist on record.";
  const shortlisted =
    input.analysis.userFacts.some((f) => f.kind === 'shortlist') ||
    input.analysis.references.some((r) => /shortlist/i.test(r.text));
  const label = setLabel(input);
  const ask = shortlisted ? `Which ${label} did you shortlist?` : `Which ${label} do you mean?`;
  const others = deps.memory.decisions(input.userId, 'shortlist', null).slice(0, 3);
  const question = [...opening.asked, why, ask, `I'll check ${whatIWillCheck(input)}.`].join(' ');
  emitContext(input, ctx);
  return clarifyOutcome(
    input,
    ctx,
    'missing_referent',
    question,
    others.map((d) => ({
      label: d.payload.label ?? (d.payload.entities ?? []).join(', '),
      ref: `decision:${d.id}`,
    })),
  );
}

/**
 * Nothing names a company or product the planner can search for (the user gave only a category, such as
 * "Postgres hosting"): a question written in code that says why it asks and what it will do with the answer.
 */
export function nothingToSearchOutcome(
  input: LaneInput,
  ctx: ResolvedContext,
  opening: string[],
): LaneOutcome {
  const fromReference = input.analysis.references
    .filter((r) => r.kind === 'conversation')
    .map((r) => nounPhrase(r.text))
    .find((t) => t !== null);
  const topic = fromReference ?? nounPhrase(input.analysis.topicTerms.slice(0, 2).join(' '));
  const ask =
    topic === null || topic === undefined
      ? 'Which companies or products should I check?'
      : `Which ${topic} providers should I check?`;
  const question = [
    ...opening,
    'I look things up per company or product, so I need at least one name.',
    ask,
    `I'll check ${whatIWillCheck(input)}.`,
  ].join(' ');
  emitContext(input, ctx);
  return clarifyOutcome(input, ctx, 'nothing_to_research', question, []);
}
