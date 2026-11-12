import { FindingAssembler } from '../../../src/belief/assembler.js';
import { RuleChangeDetector } from '../../../src/belief/detector.js';
import { BeliefRepository } from '../../../src/belief/repository.js';
import { DEFAULT_BELIEF_POLICY, RuleBeliefResolver } from '../../../src/belief/resolver.js';
import { AdaptiveBatcher } from '../../../src/evidence/batcher.js';
import { DomainAuthorityClassifier } from '../../../src/evidence/authority.js';
import { ExtractionRunner, LlmEvidenceExtractor } from '../../../src/evidence/extractor.js';
import type { ExtractionOutput } from '../../../src/evidence/prompts/extraction.js';
import { EvidenceRepository } from '../../../src/evidence/repository.js';
import { RuleEvidenceVerifier } from '../../../src/evidence/verifier.js';
import { PipelineResearchService } from '../../../src/research/service.js';
import type { Db } from '../../../src/db/index.js';
import {
  LlmError,
  newId,
  type Baseline,
  type EntityId,
  type LlmPort,
  type Ms,
  type ResearchExecutor,
  type ResearchPlan,
  type ResearchRequest,
  type SearchOutcome,
  type SnapshotId,
  type SnapshotReader,
  type SourceSnapshot,
  type SseEvent,
  type StructuredRequest,
  type StructuredResult,
  type TurnId,
  type UserId,
  type VerifiedEvidence,
  type ResolvedContext,
  type QuerySpec,
} from '../../../src/shared/index.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { FakeBudget } from '../../helpers/budget.js';
import { insertEntity, openTestDb, seedConversation, type TestDb } from '../../helpers/db.js';

/** All vendors, URLs, pages and prices here are [SYNTHETIC]. */
export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);
export const NOW = T0 + 10 * DAY;
export const PRICING_URL = 'https://acme.example/en-gb/pricing';
export const PRICING_NORM = 'acme.example/en-gb/pricing';
export const PRO_QUOTE = 'Acme Pro US$90 per user per month, billed annually';

export function pricingPage(amount: number, extra = ''): string {
  return `Acme CRM\nPlans and pricing\nAcme Starter US$20 per user per month, billed annually\nAcme Pro US$${amount} per user per month, billed annually${extra}`;
}

export class DbSnapshotReader implements SnapshotReader {
  constructor(private readonly db: Db) {}

  getMany(userId: UserId, ids: SnapshotId[]): SourceSnapshot[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM source_snapshots WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(userId, ...ids) as Array<Record<string, string | number | null>>;
    return rows.map((r): SourceSnapshot => ({
      id: r['id'] as SnapshotId,
      url: r['url'] as string,
      urlNorm: r['url_norm'] as string,
      domain: r['domain'] as string,
      title: r['title'] as string | null,
      text: r['content_text'] as string,
      contentMode: r['content_mode'] as 'text',
      sha256: r['content_sha256'] as string,
      provider: r['provider'] as string,
      providerPublishedAt: r['provider_published_at'] as number | null,
      providerLastUpdatedAt: r['provider_last_updated_at'] as number | null,
      observedAt: r['observed_at'] as number,
      freshFetch: r['fresh_fetch'] === 1,
      crawlStatus: r['crawl_status'] as 'ok',
      origin: r['origin'] as 'live',
    }));
  }
}

export interface StoredSnapshot {
  id: SnapshotId;
}

let seq = 0;
export function storeSnapshot(
  db: Db,
  userId: UserId,
  p: {
    text: string;
    observedAt: Ms;
    url?: string;
    urlNorm?: string;
    domain?: string;
    fresh?: boolean;
    crawl?: 'ok' | 'failed' | 'unknown';
    lastUpdated?: Ms | null;
    published?: Ms | null;
  },
): SnapshotId {
  const id = `src_${++seq}` as SnapshotId;
  db.prepare(
    `INSERT INTO source_snapshots (id, user_id, url, url_norm, domain, title, content_text, content_mode,
       content_sha256, provider, provider_published_at, provider_last_updated_at, observed_at, fresh_fetch,
       crawl_status, origin) VALUES (?, ?, ?, ?, ?, NULL, ?, 'text', ?, 'test', ?, ?, ?, ?, ?, 'live')`,
  ).run(
    id,
    userId,
    p.url ?? PRICING_URL,
    p.urlNorm ?? PRICING_NORM,
    p.domain ?? 'acme.example',
    p.text,
    `sha_${id}`,
    p.published ?? null,
    p.lastUpdated ?? null,
    p.observedAt,
    (p.fresh ?? true) ? 1 : 0,
    p.crawl ?? 'ok',
  );
  return id;
}

export type Script = (message: string, call: number) => ExtractionOutput | LlmError;

