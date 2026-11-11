import type { EntityId, Ms } from '../shared/ids.js';
import type { ResolvedContext } from '../shared/memory.js';
import type { QuerySpec, ResearchPlan, ResearchPlanner } from '../shared/research.js';
import type { SearchRequest } from '../shared/search.js';
import type { Intent, TurnAnalysis } from '../shared/understanding.js';
import { TURN_LIMITS } from './config.js';

/** The entity a plan is about: resolved from memory, or only mentioned by the user (no id yet). */
interface Target {
  id: EntityId | null;
  name: string;
  domains: string[];
}

export function normalizeEntityName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function targetsOf(ctx: ResolvedContext, a: TurnAnalysis): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const e of ctx.entities) {
    out.push({ id: e.id, name: e.name, domains: [...e.officialDomains] });
    seen.add(normalizeEntityName(e.name));
    for (const alias of e.aliases) seen.add(normalizeEntityName(alias));
  }
  for (const m of a.entities) {
    if (seen.has(m.normalized) || seen.has(normalizeEntityName(m.text))) continue;
    seen.add(m.normalized);
    // A guess by the analysis is a hint for a search filter only. It is never stored as an official domain.
    out.push({
      id: null,
      name: m.text,
      domains: m.officialDomainGuess ? [m.officialDomainGuess] : [],
    });
  }
  return out.slice(0, TURN_LIMITS.maxEntities);
}

/** T0 for the releases window: the earliest presented baseline of the entity, else the "since" anchor. */
function releaseWindowStart(ctx: ResolvedContext, entityId: EntityId | null): Ms | undefined {
  const times = ctx.baselines
    .filter((b) => entityId === null || b.entityId === entityId)
    .map((b) => b.presentedAt);
  if (times.length > 0) return Math.min(...times);
  const since = ctx.temporal.find((t) => t.mention.role === 'change_since');
  return since?.candidates[0]?.startMs;
}

interface Draft {
  spec: QuerySpec;
  /** Lower runs first when the turn cap forces a cut. */
  priority: number;
}

function specsFor(
  t: Target,
  intent: Intent,
  ctx: ResolvedContext,
  a: TurnAnalysis,
  now: Ms,
): Draft[] {
  const year = new Date(now).getUTCFullYear();
  const id = (suffix: string, round: 1 | 2) =>
    `${t.id ?? normalizeEntityName(t.name)}:${intent}:${suffix}:${round}`;
  const domains = t.domains.length > 0 ? { includeDomains: [...t.domains] } : {};
  const drafts: Draft[] = [];
  const add = (priority: number, spec: QuerySpec) => drafts.push({ priority, spec });
  const make = (
    suffix: string,
    round: 1 | 2,
    kind: QuerySpec['intent'],
    request: SearchRequest,
  ): QuerySpec => ({ id: id(suffix, round), entityId: t.id, intent: kind, round, request });

  if (intent === 'pricing') {
    if (t.domains.length === 0) {
      add(
        0,
        make('discovery', 1, 'official_domain_discovery', {
          query: `${t.name} official site`,
          numResults: 3,
          freshness: 'cached',
          contentMode: 'highlights',
          contentChars: 1_000,
        }),
      );
    }
    add(
      0,
      make('price', 1, intent, {
        query: `${t.name} pricing`,
        numResults: 5,
        ...domains,
        freshness: 'live',
        liveTimeoutMs: 5_000,
        contentMode: 'text',
        contentChars: 6_000,
      }),
    );
    add(
      1,
      make('price', 2, intent, {
        query: `${t.name} pricing plans per user ${year}`,
        numResults: 8,
        freshness: 'cached',
        contentMode: 'text',
        contentChars: 6_000,
      }),
    );
  } else if (intent === 'releases') {
    const start = releaseWindowStart(ctx, t.id);
    const since = start === undefined ? {} : { startPublishedDate: start };
    add(
      0,
      make('releases', 1, intent, {
        query: `${t.name} announces new`,
        numResults: 6,
        ...domains,
        ...since,
        freshness: 'cached',
        contentMode: 'highlights',
        contentChars: 1_500,
      }),
    );
    add(
      1,
      make('releases', 2, intent, {
        query: `${t.name} launch OR release`,
        numResults: 8,
        ...since,
        category: 'news',
        freshness: 'cached',
        contentMode: 'highlights',
        contentChars: 1_500,
      }),
    );
  } else {
    const queries = a.queries.length > 0 ? a.queries.slice(0, 3) : [t.name];
    queries.forEach((q, i) =>
      add(
        0,
        make(`q${i}`, 1, intent, {
          query: q,
          numResults: 5,
          ...domains,
          freshness: 'cached',
          contentMode: 'highlights',
          contentChars: 1_500,
        }),
      ),
    );
    const alternate = a.alternateQueries[0];
    if (alternate !== undefined) {
      add(
        1,
        make('alt', 2, intent, {
          query: alternate,
          numResults: 5,
          freshness: 'cached',
          contentMode: 'highlights',
          contentChars: 1_500,
        }),
      );
    }
  }
  return drafts;
}

