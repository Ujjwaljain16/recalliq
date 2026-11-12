import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { normalizedValueSchema } from '../db/schemas.js';
import { queryAll } from '../db/sql.js';
import {
  parseId,
  type EvidenceId,
  type Ms,
  type TurnId,
  type UserId,
  type VerifiedEvidence,
} from '../shared/index.js';

const fieldsSchema = z.object({
  plan: z.string().nullable(),
  planNorm: z.string().nullable(),
  attribute: z.enum(['price', 'release', 'plan_change', 'other']),
  value: normalizedValueSchema.nullable(),
  releaseTitle: z.string().optional(),
  releaseKind: z.enum(['launch', 'change', 'removal']).optional(),
  conditions: z.string().nullable(),
});

const verificationSchema = z.object({
  status: z.enum(['pass', 'weak', 'fail']),
  checks: z.array(
    z.object({
      check: z.enum([
        'quote_verbatim',
        'context_verbatim',
        'context_association',
        'subject_binding',
        'competitor_attribution',
        'plan_binding',
        'intervening_tier',
        'value_presence',
        'currency',
        'unit',
        'billing_period',
        'date_presence',
        'negation',
        'historical_cue',
        'conditional_cue',
        'planned_cue',
      ]),
      outcome: z.enum(['pass', 'weak', 'fail', 'n/a']),
      detail: z.string().optional(),
    }),
  ),
});

const rowSchema = z.object({
  id: z.string(),
  snapshot_id: z.string(),
  entity_id: z.string(),
  kind: z.enum(['price', 'release', 'plan_change', 'other']),
  belief_key: z.string().nullable(),
  payload_json: z.string(),
  quote: z.string(),
  context_quote: z.string().nullable(),
  polarity: z.enum(['affirmed', 'negated']),
  modality: z.enum(['current', 'planned', 'historical', 'conditional', 'promotional']),
  effective_from: z.number().nullable(),
  event_date: z.number().nullable(),
  displayed_at: z.number().nullable(),
  displayed_at_basis: z.enum([
    'fresh_fetch',
    'provider_last_updated',
    'provider_published',
    'unknown',
  ]),
  authority_tier: z.enum(['A1', 'A2', 'B', 'C']),
  verification_json: z.string(),
  significance: z.enum(['major', 'minor']).nullable(),
  created_at: z.number(),
  url_norm: z.string(),
  observed_at: z.number(),
  fresh_fetch: z.number(),
  crawl_status: z.string(),
  provider_published_at: z.number().nullable(),
  provider_last_updated_at: z.number().nullable(),
});

export interface StoredEvidence {
  evidence: VerifiedEvidence;
  createdAt: Ms;
}

const SELECT = `SELECT e.id, e.snapshot_id, e.entity_id, e.kind, e.belief_key, e.payload_json, e.quote,
    e.context_quote, e.polarity, e.modality, e.effective_from, e.event_date, e.displayed_at,
    e.displayed_at_basis, e.authority_tier, e.verification_json, e.significance, e.created_at,
    s.url_norm, s.observed_at, s.fresh_fetch, s.crawl_status, s.provider_published_at,
    s.provider_last_updated_at
  FROM evidence_statements e JOIN source_snapshots s ON s.id = e.snapshot_id`;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function toStored(r: z.output<typeof rowSchema>): StoredEvidence {
  const fields = fieldsSchema.parse(JSON.parse(r.payload_json));
  const verification = verificationSchema.parse(JSON.parse(r.verification_json));
  const evidence: VerifiedEvidence = {
    id: parseId('ev', r.id),
    snapshotId: parseId('src', r.snapshot_id),
    urlNorm: r.url_norm,
    entityId: parseId('ent', r.entity_id),
    kind: r.kind,
    beliefKey: r.belief_key,
    fields: {
      plan: fields.plan,
      planNorm: fields.planNorm,
      attribute: fields.attribute,
      value: fields.value,
      conditions: fields.conditions,
      ...(fields.releaseTitle !== undefined ? { releaseTitle: fields.releaseTitle } : {}),
      ...(fields.releaseKind !== undefined ? { releaseKind: fields.releaseKind } : {}),
    },
    quote: r.quote,
    contextQuote: r.context_quote,
    polarity: r.polarity,
    modality: r.modality,
    authorityTier: r.authority_tier,
    verification: {
      status: verification.status,
      checks: verification.checks.map((c) => ({
        check: c.check,
        outcome: c.outcome,
        ...(c.detail !== undefined ? { detail: c.detail } : {}),
      })),
    },
    significance: r.significance,
    observedAt: r.observed_at,
    // A failed crawl is not a fresh fetch, whatever the flag says (mirrors the verifier).
    freshFetch: r.fresh_fetch === 1 && r.crawl_status === 'ok',
    providerPublishedAt: r.provider_published_at,
    providerLastUpdatedAt: r.provider_last_updated_at,
    effectiveFrom: r.effective_from,
    eventDate: r.event_date,
    displayedAt: r.displayed_at,
    displayedAtBasis: r.displayed_at_basis,
  };
  return { evidence, createdAt: r.created_at };
}

