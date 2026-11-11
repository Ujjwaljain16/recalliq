import { z } from 'zod';
import type { BeliefRebuilder, Db } from '../db/index.js';
import { normalizedValueSchema } from '../db/schemas.js';
import { queryAll, queryOne } from '../db/sql.js';
import { EvidenceRepository, type StoredEvidence } from '../evidence/repository.js';
import {
  newId,
  parseId,
  type Belief,
  type BeliefPolicy,
  type BeliefResolver,
  type BeliefTransitionReason,
  type Clock,
  type Ms,
  type PendingSignal,
  type TurnId,
  type UserId,
} from '../shared/index.js';
import { decodePriceKey, plannedTwinKey } from './belief-key.js';

const valueSchema = normalizedValueSchema;
const pendingSchema = z.array(
  z.object({
    kind: z.enum(['lower_tier_newer', 'planned_due']),
    value: valueSchema,
    effectiveFrom: z.number().nullable(),
    evidenceIds: z.array(z.string()),
  }),
);
const contestedSchema = z.array(z.object({ value: valueSchema, evidenceIds: z.array(z.string()) }));

const rowSchema = z.object({
  belief_key: z.string(),
  entity_id: z.string(),
  status: z.enum(['confirmed', 'contested', 'stale', 'unknown']),
  value_json: z.string().nullable(),
  contested_json: z.string().nullable(),
  pending_signals_json: z.string().nullable(),
  displayed_at: z.number().nullable(),
  verified_at: z.number().nullable(),
  winning_evidence: z.string(),
});

function toBelief(r: z.output<typeof rowSchema>): Belief {
  const belief: Belief = {
    key: r.belief_key,
    entityId: parseId('ent', r.entity_id),
    status: r.status,
    value: r.value_json === null ? null : valueSchema.parse(JSON.parse(r.value_json)),
    displayedAt: r.displayed_at,
    verifiedAt: r.verified_at,
    winningEvidence: z
      .array(z.string())
      .parse(JSON.parse(r.winning_evidence))
      .map((id) => parseId('ev', id)),
    pendingSignals:
      r.pending_signals_json === null
        ? []
        : pendingSchema.parse(JSON.parse(r.pending_signals_json)).map((p): PendingSignal => ({
            kind: p.kind,
            value: p.value,
            effectiveFrom: p.effectiveFrom,
            evidenceIds: p.evidenceIds.map((id) => parseId('ev', id)),
          })),
  };
  if (r.contested_json !== null)
    belief.contestedValues = contestedSchema.parse(JSON.parse(r.contested_json)).map((g) => ({
      value: g.value,
      evidenceIds: g.evidenceIds.map((id) => parseId('ev', id)),
    }));
  return belief;
}

export interface BeliefUpdate {
  belief: Belief;
  transition: { reason: BeliefTransitionReason; prev: Belief | null } | null;
}

export interface BeliefRepositoryDeps {
  db: Db;
  resolver: BeliefResolver;
  policy: BeliefPolicy;
  clock: Clock;
}

/**
 * L4 (derived). Writes beliefs and belief history for one user, always scoped by `user_id`. Migration 008
 * enforces that the entity and the evidence ids belong to that user. Only price keys are resolved here;
 * release statements are an event log (architecture R3).
 */
export class BeliefRepository implements BeliefRebuilder {
  private readonly db: Db;
  private readonly evidence: EvidenceRepository;

  constructor(private readonly deps: BeliefRepositoryDeps) {
    this.db = deps.db;
    this.evidence = new EvidenceRepository(deps.db);
  }

  get(userId: UserId, key: string): Belief | null {
    const r = queryOne(
      this.db,
      `SELECT belief_key, entity_id, status, value_json, contested_json, pending_signals_json, displayed_at,
              verified_at, winning_evidence FROM beliefs WHERE user_id = ? AND belief_key = ?`,
      rowSchema,
      [userId, key],
    );
    return r === null ? null : toBelief(r);
  }

  forEntity(userId: UserId, entityId: string): Belief[] {
    return queryAll(
      this.db,
      `SELECT belief_key, entity_id, status, value_json, contested_json, pending_signals_json, displayed_at,
              verified_at, winning_evidence FROM beliefs WHERE user_id = ? AND entity_id = ? ORDER BY belief_key`,
      rowSchema,
      [userId, entityId],
    ).map(toBelief);
  }

  historyReasons(userId: UserId, key: string): BeliefTransitionReason[] {
    return queryAll(
      this.db,
      'SELECT reason FROM belief_history WHERE user_id = ? AND belief_key = ? ORDER BY at, rowid',
      z.object({
        reason: z.enum([
          'initial',
          'reconfirmed',
          'world_changed',
          'corrected',
          'contested',
          'staled',
        ]),
      }),
      [userId, key],
    ).map((r) => r.reason);
  }

