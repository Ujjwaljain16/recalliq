import type { VerifiedEvidence, VerificationCheck } from '../../shared/evidence.js';
import { findAmounts } from '../currency.js';
import { locateVerbatim, normalizeText } from '../text.js';
import type { Category, GoldClaim, GoldFile, StatementMatch } from './gold.js';

/**
 * Pure scoring of extracted-and-verified statements against the gold claims of one page, and aggregation across
 * pages. No I/O, no clock, no randomness. The definitions are in docs/extraction-calibration.md.
 */

type Status = 'pass' | 'weak' | 'fail';

export interface PageScoreInput {
  pageId: string;
  categories: readonly Category[];
  /** The captured page text, exactly as given to the extractor. */
  text: string;
  gold: GoldFile;
  /** Every statement the extractor proposed for the page, with the verifier's verdict. */
  statements: readonly VerifiedEvidence[];
  /** The extraction call failed (provider error, invalid output...): nothing was proposed. */
  extractionFailure?: string;
}

/** What a price statement turned out to be. */
export type StatementClass =
  /** Matches a gold claim on plan, amount, currency, unit, usage unit and billing period. */
  | 'true_positive'
  /** Matches a gold claim that another statement already matched. */
  | 'duplicate'
  /** Matches a labelled trap. */
  | 'trap'
  /** Matches a true statement the gold list does not enumerate. */
  | 'ignored'
  /** Right amount, plan and currency; differs from gold only by fields it left unspecified. */
  | 'underspecified'
  /** Right amount, but a different plan, currency, unit or period than the gold claim. */
  | 'contradicts'
  /** Matches nothing in the gold list. */
  | 'unmatched';

export interface ScoredStatement {
  evidenceId: string;
  status: Status;
  klass: StatementClass;
  goldClaimId?: string;
  trapId?: string;
  /** The proposed value, for reading a report without the raw output. */
  plan: string | null;
  amount: number;
  currency: string;
  unit: string;
  usageUnit: string | null;
  billingPeriod: string;
  modality: string;
  failingChecks: string[];
  quoteVerbatim: boolean;
  quoteContainsValue: boolean;
}

export interface FieldCounts {
  correct: number;
  total: number;
}

export interface FieldTally {
  entity: FieldCounts;
  plan: FieldCounts;
  /** Entity and plan both right. */
  subject: FieldCounts;
  unit: FieldCounts;
  /** Only over aligned gold claims whose unit is `usage`. */
  usageUnit: FieldCounts;
  currency: FieldCounts;
  billingPeriod: FieldCounts;
  valueKind: FieldCounts;
  modality: FieldCounts;
  /** The statement carries conditions text exactly when the gold claim does. */
  conditions: FieldCounts;
}

export interface PageScore {
  pageId: string;
  categories: Category[];
  negativeControl: boolean;
  goldClaims: number;
  /** Gold claims that verification can ever pass (labelled pass, or pass with a better quote or context). */
  goldPassable: number;
  extractionFailure: string | null;
  priceStatements: number;
  nonPriceStatements: number;
  /** Price statements that count for precision: all but duplicates and ignorable ones. */
  predicted: number;
  truePositives: number;
  duplicates: number;
  ignored: number;
  /** Gold claims matched by at least one statement. */
  matchedGold: number;
  matchedGoldIds: string[];
  missedGoldIds: string[];
  matchedGoldLowConfidence: number;
  goldLowConfidence: number;
  /** Counts over the price statements counted for precision. */
  passStatements: number;
  weakStatements: number;
  failStatements: number;
  /** Pass-status statements counted for precision that are true positives. */
  verifiedTruePositives: number;
  /** Gold claims matched by a pass-status statement. */
  verifiedMatchedGold: number;
  verifiedMatchedPassable: number;
  /** Pass-status statements that are not a true positive, a duplicate of one, or ignorable. */
  falsePasses: number;
  falsePassByClass: Partial<Record<StatementClass, number>>;
  /** All pass-status price statements (the denominator of the false-pass rate). */
  passStatementsAll: number;
  /** Verdicts over every price statement, duplicates and ignorable ones included. */
  statusAll: { pass: number; weak: number; fail: number };
  fields: FieldTally;
  alignedGold: number;
  quoteVerbatim: number;
  quoteContainsValue: number;
  quoteAccurate: number;
  checkFailures: Record<string, { weak: number; fail: number }>;
  statements: ScoredStatement[];
}