export class ScriptedLlm implements LlmPort {
  calls: Array<StructuredRequest<unknown>> = [];
  constructor(private readonly script: Script) {}

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(r);
    const out = this.script(r.messages[0]?.content ?? '', this.calls.length);
    if (out instanceof LlmError) return Promise.reject(out);
    return Promise.resolve({
      value: r.schema.parse(out),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'fake',
      latencyMs: 1,
    });
  }
  stream(): never {
    throw new Error('not used');
  }
}

export function priceStatement(
  over: Partial<ExtractionOutput['statements'][number]> = {},
  amount = 90,
): ExtractionOutput['statements'][number] {
  return {
    sourceId: 'S1',
    entityId: 'E1',
    kind: 'price',
    plan: 'Pro',
    planNorm: 'pro',
    value: {
      amount,
      currency: 'USD',
      currencySymbol: '$',
      unit: 'per_seat',
      usageUnit: null,
      billingPeriod: 'monthly_billed_annually',
      valueKind: 'exact',
    },
    releaseTitle: null,
    releaseKind: null,
    conditions: null,
    quote: `Acme Pro US$${amount} per user per month, billed annually`,
    contextQuote: null,
    polarity: 'affirmed',
    modality: 'current',
    effectiveFromText: null,
    eventDateText: null,
    significance: null,
    significanceReason: null,
    ...over,
  };
}

export class ScriptedExecutor implements ResearchExecutor {
  rounds: Array<1 | 2> = [];
  plans: ResearchPlan[] = [];
  constructor(private readonly byRound: Partial<Record<1 | 2, SearchOutcome[] | Error>>) {}

  execute(plan: ResearchPlan, round: 1 | 2): Promise<SearchOutcome[]> {
    this.rounds.push(round);
    this.plans.push(plan);
    const out = this.byRound[round];
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(out ?? []);
  }
}

export function spec(entityId: EntityId | null, round: 1 | 2 = 1): QuerySpec {
  return {
    id: `q_${entityId ?? 'x'}_${round}`,
    entityId,
    intent: 'pricing',
    round,
    request: {
      query: 'Acme pricing',
      numResults: 5,
      freshness: 'live',
      contentMode: 'text',
      contentChars: 6000,
    },
  };
}

export function outcome(
  entityId: EntityId,
  snapshotIds: SnapshotId[],
  over: Partial<SearchOutcome> = {},
): SearchOutcome {
  return { spec: spec(entityId), status: 'ok', snapshotIds, ...over };
}

export interface World {
  t: TestDb;
  userId: UserId;
  turnId: TurnId;
  acme: ResolvedContext['entities'][number];
  beta: ResolvedContext['entities'][number];
  evidence: EvidenceRepository;
  beliefs: BeliefRepository;
  reader: DbSnapshotReader;
  clock: FixedClock;
}

export function makeWorld(): World {
  const t = openTestDb();
  const userId = t.users.create();
  const { turnId } = seedConversation(t, userId);
  const acmeId = insertEntity(t.db, { userId, norm: 'acme-crm' });
  const betaId = insertEntity(t.db, { userId, norm: 'beta-suite' });
  const clock = new FixedClock(NOW);
  const evidence = new EvidenceRepository(t.db);
  const beliefs = new BeliefRepository({
    db: t.db,
    resolver: new RuleBeliefResolver(),
    policy: DEFAULT_BELIEF_POLICY,
    clock,
  });
  return {
    t,
    userId,
    turnId,
    acme: {
      id: acmeId,
      name: 'Acme CRM',
      aliases: ['Acme'],
      plans: ['starter', 'pro'],
      officialDomains: ['acme.example'],
    },
    beta: {
      id: betaId,
      name: 'Beta Suite',
      aliases: ['Beta'],
      plans: ['basic'],
      officialDomains: ['beta.example'],
    },
    evidence,
    beliefs,
    reader: new DbSnapshotReader(t.db),
    clock,
  };
}

let idCounter = 0;
export function makeService(
  w: World,
  executor: ResearchExecutor,
  llm: LlmPort,
  reader: SnapshotReader = w.reader,
) {
  const classifier = new DomainAuthorityClassifier();
  const entities = [w.acme, w.beta];
  const extractor = new LlmEvidenceExtractor({
    llm,
    snapshots: (ids) => reader.getMany(w.userId, [...ids]),
    entities: (ids) =>
      entities
        .filter((e) => ids.includes(e.id))
        .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases })),
  });
  return new PipelineResearchService({
    db: w.t.db,
    executor,
    snapshots: reader,
    batcher: new AdaptiveBatcher({
      tierOf: (s, id) =>
        classifier.classify(s, entities.find((e) => e.id === id)?.officialDomains ?? []),
    }),
    runner: new ExtractionRunner(extractor),
    verifier: new RuleEvidenceVerifier({ newEvidenceId: () => `ev_t${++idCounter}` }),
    classifier,
    evidence: w.evidence,
    beliefs: w.beliefs,
    assembler: new FindingAssembler({
      detector: new RuleChangeDetector(),
      newFindingId: () => `fnd_${++idCounter}`,
    }),
  });
}