  /** Re-resolves `keys` from every stored `pass` statement and writes the result. One transaction. */
  updateKeys(
    userId: UserId,
    keys: readonly string[],
    now: Ms,
    turnId: TurnId | null,
  ): Map<string, BeliefUpdate> {
    return this.db
      .transaction(() => {
        const out = new Map<string, BeliefUpdate>();
        for (const key of new Set(keys)) {
          if (!key.startsWith('price:')) continue;
          const stored = this.evidence.passForKeys(userId, this.keysWithTwin(key));
          const prev = this.get(userId, key);
          const r = this.deps.resolver.resolve(
            key,
            stored.map((s) => s.evidence),
            prev,
            now,
            this.deps.policy,
          );
          this.write(userId, r.belief, prev, r.transition, now, turnId);
          out.set(key, r);
        }
        return out;
      })
      .immediate();
  }

  private keysWithTwin(key: string): string[] {
    return decodePriceKey(key).arrangement === 'list' ? [key, plannedTwinKey(key)] : [key];
  }

  private write(
    userId: UserId,
    belief: Belief,
    prev: Belief | null,
    transition: BeliefUpdate['transition'],
    now: Ms,
    turnId: TurnId | null,
  ): void {
    if (belief.status === 'unknown' && prev === null && transition === null) return;
    this.db
      .prepare(
        `INSERT INTO beliefs (user_id, belief_key, key_json, entity_id, status, value_json, contested_json,
           pending_signals_json, displayed_at, verified_at, winning_evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, belief_key) DO UPDATE SET status = excluded.status, value_json = excluded.value_json,
           contested_json = excluded.contested_json, pending_signals_json = excluded.pending_signals_json,
           displayed_at = excluded.displayed_at, verified_at = excluded.verified_at,
           winning_evidence = excluded.winning_evidence, updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        belief.key,
        JSON.stringify(decodePriceKey(belief.key)),
        belief.entityId,
        belief.status,
        belief.value === null ? null : JSON.stringify(belief.value),
        belief.contestedValues === undefined ? null : JSON.stringify(belief.contestedValues),
        JSON.stringify(belief.pendingSignals),
        belief.displayedAt,
        belief.verifiedAt,
        JSON.stringify(belief.winningEvidence),
        now,
      );
    if (transition !== null) {
      this.db
        .prepare(
          `INSERT INTO belief_history (id, user_id, belief_key, prev_json, next_json, reason, evidence_ids, turn_id, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('blh'),
          userId,
          belief.key,
          prev === null ? null : JSON.stringify(prev),
          JSON.stringify(belief),
          transition.reason,
          JSON.stringify(belief.winningEvidence),
          turnId,
          now,
        );
    }
  }

  /** `BeliefRebuilder` for privacy deletion: replay the surviving evidence for `keys`. */
  rebuild(userId: UserId, keys: readonly string[]): void {
    this.rebuildKeys(userId, keys, this.deps.clock.now());
  }

  /**
   * Deletes and recomputes beliefs and history for `keys` by replaying `pass` evidence in
   * (displayedAt nulls first, created_at) order. The clock of each replay step is the latest creation time
   * seen so far, so an in-order history reproduces the incremental one exactly; a last step at `now` ages it.
   */
  rebuildKeys(userId: UserId, keys: readonly string[], now: Ms): void {
    this.db
      .transaction(() => {
        for (const key of new Set(keys)) {
          if (!key.startsWith('price:')) continue;
          this.db
            .prepare('DELETE FROM belief_history WHERE user_id = ? AND belief_key = ?')
            .run(userId, key);
          this.db
            .prepare('DELETE FROM beliefs WHERE user_id = ? AND belief_key = ?')
            .run(userId, key);
          const stored = this.evidence.passForKeys(userId, this.keysWithTwin(key));
          let prev: Belief | null = null;
          let clock = -Infinity;
          const seen: StoredEvidence[] = [];
          for (const s of stored) {
            seen.push(s);
            clock = Math.max(clock, s.createdAt);
            const last: BeliefUpdate = this.deps.resolver.resolve(
              key,
              seen.map((x) => x.evidence),
              prev,
              clock,
              this.deps.policy,
            );
            this.write(userId, last.belief, prev, last.transition, clock, null);
            prev = last.belief;
          }
          if (stored.length > 0 && now > clock) {
            const aged = this.deps.resolver.resolve(
              key,
              stored.map((x) => x.evidence),
              prev,
              now,
              this.deps.policy,
            );
            this.write(userId, aged.belief, prev, aged.transition, now, null);
          }
        }
      })
      .immediate();
  }

  /** Every price key the user has beliefs or passing evidence for. */
  allKeys(userId: UserId): string[] {
    return queryAll(
      this.db,
      `SELECT DISTINCT k FROM (
         SELECT belief_key AS k FROM beliefs WHERE user_id = ?
         UNION SELECT belief_key AS k FROM evidence_statements
           WHERE user_id = ? AND verification_status = 'pass' AND belief_key LIKE 'price:%'
       ) ORDER BY k`,
      z.object({ k: z.string() }),
      [userId, userId],
    ).map((r) => r.k);
  }

  rebuildAll(userId: UserId, now: Ms): void {
    this.rebuildKeys(userId, this.allKeys(userId), now);
  }
}