const EPS = 1e-9;
const sameAmount = (a: number, b: number): boolean => Math.abs(a - b) < EPS;

export function normPlan(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const n = normalizeText(s).toLowerCase();
  return n.length === 0 ? null : n;
}

/** Lower-cased letters and digits only, so "GB-month", "GB / month" and "gb month" agree. */
export function normUsageUnit(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const n = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return n.length === 0 ? null : n;
}

interface PriceView {
  ev: VerifiedEvidence;
  amount: number;
  planNorm: string | null;
  currency: string;
  unit: string;
  usageUnit: string | null;
  billingPeriod: string;
  valueKind: string;
  modality: string;
  hasConditions: boolean;
}

function viewOf(ev: VerifiedEvidence): PriceView | null {
  const v = ev.fields.value;
  if (ev.kind !== 'price' || v === null) return null;
  return {
    ev,
    amount: v.amount,
    planNorm: normPlan(ev.fields.planNorm ?? ev.fields.plan),
    currency: v.currency,
    unit: v.unit,
    usageUnit: normUsageUnit(v.usageUnit),
    billingPeriod: v.billingPeriod,
    valueKind: v.valueKind,
    modality: ev.modality,
    hasConditions: (ev.fields.conditions ?? '').trim().length > 0,
  };
}

/** Plan equality; a gold claim without a plan accepts any plan. */
function planAgrees(gold: GoldClaim, s: PriceView): boolean {
  const g = normPlan(gold.planNorm ?? gold.plan);
  return g === null || g === s.planNorm;
}

function strictMatch(gold: GoldClaim, s: PriceView): boolean {
  const v = gold.value;
  return (
    sameAmount(v.amount, s.amount) &&
    planAgrees(gold, s) &&
    v.currency === s.currency &&
    v.unit === s.unit &&
    normUsageUnit(v.usageUnit) === s.usageUnit &&
    v.billingPeriod === s.billingPeriod
  );
}

export function matchesSpec(m: StatementMatch, s: PriceView): boolean {
  if (m.amount !== undefined && !sameAmount(m.amount, s.amount)) return false;
  if (m.planNorm !== undefined && normPlan(m.planNorm) !== s.planNorm) return false;
  if (m.quoteContains !== undefined) {
    const q = normalizeText(s.ev.quote).toLowerCase();
    if (!m.quoteContains.every((x) => q.includes(normalizeText(x).toLowerCase()))) return false;
  }
  if (m.currency !== undefined && !m.currency.includes(s.currency)) return false;
  if (m.unit !== undefined && !m.unit.includes(s.unit)) return false;
  if (m.billingPeriod !== undefined && !m.billingPeriod.includes(s.billingPeriod)) return false;
  if (m.modality !== undefined && !m.modality.includes(s.modality)) return false;
  return true;
}

const STATUS_ORDER: Record<Status, number> = { pass: 0, weak: 1, fail: 2 };

function failingChecksOf(ev: VerifiedEvidence): string[] {
  return ev.verification.checks
    .filter((c) => c.outcome === 'weak' || c.outcome === 'fail')
    .map((c) => `${c.check}:${c.outcome}`);
}

