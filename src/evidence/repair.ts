import type {
  AuthorityTier,
  BillingPeriod,
  CheckResult,
  EntityContext,
  EvidenceVerifier,
  RawEvidence,
  SourceSnapshot,
  Unit,
  VerifiedEvidence,
} from '../shared/evidence.js';
import type { Ms } from '../shared/ids.js';

/**
 * Field repair after verification. The extractor often reads a price correctly but labels it wrongly: "$100
 * USD/user/month (billed annually)" labelled `annual`, a bare "$" labelled USD, a seat price with no seat word
 * on the page labelled `per_seat`. The rule verifier rightly fails such a statement, and a correct price is lost.
 *
 * When every failing check is one of the label checks below, and its detail says what the text itself supports,
 * the label is replaced by that (or by `unspecified` / `unknown`, which claim less) and the statement is verified
 * again from scratch. Only a statement that then passes or is weak is kept, and the changed check says what was
 * changed. Nothing is ever made more specific than the text: a repair only moves a label to what the rule check
 * itself read, or to "not stated". Amounts, quotes, plans and subjects are never repaired.
 */
interface Repair {
  check: CheckResult['check'];
  apply(raw: RawEvidence): RawEvidence | null;
  note: string;
}

function withValue(
  raw: RawEvidence,
  patch: Partial<NonNullable<RawEvidence['fields']['value']>>,
): RawEvidence | null {
  const v = raw.fields.value;
  if (!v) return null;
  return { ...raw, fields: { ...raw.fields, value: { ...v, ...patch } } };
}

const period =
  (p: BillingPeriod): Repair['apply'] =>
  (raw) =>
    withValue(raw, { billingPeriod: p });
const unit =
  (u: Unit): Repair['apply'] =>
  (raw) =>
    withValue(raw, { unit: u, usageUnit: null });

/** The repair for one failing check, read from its detail; null when the failure is not a label slip. */
function repairFor(c: CheckResult): Repair | null {
  const d = c.detail ?? '';
  if (c.check === 'billing_period') {
    if (
      d === 'text is monthly billed annually, not annual' ||
      d === 'text says billed annually: monthly_billed_annually'
    )
      return {
        check: c.check,
        apply: period('monthly_billed_annually'),
        note: 'monthly_billed_annually',
      };
    if (
      /^\w+ claimed without an? (\w+ )?marker$/.test(d) ||
      /claimed without a period marker$/.test(d)
    )
      return { check: c.check, apply: period('unspecified'), note: 'unspecified' };
    return null;
  }
  if (c.check === 'currency') {
    const m = /^quote resolves to (\S+), extraction says \S+$/.exec(d);
    if (!m?.[1]) return null;
    const code = m[1];
    return { check: c.check, apply: (raw) => withValue(raw, { currency: code }), note: code };
  }
  if (c.check === 'unit') {
    if (d === 'flat claimed but the text is per seat')
      return { check: c.check, apply: unit('per_seat'), note: 'per_seat' };
    if (
      d === 'per_seat claimed without a seat marker' ||
      d === 'flat claimed without a positive flat marker (no seat language is not flat)'
    )
      return { check: c.check, apply: unit('unspecified'), note: 'unspecified' };
    return null;
  }
  return null;
}

export class RepairingVerifier implements EvidenceVerifier {
  constructor(private readonly inner: EvidenceVerifier) {}

  verify(
    raw: RawEvidence,
    s: SourceSnapshot,
    e: EntityContext,
    tier: AuthorityTier,
    now: Ms,
  ): VerifiedEvidence {
    const first = this.inner.verify(raw, s, e, tier, now);
    if (first.verification.status !== 'fail' || raw.kind !== 'price') return first;
    const failing = first.verification.checks.filter((c) => c.outcome === 'fail');
    const repairs = failing.map(repairFor);
    if (repairs.some((r) => r === null)) return first;
    let fixed: RawEvidence | null = raw;
    for (const r of repairs) fixed = fixed && r ? r.apply(fixed) : null;
    if (!fixed) return first;
    const second = this.inner.verify(fixed, s, e, tier, now);
    if (second.verification.status === 'fail') return first;
    const was = new Map(repairs.map((r) => [r?.check, r?.note]));
    return {
      ...second,
      id: first.id,
      verification: {
        ...second.verification,
        checks: second.verification.checks.map((c) =>
          was.has(c.check)
            ? {
                ...c,
                detail: `${c.detail ? `${c.detail}; ` : ''}label set from the text to ${was.get(c.check) ?? ''}`,
              }
            : c,
        ),
      },
    };
  }
}