export function request(
  w: World,
  over: {
    entities?: ResolvedContext['entities'];
    baselines?: Baseline[];
    plan?: Partial<ResearchPlan>;
    intents?: Array<'pricing' | 'releases' | 'general'>;
    budget?: FakeBudget;
    now?: Ms;
    /** A "since" the user named (a resolved `change_since` mention starting at this instant). */
    since?: Ms;
  } = {},
): { req: ResearchRequest; events: SseEvent[] } {
  const events: SseEvent[] = [];
  const entities = over.entities ?? [w.acme];
  const plan: ResearchPlan = {
    specs: entities.map((e) => spec(e.id)),
    fallback: [],
    budget: { maxSearches: 6, maxPerEntity: 2, concurrency: 2 },
    ...over.plan,
  };
  return {
    events,
    req: {
      userId: w.userId,
      turnId: w.turnId,
      ctx: {
        lane: over.baselines && over.baselines.length > 0 ? 'audit' : 'research',
        temporal:
          over.since === undefined
            ? []
            : [
                {
                  mention: {
                    text: 'since',
                    expr: { kind: 'days_ago', n: 30 },
                    role: 'change_since',
                  },
                  candidates: [
                    {
                      startMs: over.since,
                      endMs: over.since + 86_400_000,
                      localDate: new Date(over.since).toISOString().slice(0, 10),
                      tz: 'UTC',
                    },
                  ],
                  status: 'resolved',
                },
              ],
        memoryHits: [],
        decisions: [],
        entities,
        baselines: over.baselines ?? [],
      },
      analysis: {
        laneHint: 'research',
        intents: over.intents ?? ['pricing'],
        temporal: [],
        entities: [],
        references: [],
        topicTerms: [],
        asksStillCorrect: false,
        queries: [],
        alternateQueries: [],
        userFacts: [],
        degraded: false,
      },
      plan,
      now: over.now ?? NOW,
      budget: over.budget ?? new FakeBudget(60_000, over.now ?? NOW),
      emit: (e) => events.push(e),
    },
  };
}

/** A baseline built the way the baseline loader would: stored evidence from a presented answer. */
export function storedBaseline(
  w: World,
  p: { amount?: number; observedAt?: Ms; presentedAt?: Ms } = {},
): Baseline {
  const amount = p.amount ?? 90;
  const snapId = storeSnapshot(w.t.db, w.userId, {
    text: pricingPage(amount),
    observedAt: p.observedAt ?? T0 - 3_600_000,
  });
  const snap = w.reader.getMany(w.userId, [snapId])[0] as SourceSnapshot;
  const verifier = new RuleEvidenceVerifier({ newEvidenceId: () => `ev_base${snapId}` });
  const raw = {
    snapshotRef: snapId,
    entityRef: w.acme.id,
    kind: 'price' as const,
    fields: {
      plan: 'Pro',
      planNorm: 'pro',
      attribute: 'price' as const,
      value: priceStatement({}, amount).value,
      conditions: null,
    },
    quote: `Acme Pro US$${amount} per user per month, billed annually`,
    contextQuote: null,
    polarity: 'affirmed' as const,
    modality: 'current' as const,
    effectiveFromText: null,
    eventDateText: null,
    significance: null,
    significanceReason: null,
  };
  const ev: VerifiedEvidence = verifier.verify(
    raw,
    snap,
    {
      id: w.acme.id,
      aliases: ['Acme CRM', 'Acme'],
      plans: w.acme.plans,
      officialDomains: w.acme.officialDomains,
      otherEntityAliases: ['Beta Suite', 'Beta'],
    },
    'A1',
    p.observedAt ?? T0,
  );
  if (ev.verification.status !== 'pass' || ev.beliefKey === null)
    throw new Error('baseline fixture must pass verification');
  const other = seedConversation(w.t, w.userId, { idempotencyKey: newId('trn') });
  w.evidence.insert(w.userId, other.turnId, ev, p.observedAt ?? T0);
  w.beliefs.updateKeys(w.userId, [ev.beliefKey], p.observedAt ?? T0, other.turnId);
  return {
    assertionId: newId('asr'),
    beliefKey: ev.beliefKey,
    key: JSON.parse(
      w.t.db
        .prepare('SELECT key_json FROM beliefs WHERE belief_key = ?')
        .pluck()
        .get(ev.beliefKey) as string,
    ) as Baseline['key'],
    entityId: w.acme.id,
    value: ev.fields.value as NonNullable<typeof ev.fields.value>,
    presentedAt: p.presentedAt ?? T0,
    evidence: [ev],
    evidenceStatusAtT0: 'pass_current',
  };
}