/** How a statement that matched no gold claim exactly relates to the gold claims with the same amount. */
function relaxedClass(
  s: PriceView,
  claims: readonly GoldClaim[],
): 'underspecified' | 'contradicts' | 'unmatched' {
  const sameAmt = claims.filter((c) => sameAmount(c.value.amount, s.amount));
  if (sameAmt.length === 0) return 'unmatched';
  const samePlan = sameAmt.filter((c) => planAgrees(c, s) && c.value.currency === s.currency);
  if (samePlan.length === 0) return 'contradicts';
  const loose = samePlan.some((c) => {
    const v = c.value;
    const unitOk = v.unit === s.unit || s.unit === 'unspecified';
    const periodOk = v.billingPeriod === s.billingPeriod || s.billingPeriod === 'unspecified';
    const usageOk = normUsageUnit(v.usageUnit) === s.usageUnit || s.usageUnit === null;
    return unitOk && periodOk && usageOk;
  });
  return loose ? 'underspecified' : 'contradicts';
}

function emptyTally(): FieldTally {
  const z = (): FieldCounts => ({ correct: 0, total: 0 });
  return {
    entity: z(),
    plan: z(),
    subject: z(),
    unit: z(),
    usageUnit: z(),
    currency: z(),
    billingPeriod: z(),
    valueKind: z(),
    modality: z(),
    conditions: z(),
  };
}

function bump(c: FieldCounts, ok: boolean): void {
  c.total += 1;
  if (ok) c.correct += 1;
}

function fieldOverlap(gold: GoldClaim, s: PriceView): number {
  const v = gold.value;
  return (
    Number(planAgrees(gold, s)) +
    Number(v.currency === s.currency) +
    Number(v.unit === s.unit) +
    Number(normUsageUnit(v.usageUnit) === s.usageUnit) +
    Number(v.billingPeriod === s.billingPeriod) +
    Number(v.valueKind === s.valueKind) +
    Number(gold.modality === s.modality)
  );
}

function containsValue(quote: string, amount: number): boolean {
  return findAmounts(normalizeText(quote)).some((t) => sameAmount(t.amount, amount));
}