/**
 * L2 writes and reads. Every statement is scoped by `user_id`; ownership of the turn, snapshot and entity is
 * additionally enforced by the migration 003 triggers. Evidence is immutable once written.
 */
export class EvidenceRepository {
  constructor(private readonly db: Db) {}

  /** Stores a verified statement of any status (pass, weak and fail are all kept for audit). */
  insert(userId: UserId, turnId: TurnId, e: VerifiedEvidence, createdAt: Ms): void {
    const status = e.verification.status;
    if (status !== 'pass' && e.beliefKey !== null)
      throw new Error('only pass evidence may carry a belief key');
    this.db
      .prepare(
        `INSERT INTO evidence_statements (id, user_id, snapshot_id, turn_id, entity_id, kind, belief_key,
           payload_json, quote, context_quote, polarity, modality, effective_from, event_date, displayed_at,
           displayed_at_basis, authority_tier, verification_status, verification_json, significance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        userId,
        e.snapshotId,
        turnId,
        e.entityId,
        e.kind,
        e.beliefKey,
        JSON.stringify(e.fields),
        e.quote,
        e.contextQuote,
        e.polarity,
        e.modality,
        e.effectiveFrom,
        e.eventDate,
        e.displayedAt,
        e.displayedAtBasis,
        e.authorityTier,
        status,
        JSON.stringify(e.verification),
        e.significance,
        createdAt,
      );
  }

  insertMany(
    userId: UserId,
    turnId: TurnId,
    list: readonly VerifiedEvidence[],
    createdAt: Ms,
  ): void {
    this.db
      .transaction(() => {
        for (const e of list) this.insert(userId, turnId, e, createdAt);
      })
      .immediate();
  }

  /** `pass` evidence for these belief keys, oldest displayed first (nulls first), then creation order. */
  passForKeys(userId: UserId, keys: readonly string[]): StoredEvidence[] {
    if (keys.length === 0) return [];
    return queryAll(
      this.db,
      `${SELECT} WHERE e.user_id = ? AND e.verification_status = 'pass' AND e.belief_key IN (${placeholders(keys.length)})
       ORDER BY e.displayed_at IS NOT NULL, e.displayed_at, e.created_at, e.id`,
      rowSchema,
      [userId, ...keys],
    ).map(toStored);
  }

  /** Release statements that passed, for one entity. */
  passReleasesForEntity(userId: UserId, entityId: string): VerifiedEvidence[] {
    return queryAll(
      this.db,
      `${SELECT} WHERE e.user_id = ? AND e.entity_id = ? AND e.kind = 'release' AND e.verification_status = 'pass'
       ORDER BY e.event_date, e.created_at, e.id`,
      rowSchema,
      [userId, entityId],
    ).map((r) => toStored(r).evidence);
  }

  getMany(userId: UserId, ids: readonly EvidenceId[]): VerifiedEvidence[] {
    if (ids.length === 0) return [];
    return queryAll(
      this.db,
      `${SELECT} WHERE e.user_id = ? AND e.id IN (${placeholders(ids.length)}) ORDER BY e.created_at, e.id`,
      rowSchema,
      [userId, ...ids],
    ).map((r) => toStored(r).evidence);
  }
}
