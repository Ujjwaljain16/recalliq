import type { Belief } from '../shared/belief.js';
import type { AuthorityTier, NormalizedValue, VerifiedEvidence } from '../shared/evidence.js';
import type {
  ChangeDetector,
  ChangeWindow,
  Coverage,
  PriceVerdictReason,
  ReleaseVerdict,
} from '../shared/findings.js';
import type { Baseline } from '../shared/memory.js';
import type { Ms } from '../shared/ids.js';
import { contentAsOf } from './as-of.js';
import { comparableKeys, decodePriceKey } from './belief-key.js';
import { tierRank, valuesEqual } from './resolver.js';

type PriceResult = ReturnType<ChangeDetector['price']>;

function coverageReason(c: Coverage): PriceVerdictReason | null {
  if (c.failure !== null) return c.failure;
  return c.extractionFailed ? 'extraction_failed' : null;
}

function isPass(e: VerifiedEvidence): boolean {
  return e.verification.status === 'pass' && e.polarity === 'affirmed' && e.fields.value !== null;
}

function direction(from: NormalizedValue, to: NormalizedValue): 'up' | 'down' | 'other' {
  if (
    from.currency !== to.currency ||
    from.unit !== to.unit ||
    from.billingPeriod !== to.billingPeriod
  )
    return 'other';
  return to.amount > from.amount ? 'up' : to.amount < from.amount ? 'down' : 'other';
}

function bestTier(ev: VerifiedEvidence[]): AuthorityTier {
  return ev.reduce<AuthorityTier>(
    (best, e) => (tierRank(e.authorityTier) > tierRank(best) ? e.authorityTier : best),
    'C',
  );
}

/**
 * Price and release verdicts (architecture §8, ADR-36). The first matching row wins.
 *
 * `changed` requires one of two proofs and nothing weaker (ADR-36):
 *  1. Re-observation bracketing: an observation of the OLD value made after the previous answer (T0 =
 *     presentedAt) whose retrieval time AND content as-of time are both after T0 (the baseline's own fetch
 *     never counts); then a later observation of the NEW value on the SAME url_norm whose retrieval and as-of
 *     times are both later than the old-value observation's; comparableKeys === 'equal' with the baseline key,
 *     locale included; and a known (non-'und') locale. An unknown content as-of time supports nothing.
 *  2. An explicitly associated A1/A2 effective date later than T0 (the verifier sets `effectiveFrom` only
 *     from a date in the quote or header that carries an effectiveness cue; a fetch never sets it), also
 *     only with a known (non-'und') locale: an unknown locale cannot independently establish `changed`.
 * Publication and fetch dates alone never establish timing; otherwise the verdict is differs_timing_unknown.
 */
export class RuleChangeDetector implements ChangeDetector {
  price(
    b: Baseline,
    current: Belief | null,
    keyEvidence: VerifiedEvidence[],
    coverage: Coverage,
  ): PriceResult {
    const t0 = b.presentedAt;
    // 1. coverage failure
    const failure = coverageReason(coverage);
    if (failure !== null) return { verdict: 'unable_to_verify', reason: failure };
    // 2. contested
    if (current?.status === 'contested') return { verdict: 'contested', reason: null };
    // 3. the baseline's own evidence no longer supports it
    if (!baselineSupported(b))
      return { verdict: 'baseline_incorrect', reason: 'unsupported_at_time' };

    const ev = keyEvidence.filter((e) => e.beliefKey !== null && isPass(e));
    const sameKey = (e: VerifiedEvidence): boolean =>
      e.beliefKey !== null && comparableKeys(b.key, decodePriceKey(e.beliefKey)) === 'equal';
    const forKey = ev.filter(sameKey);

    if (current?.status === 'confirmed' && current.value !== null) {
      if (valuesEqual(current.value, b.value)) {
        // 4. an A1 live observation after T0 shows the same value
        const winners = new Set(current.winningEvidence);
        const fresh = forKey.some(
          (e) =>
            winners.has(e.id) &&
            e.authorityTier === 'A1' &&
            e.displayedAtBasis === 'fresh_fetch' &&
            e.displayedAt !== null &&
            e.displayedAt > t0,
        );
        return fresh
          ? { verdict: 'unchanged_confirmed', reason: null }
          : { verdict: 'no_evidence_of_change', reason: null };
      }
      // 6. the value differs: evaluate both proofs
      const cv = current.value;
      const dir = direction(b.value, cv);
      const prior = priorEffect(b, forKey);
      const post = postBaseline(b, forKey, cv);
      if (prior && post.proved) return { verdict: 'contested', reason: 'timing_conflict' };
      if (prior) return { verdict: 'baseline_incorrect', reason: 'other_value_in_effect_at_T0' };
      if (post.proved) {
        const out: PriceResult = {
          verdict: 'changed',
          reason:
            post.effectiveFrom !== undefined ? 'stated_effective_date' : 'same_source_bracketing',
          direction: dir,
        };
        if (post.window) out.window = post.window;
        if (post.effectiveFrom !== undefined) out.effectiveFrom = post.effectiveFrom;
        return out;
      }
      return { verdict: 'differs_timing_unknown', reason: null, direction: dir };
    }
    // 7. stale or unknown, with coverage that succeeded
    return { verdict: 'no_evidence_of_change', reason: null };
  }