export function scorePage(input: PageScoreInput): PageScore {
  const { gold } = input;
  const views = input.statements.map(viewOf);
  const price = views.filter((v): v is PriceView => v !== null);
  const nonPrice = input.statements.length - price.length;
  const text = normalizeText(input.text);
  const entityId = `ent_${input.pageId}`;

  // Passing statements are assigned first so a gold claim is credited to the strongest duplicate.
  const order = [...price].sort(
    (a, b) => STATUS_ORDER[a.ev.verification.status] - STATUS_ORDER[b.ev.verification.status],
  );
  const claimOwner = new Map<string, PriceView>();
  const owned = new Map<PriceView, string>();
  for (const c of gold.claims) {
    const hit = order.find((s) => !owned.has(s) && strictMatch(c, s));
    if (hit) {
      claimOwner.set(c.id, hit);
      owned.set(hit, c.id);
    }
  }

  const classes = new Map<PriceView, { klass: StatementClass; goldId?: string; trapId?: string }>();
  for (const s of order) {
    const own = owned.get(s);
    if (own !== undefined) {
      classes.set(s, { klass: 'true_positive', goldId: own });
      continue;
    }
    const dupOf = gold.claims.find((c) => strictMatch(c, s));
    if (dupOf) {
      classes.set(s, { klass: 'duplicate', goldId: dupOf.id });
      continue;
    }
    const trap = gold.traps.find((t) => matchesSpec(t.match, s));
    if (trap) {
      classes.set(s, { klass: 'trap', trapId: trap.id });
      continue;
    }
    if (gold.ignorable.some((g) => matchesSpec(g.match, s))) {
      classes.set(s, { klass: 'ignored' });
      continue;
    }
    classes.set(s, { klass: relaxedClass(s, gold.claims) });
  }

  const counted = price.filter((s) => {
    const k = classes.get(s)?.klass;
    return k !== 'duplicate' && k !== 'ignored';
  });
  const statusOf = (s: PriceView): Status => s.ev.verification.status;
  const tp = price.filter((s) => classes.get(s)?.klass === 'true_positive');
  const passAll = price.filter((s) => statusOf(s) === 'pass');
  const falsePassList = passAll.filter((s) => {
    const k = classes.get(s)?.klass;
    return k !== 'true_positive' && k !== 'duplicate' && k !== 'ignored';
  });
  const falsePassByClass: Partial<Record<StatementClass, number>> = {};
  for (const s of falsePassList) {
    const k = classes.get(s)?.klass ?? 'unmatched';
    falsePassByClass[k] = (falsePassByClass[k] ?? 0) + 1;
  }

  const matchedIds = gold.claims.filter((c) => claimOwner.has(c.id)).map((c) => c.id);
  const verifiedGold = gold.claims.filter((c) => {
    const ow = claimOwner.get(c.id);
    if (ow !== undefined && statusOf(ow) === 'pass') return true;
    // A pass-status duplicate also verifies the claim, even if another statement owns it.
    return passAll.some((s) => strictMatch(c, s));
  });
  const passable = (c: GoldClaim): boolean =>
    c.expected.status === 'pass' || c.bestAchievable?.status === 'pass';

  // Field-level alignment: each gold claim against the closest statement on the amount.
  const fields = emptyTally();
  const taken = new Set<PriceView>();
  let aligned = 0;
  for (const c of gold.claims) {
    const strict = claimOwner.get(c.id);
    const candidates = price.filter((s) => sameAmount(s.amount, c.value.amount) && !taken.has(s));
    const best =
      strict ?? [...candidates].sort((a, b) => fieldOverlap(c, b) - fieldOverlap(c, a))[0];
    if (!best) continue;
    taken.add(best);
    aligned += 1;
    const v = c.value;
    const entityOk = best.ev.entityId === entityId;
    const planOk = planAgrees(c, best);
    bump(fields.entity, entityOk);
    bump(fields.plan, planOk);
    bump(fields.subject, entityOk && planOk);
    bump(fields.unit, v.unit === best.unit);
    if (v.unit === 'usage') bump(fields.usageUnit, normUsageUnit(v.usageUnit) === best.usageUnit);
    bump(fields.currency, v.currency === best.currency);
    bump(fields.billingPeriod, v.billingPeriod === best.billingPeriod);
    bump(fields.valueKind, v.valueKind === best.valueKind);
    bump(fields.modality, c.modality === best.modality);
    bump(fields.conditions, (c.conditions !== null) === best.hasConditions);
  }

  // Supporting quote: verbatim in the page AND carrying the claimed value.
  let verbatim = 0;
  let hasValue = 0;
  let accurate = 0;
  const scored: ScoredStatement[] = [];
  const checkFailures: Record<string, { weak: number; fail: number }> = {};
  for (const s of price) {
    const qv = locateVerbatim(text, normalizeText(s.ev.quote)) !== null;
    const qc = containsValue(s.ev.quote, s.amount);
    if (qv) verbatim += 1;
    if (qc) hasValue += 1;
    if (qv && qc) accurate += 1;
    for (const c of s.ev.verification.checks) {
      if (c.outcome !== 'weak' && c.outcome !== 'fail') continue;
      const key: VerificationCheck = c.check;
      const slot = (checkFailures[key] ??= { weak: 0, fail: 0 });
      slot[c.outcome] += 1;
    }
    const cls = classes.get(s);
    scored.push({
      evidenceId: s.ev.id,
      status: statusOf(s),
      klass: cls?.klass ?? 'unmatched',
      ...(cls?.goldId !== undefined ? { goldClaimId: cls.goldId } : {}),
      ...(cls?.trapId !== undefined ? { trapId: cls.trapId } : {}),
      plan: s.planNorm,
      amount: s.amount,
      currency: s.currency,
      unit: s.unit,
      usageUnit: s.ev.fields.value?.usageUnit ?? null,
      billingPeriod: s.billingPeriod,
      modality: s.modality,
      failingChecks: failingChecksOf(s.ev),
      quoteVerbatim: qv,
      quoteContainsValue: qc,
    });
  }

  const low = gold.claims.filter((c) => c.confidence === 'low');
  return {
    pageId: input.pageId,
    categories: [...input.categories],
    negativeControl: gold.claims.length === 0,
    goldClaims: gold.claims.length,
    goldPassable: gold.claims.filter(passable).length,
    extractionFailure: input.extractionFailure ?? null,
    priceStatements: price.length,
    nonPriceStatements: nonPrice,
    predicted: counted.length,
    truePositives: tp.length,
    duplicates: price.filter((s) => classes.get(s)?.klass === 'duplicate').length,
    ignored: price.filter((s) => classes.get(s)?.klass === 'ignored').length,
    matchedGold: matchedIds.length,
    matchedGoldIds: matchedIds,
    missedGoldIds: gold.claims.filter((c) => !claimOwner.has(c.id)).map((c) => c.id),
    matchedGoldLowConfidence: low.filter((c) => claimOwner.has(c.id)).length,
    goldLowConfidence: low.length,
    passStatements: counted.filter((s) => statusOf(s) === 'pass').length,
    weakStatements: counted.filter((s) => statusOf(s) === 'weak').length,
    failStatements: counted.filter((s) => statusOf(s) === 'fail').length,
    verifiedTruePositives: tp.filter((s) => statusOf(s) === 'pass').length,
    verifiedMatchedGold: verifiedGold.length,
    verifiedMatchedPassable: verifiedGold.filter(passable).length,
    falsePasses: falsePassList.length,
    falsePassByClass,
    passStatementsAll: passAll.length,
    statusAll: {
      pass: passAll.length,
      weak: price.filter((s) => statusOf(s) === 'weak').length,
      fail: price.filter((s) => statusOf(s) === 'fail').length,
    },
    fields,
    alignedGold: aligned,
    quoteVerbatim: verbatim,
    quoteContainsValue: hasValue,
    quoteAccurate: accurate,
    checkFailures,
    statements: scored,
  };
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is zero: there was nothing to measure. */
  value: number | null;
}