/** Results per entity-less query of the general research path. */
const GENERAL_RESULTS = 5;
/** At most this many analysis queries are searched when no entity is named. */
const MAX_GENERAL_QUERIES = 3;

/**
 * The general research path: a question about the world with no entity to plan around ("what is new in a
 * runtime", "who won the last race"). The analysis queries are searched as they are, with no entity and no
 * domain filter, as cached highlights; the first alternate query is a round-2 fallback. These specs carry the
 * `general` intent, so the research service runs no price or release extraction for them. When the analysis
 * resolved a day the question is about (an event time or a "since"), results published before it are left out.
 */
function generalDrafts(ctx: ResolvedContext, a: TurnAnalysis): Draft[] {
  const starts = ctx.temporal
    .filter((t) => t.mention.role !== 'reference_conversation' && t.status === 'resolved')
    .flatMap((t) => t.candidates.map((c) => c.startMs));
  const since = starts.length > 0 ? { startPublishedDate: Math.min(...starts) } : {};
  const request = (query: string): SearchRequest => ({
    query,
    numResults: GENERAL_RESULTS,
    ...since,
    freshness: 'cached',
    contentMode: 'highlights',
    contentChars: 1_500,
  });
  const spec = (id: string, round: 1 | 2, query: string): QuerySpec => ({
    id,
    entityId: null,
    intent: 'general',
    round,
    request: request(query),
  });
  const drafts: Draft[] = a.queries
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, MAX_GENERAL_QUERIES)
    .map((q, i) => ({ priority: 0, spec: spec(`general:q${i}:1`, 1, q) }));
  const alternate = a.alternateQueries.map((q) => q.trim()).find((q) => q.length > 0);
  if (drafts.length > 0 && alternate !== undefined) {
    drafts.push({ priority: 1, spec: spec('general:alt:2', 2, alternate) });
  }
  return drafts;
}

/**
 * Pure, deterministic planning (architecture section 9): what to search, never how. Round 1 specs run first;
 * `fallback` holds the round-2 specs for keys without good evidence and runs only if the budget admits it.
 *
 * Caps: at most 6 entities, 4 searches per entity, 16 searches per turn (round 1 and fallback together, cut by
 * priority so that every entity keeps its round-1 search before anyone gets a fallback). Queries are
 * de-duplicated within the turn. An entity beyond the cap is dropped; the orchestrator tells the user.
 *
 * With no entity at all and no pricing or releases intent, the analysis queries are planned on the general
 * research path (see `generalDrafts`). A price or release question with no entity has nothing to verify against
 * and plans nothing, so the lane asks which company is meant; so does a turn with neither an entity nor a query.
 */
export class DefaultResearchPlanner implements ResearchPlanner {
  plan(ctx: ResolvedContext, a: TurnAnalysis, now: Ms): ResearchPlan {
    const intents: Intent[] = a.intents.length > 0 ? a.intents : ['general'];
    const drafts: Draft[] = [];
    const perEntity = new Map<string, number>();
    const seenQueries = new Set<string>();

    const targets = targetsOf(ctx, a);
    const generalOnly = !intents.includes('pricing') && !intents.includes('releases');
    const groups: Array<{ key: string; candidates: Draft[] }> =
      targets.length > 0 || !generalOnly
        ? targets.map((target) => ({
            key: String(target.id ?? normalizeEntityName(target.name)),
            candidates: intents
              .flatMap((intent) => specsFor(target, intent, ctx, a, now))
              .sort((x, y) => x.priority - y.priority),
          }))
        : [{ key: '', candidates: generalDrafts(ctx, a) }];

    for (const { key, candidates } of groups) {
      for (const d of candidates) {
        const domains = (d.spec.request.includeDomains ?? []).join(',');
        const dedupe = `${d.spec.request.query.toLowerCase()}|${domains}`;
        if (seenQueries.has(dedupe)) continue;
        const used = perEntity.get(key) ?? 0;
        if (used >= TURN_LIMITS.maxPerEntity) continue;
        seenQueries.add(dedupe);
        perEntity.set(key, used + 1);
        drafts.push(d);
      }
    }

    const kept = drafts
      .map((d, order) => ({ d, order }))
      .sort((x, y) => x.d.priority - y.d.priority || x.order - y.order)
      .slice(0, TURN_LIMITS.maxSearches)
      .sort((x, y) => x.order - y.order)
      .map((x) => x.d.spec);

    return {
      specs: kept.filter((s) => s.round === 1),
      fallback: kept.filter((s) => s.round === 2),
      budget: {
        maxSearches: TURN_LIMITS.maxSearches,
        maxPerEntity: TURN_LIMITS.maxPerEntity,
        concurrency: TURN_LIMITS.concurrency,
      },
    };
  }
}