  releases(
    evidence: VerifiedEvidence[],
    coverage: Coverage,
    t0: Ms,
  ): { verdict: ReleaseVerdict; items: VerifiedEvidence[] } {
    if (coverageReason(coverage) !== null) return { verdict: 'unable_to_verify', items: [] };
    const dateOf = (e: VerifiedEvidence): Ms | null => e.eventDate ?? e.providerPublishedAt;
    const items = evidence
      .filter(
        (e) =>
          e.kind === 'release' &&
          e.verification.status === 'pass' &&
          e.polarity === 'affirmed' &&
          dateOf(e) !== null &&
          (dateOf(e) as Ms) >= t0,
      )
      .sort((a, b) => (dateOf(a) as Ms) - (dateOf(b) as Ms) || a.id.localeCompare(b.id));
    return { verdict: items.length > 0 ? 'releases_found' : 'none_found', items };
  }
}

/** Row 3: the baseline evidence must be present, pass, and actually state the baseline value. */
function baselineSupported(b: Baseline): boolean {
  if (b.evidenceStatusAtT0 === 'missing' || b.evidenceStatusAtT0 === 'weak') return false;
  const own = b.evidence.filter(isPass);
  if (own.length === 0) return false;
  return own.some((e) => valuesEqual(e.fields.value, b.value));
}

/**
 * Prior-effect proof: a pass statement for another value, at a tier at least as high as the baseline's best,
 * that was already in effect at T0 (`effectiveFrom <= T0`, or displayed at or before T0 on a known basis).
 */
function priorEffect(b: Baseline, forKey: VerifiedEvidence[]): boolean {
  const t0 = b.presentedAt;
  const tierB = bestTier(b.evidence.filter(isPass));
  return forKey.some(
    (e) =>
      !valuesEqual(e.fields.value, b.value) &&
      tierRank(e.authorityTier) >= tierRank(tierB) &&
      ((e.effectiveFrom !== null && e.effectiveFrom <= t0) ||
        (e.displayedAt !== null && e.displayedAt <= t0 && e.displayedAtBasis !== 'unknown')),
  );
}

interface PostProof {
  proved: boolean;
  window?: ChangeWindow;
  effectiveFrom?: Ms;
}

function postBaseline(
  b: Baseline,
  forKey: VerifiedEvidence[],
  currentValue: NormalizedValue,
): PostProof {
  const t0 = b.presentedAt;
  const result: PostProof = { proved: false };

  // Route 2: an explicitly associated A1/A2 effective date after T0. Never with an unknown locale.
  const dated = forKey
    .filter(
      (e) =>
        valuesEqual(e.fields.value, currentValue) &&
        (e.authorityTier === 'A1' || e.authorityTier === 'A2') &&
        e.effectiveFrom !== null &&
        e.effectiveFrom > t0,
    )
    .sort((x, y) => (x.effectiveFrom as Ms) - (y.effectiveFrom as Ms));
  const firstDated = dated[0];
  if (firstDated && b.key.locale !== 'und') {
    result.proved = true;
    result.effectiveFrom = firstDated.effectiveFrom as Ms;
  }

  // Route 1: re-observation bracketing. Never with an unknown locale.
  if (b.key.locale !== 'und') {
    const baselineIds = new Set(b.evidence.map((e) => e.id));
    const baselineSnapshots = new Set(b.evidence.map((e) => e.snapshotId));
    const asOf = (e: VerifiedEvidence): Ms | null => contentAsOf(e);
    const olds = forKey.filter((e) => {
      const a = asOf(e);
      return (
        valuesEqual(e.fields.value, b.value) &&
        !baselineIds.has(e.id) &&
        !baselineSnapshots.has(e.snapshotId) &&
        e.observedAt > t0 &&
        a !== null &&
        a > t0
      );
    });
    let best: ChangeWindow | undefined;
    for (const old of olds) {
      const oldAsOf = asOf(old) as Ms;
      for (const nu of forKey) {
        const nuAsOf = asOf(nu);
        if (
          !valuesEqual(nu.fields.value, currentValue) ||
          nu.urlNorm !== old.urlNorm ||
          nu.observedAt <= old.observedAt ||
          nuAsOf === null ||
          nuAsOf <= oldAsOf
        )
          continue;
        const w = { after: old.observedAt, notAfter: nu.observedAt };
        if (!best || w.notAfter - w.after < best.notAfter - best.after) best = w;
      }
    }
    if (best) {
      result.proved = true;
      result.window = best;
    }
  }
  return result;
}