export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

export interface SliceSummary {
  pages: number;
  goldClaims: number;
  priceStatements: number;
  predicted: number;
  precision: Rate;
  recall: Rate;
  verifiedPrecision: Rate;
  verifiedRecall: Rate;
  /** Verified recall over the gold claims verification can ever pass. */
  verifiedRecallOfPassable: Rate;
  recallExcludingLowConfidence: Rate;
  falsePassRate: Rate;
}

export interface Summary extends SliceSummary {
  fieldAccuracy: Record<keyof FieldTally, Rate>;
  alignedGoldRate: Rate;
  quote: { verbatim: Rate; containsValue: Rate; accurate: Rate };
  statusCounts: { pass: number; weak: number; fail: number };
  falsePasses: { count: number; byClass: Partial<Record<StatementClass, number>> };
  negativeControls: {
    pages: number;
    pagesWithPriceStatements: number;
    priceStatements: number;
    passStatements: number;
  };
  checkFailures: Record<string, { weak: number; fail: number }>;
  byCategory: Partial<Record<Category, SliceSummary>>;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function slice(scores: readonly PageScore[]): SliceSummary {
  const gold = sum(scores.map((s) => s.goldClaims));
  const lowGold = sum(scores.map((s) => s.goldLowConfidence));
  const lowMatched = sum(scores.map((s) => s.matchedGoldLowConfidence));
  const matched = sum(scores.map((s) => s.matchedGold));
  const predicted = sum(scores.map((s) => s.predicted));
  const tp = sum(scores.map((s) => s.truePositives));
  const passCounted = sum(scores.map((s) => s.passStatements));
  return {
    pages: scores.length,
    goldClaims: gold,
    priceStatements: sum(scores.map((s) => s.priceStatements)),
    predicted,
    precision: rate(tp, predicted),
    recall: rate(matched, gold),
    verifiedPrecision: rate(sum(scores.map((s) => s.verifiedTruePositives)), passCounted),
    verifiedRecall: rate(sum(scores.map((s) => s.verifiedMatchedGold)), gold),
    verifiedRecallOfPassable: rate(
      sum(scores.map((s) => s.verifiedMatchedPassable)),
      sum(scores.map((s) => s.goldPassable)),
    ),
    recallExcludingLowConfidence: rate(matched - lowMatched, gold - lowGold),
    falsePassRate: rate(
      sum(scores.map((s) => s.falsePasses)),
      sum(scores.map((s) => s.passStatementsAll)),
    ),
  };
}

const FIELD_KEYS: Array<keyof FieldTally> = [
  'entity',
  'plan',
  'subject',
  'unit',
  'usageUnit',
  'currency',
  'billingPeriod',
  'valueKind',
  'modality',
  'conditions',
];

export function summarize(scores: readonly PageScore[]): Summary {
  const base = slice(scores);
  const fieldAccuracy = Object.fromEntries(
    FIELD_KEYS.map((k) => [
      k,
      rate(sum(scores.map((s) => s.fields[k].correct)), sum(scores.map((s) => s.fields[k].total))),
    ]),
  ) as Record<keyof FieldTally, Rate>;

  const falseByClass: Partial<Record<StatementClass, number>> = {};
  const checkFailures: Record<string, { weak: number; fail: number }> = {};
  for (const s of scores) {
    for (const [k, n] of Object.entries(s.falsePassByClass) as Array<[StatementClass, number]>)
      falseByClass[k] = (falseByClass[k] ?? 0) + n;
    for (const [k, v] of Object.entries(s.checkFailures)) {
      const slot = (checkFailures[k] ??= { weak: 0, fail: 0 });
      slot.weak += v.weak;
      slot.fail += v.fail;
    }
  }
  const price = sum(scores.map((s) => s.priceStatements));
  const negatives = scores.filter((s) => s.negativeControl);
  const categories = [...new Set(scores.flatMap((s) => s.categories))].sort();
  const byCategory: Partial<Record<Category, SliceSummary>> = {};
  for (const c of categories) byCategory[c] = slice(scores.filter((s) => s.categories.includes(c)));

  return {
    ...base,
    fieldAccuracy,
    alignedGoldRate: rate(sum(scores.map((s) => s.alignedGold)), base.goldClaims),
    quote: {
      verbatim: rate(sum(scores.map((s) => s.quoteVerbatim)), price),
      containsValue: rate(sum(scores.map((s) => s.quoteContainsValue)), price),
      accurate: rate(sum(scores.map((s) => s.quoteAccurate)), price),
    },
    statusCounts: {
      pass: sum(scores.map((s) => s.statusAll.pass)),
      weak: sum(scores.map((s) => s.statusAll.weak)),
      fail: sum(scores.map((s) => s.statusAll.fail)),
    },
    falsePasses: { count: sum(scores.map((s) => s.falsePasses)), byClass: falseByClass },
    negativeControls: {
      pages: negatives.length,
      pagesWithPriceStatements: negatives.filter((s) => s.priceStatements > 0).length,
      priceStatements: sum(negatives.map((s) => s.priceStatements)),
      passStatements: sum(negatives.map((s) => s.passStatementsAll)),
    },
    checkFailures,
    byCategory,
  };
}

/** Whether a gold claim, read as a statement, satisfies a trap or ignorable condition. For dataset checks. */
export function goldClaimSatisfiesSpec(claim: GoldClaim, m: StatementMatch): boolean {
  const v = claim.value;
  if (m.amount !== undefined && !sameAmount(m.amount, v.amount)) return false;
  if (m.planNorm !== undefined && normPlan(m.planNorm) !== normPlan(claim.planNorm ?? claim.plan))
    return false;
  if (m.quoteContains !== undefined) {
    const q = normalizeText(claim.quote).toLowerCase();
    if (!m.quoteContains.every((x) => q.includes(normalizeText(x).toLowerCase()))) return false;
  }
  if (m.currency !== undefined && !m.currency.includes(v.currency)) return false;
  if (m.unit !== undefined && !m.unit.includes(v.unit)) return false;
  if (m.billingPeriod !== undefined && !m.billingPeriod.includes(v.billingPeriod)) return false;
  if (m.modality !== undefined && !m.modality.includes(claim.modality)) return false;
  return true;
}
