import type {
  Belief,
  BeliefPolicy,
  BeliefResolver,
  BeliefTransitionReason,
  PendingSignal,
} from '../shared/belief.js';
import type { AuthorityTier, NormalizedValue, VerifiedEvidence } from '../shared/evidence.js';
import type { Ms } from '../shared/ids.js';
import { decodePriceKey, plannedTwinKey } from './belief-key.js';

const DAY = 86_400_000;

/** 30 d freshness for prices, 7 d contest window, 2 d lower-tier lead (architecture R3). */
export const DEFAULT_BELIEF_POLICY: BeliefPolicy = {
  freshnessMs: { price: 30 * DAY },
  contestWindowMs: 7 * DAY,
  lowerTierLeadMs: 2 * DAY,
};

const TIER_RANK: Record<AuthorityTier, number> = { A1: 4, A2: 3, B: 2, C: 1 };

export function tierRank(t: AuthorityTier): number {
  return TIER_RANK[t];
}

/** Every dimension of a value except the displayed symbol. */
export function valuesEqual(a: NormalizedValue | null, b: NormalizedValue | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.amount === b.amount &&
    a.currency === b.currency &&
    a.unit === b.unit &&
    a.usageUnit === b.usageUnit &&
    a.billingPeriod === b.billingPeriod &&
    a.valueKind === b.valueKind
  );
}

function fingerprint(v: NormalizedValue): string {
  return JSON.stringify([v.amount, v.currency, v.unit, v.usageUnit, v.billingPeriod, v.valueKind]);
}

/** Highest tier, then latest displayedAt (nulls last), then id: a total order, so results are deterministic. */
function byAuthorityThenTime(a: VerifiedEvidence, b: VerifiedEvidence): number {
  return (
    tierRank(b.authorityTier) - tierRank(a.authorityTier) ||
    (b.displayedAt ?? -Infinity) - (a.displayedAt ?? -Infinity) ||
    a.id.localeCompare(b.id)
  );
}
function byTimeDesc(a: VerifiedEvidence, b: VerifiedEvidence): number {
  const x = b.displayedAt ?? -Infinity;
  const y = a.displayedAt ?? -Infinity;
  return x === y ? a.id.localeCompare(b.id) : x > y ? 1 : -1;
}

function usable(
  e: VerifiedEvidence,
): e is VerifiedEvidence & { fields: { value: NormalizedValue } } {
  return e.verification.status === 'pass' && e.polarity === 'affirmed' && e.fields.value !== null;
}

function valueOf(e: VerifiedEvidence): NormalizedValue {
  if (e.fields.value === null) throw new Error('evidence has no value');
  return e.fields.value;
}

function verifiedAtOf(winners: VerifiedEvidence[]): Ms | null {
  const fresh = winners
    .filter((w) => w.displayedAtBasis === 'fresh_fetch' && w.displayedAt !== null)
    .map((w) => w.displayedAt as Ms);
  return fresh.length > 0 ? Math.max(...fresh) : null;
}

/**
 * Pure belief resolution (architecture R3). Authority tier first, then freshness, then recency; two
 * top-tier values close in time are `contested`, never "newest wins". Lower-tier newer statements and due
 * planned prices are pending signals and never change the value.
 */
export class RuleBeliefResolver implements BeliefResolver {
  resolve(
    key: string,
    evidence: VerifiedEvidence[],
    prev: Belief | null,
    now: Ms,
    policy: BeliefPolicy,
  ): {
    belief: Belief;
    transition: { reason: BeliefTransitionReason; prev: Belief | null } | null;
  } {
    const decoded = decodePriceKey(key);
    const S = evidence.filter((e) => e.beliefKey === key && usable(e));
    const current = (e: VerifiedEvidence) =>
      e.displayedAt !== null && now - e.displayedAt <= policy.freshnessMs.price;
    const F = S.filter(current);

    let belief: Belief;
    if (S.length === 0) {
      belief = {
        key,
        entityId: decoded.entityId,
        status: prev?.value ? 'stale' : 'unknown',
        value: prev?.value ?? null,
        displayedAt: prev?.displayedAt ?? null,
        verifiedAt: prev?.verifiedAt ?? null,
        winningEvidence: [],
        pendingSignals: [],
      };
    } else if (F.length === 0) {
      const w = [...S].sort(byAuthorityThenTime)[0] as VerifiedEvidence;
      belief = {
        key,
        entityId: decoded.entityId,
        status: 'stale',
        value: valueOf(w),
        displayedAt: w.displayedAt,
        verifiedAt: verifiedAtOf([w]),
        winningEvidence: [w.id],
        pendingSignals: [],
      };
    } else {
      const top0 = [...F].sort(byAuthorityThenTime)[0] as VerifiedEvidence;
      const T = tierRank(top0.authorityTier);
      const top = F.filter((e) => tierRank(e.authorityTier) === T).sort(byTimeDesc);
      const lead = top[0] as VerifiedEvidence;
      const leadAt = lead.displayedAt as Ms;
      const near = top.filter((e) => leadAt - (e.displayedAt as Ms) <= policy.contestWindowMs);
      const groups = new Map<
        string,
        { value: NormalizedValue; evidenceIds: VerifiedEvidence['id'][] }
      >();
      for (const e of near) {
        const v = valueOf(e);
        const g = groups.get(fingerprint(v)) ?? { value: v, evidenceIds: [] };
        g.evidenceIds.push(e.id);
        groups.set(fingerprint(v), g);
      }
      const leadValue = valueOf(lead);
      const lower = F.filter(
        (e) =>
          tierRank(e.authorityTier) < T &&
          (e.displayedAt as Ms) - leadAt > policy.lowerTierLeadMs &&
          !valuesEqual(valueOf(e), leadValue),
      ).sort(byTimeDesc);
      const pending: PendingSignal[] = [];
      const newestLower = lower[0];
      if (newestLower)
        pending.push({
          kind: 'lower_tier_newer',
          value: valueOf(newestLower),
          effectiveFrom: newestLower.effectiveFrom,
          evidenceIds: [newestLower.id],
        });
      if (groups.size > 1) {
        belief = {
          key,
          entityId: decoded.entityId,
          status: 'contested',
          value: null,
          contestedValues: [...groups.values()],
          displayedAt: leadAt,
          verifiedAt: verifiedAtOf(near),
          winningEvidence: near.map((e) => e.id),
          pendingSignals: pending,
        };
      } else {
        belief = {
          key,
          entityId: decoded.entityId,
          status: 'confirmed',
          value: leadValue,
          displayedAt: leadAt,
          verifiedAt: verifiedAtOf(near),
          winningEvidence: near.map((e) => e.id),
          pendingSignals: pending,
        };
      }
    }

    if (decoded.arrangement === 'list') {
      const twin = plannedTwinKey(key);
      const due = evidence
        .filter(
          (e) =>
            e.beliefKey === twin && usable(e) && e.effectiveFrom !== null && e.effectiveFrom <= now,
        )
        .sort(
          (a, b) =>
            (b.effectiveFrom as Ms) - (a.effectiveFrom as Ms) ||
            (b.displayedAt ?? -Infinity) - (a.displayedAt ?? -Infinity) ||
            a.id.localeCompare(b.id),
        )[0];
      if (due && !(belief.value !== null && valuesEqual(valueOf(due), belief.value)))
        belief.pendingSignals.push({
          kind: 'planned_due',
          value: valueOf(due),
          effectiveFrom: due.effectiveFrom,
          evidenceIds: [due.id],
        });
    }

    const ownIds = new Set(S.map((e) => e.id));
    return { belief, transition: decideTransition(prev, belief, ownIds) };
  }
}

function sameContested(a: Belief, b: Belief): boolean {
  const f = (x: Belief) =>
    JSON.stringify(
      (x.contestedValues ?? [])
        .map((g) => [fingerprint(g.value), [...g.evidenceIds].sort()])
        .sort(),
    );
  return f(a) === f(b);
}

function decideTransition(
  prev: Belief | null,
  next: Belief,
  ownIds: ReadonlySet<string>,
): { reason: BeliefTransitionReason; prev: Belief | null } | null {
  if (prev === null) return next.status === 'unknown' ? null : { reason: 'initial', prev: null };
  if (next.status === 'contested')
    return prev.status === 'contested' && sameContested(prev, next)
      ? null
      : { reason: 'contested', prev };
  if (next.status === 'unknown') return null;
  if (next.status === 'stale' && prev.status !== 'stale') return { reason: 'staled', prev };
  if (prev.value === null) {
    return { reason: prev.status === 'contested' ? 'corrected' : 'initial', prev };
  }
  if (valuesEqual(prev.value, next.value)) {
    const newer =
      next.displayedAt !== null &&
      (prev.displayedAt === null || next.displayedAt > prev.displayedAt);
    return newer ? { reason: 'reconfirmed', prev } : null;
  }
  const prevWinnersStillPass = prev.winningEvidence.every((id) => ownIds.has(id));
  if (!prevWinnersStillPass) return { reason: 'corrected', prev };
  const newer =
    next.displayedAt !== null && (prev.displayedAt === null || next.displayedAt > prev.displayedAt);
  return { reason: newer ? 'world_changed' : 'corrected', prev };
}
