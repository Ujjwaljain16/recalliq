import { createHash } from 'node:crypto';
import { registrableDomain } from '../evidence/authority.js';
import type { Arrangement, PriceBeliefKey, ReleaseKey } from '../shared/belief.js';
import type { BillingPeriod, NormalizedValue, Unit, VerifiedEvidence } from '../shared/evidence.js';
import { parseId } from '../shared/ids.js';
import { deriveLocale } from './locale.js';

/**
 * Belief keys (ADR-21, ADR-37). One canonical string per key, produced by one function:
 * `price:v1|e=<entity>|p=<plan>|a=<arrangement>|c=<hash|->|u=<unit>|uu=<usageUnit|->|b=<billing>|cur=<currency>|loc=<locale>|vk=<valueKind>`
 */

const ARRANGEMENTS: readonly Arrangement[] = ['list', 'conditional', 'promotional', 'planned'];
const UNITS: readonly Unit[] = ['per_seat', 'flat', 'usage', 'unspecified'];
const PERIODS: readonly BillingPeriod[] = [
  'monthly',
  'annual',
  'monthly_billed_annually',
  'one_time',
  'unspecified',
];
const VALUE_KINDS: readonly NormalizedValue['valueKind'][] = [
  'exact',
  'lower_bound',
  'upper_bound',
];

function escapeField(v: string): string {
  return v.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/=/g, '%3D');
}
function unescapeField(v: string): string {
  return v.replace(/%3D/g, '=').replace(/%7C/g, '|').replace(/%25/g, '%');
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function normalizeConditions(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizePlan(plan: string): string {
  return plan.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeUsageUnit(unit: string): string {
  return unit
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-');
}

export function encodePriceKey(k: PriceBeliefKey): string {
  return [
    'price:v1',
    `e=${escapeField(k.entityId)}`,
    `p=${escapeField(k.plan)}`,
    `a=${k.arrangement}`,
    `c=${k.conditionHash ?? '-'}`,
    `u=${k.unit}`,
    `uu=${k.usageUnit === null ? '-' : escapeField(k.usageUnit)}`,
    `b=${k.billingPeriod}`,
    `cur=${escapeField(k.currency)}`,
    `loc=${k.locale}`,
    `vk=${k.valueKind}`,
  ].join('|');
}

function oneOf<T extends string>(values: readonly T[], v: string, what: string): T {
  const hit = values.find((x) => x === v);
  if (hit === undefined) throw new Error(`Invalid belief key: ${what} "${v}"`);
  return hit;
}

/** Throws on anything that is not exactly what `encodePriceKey` would produce. */
export function decodePriceKey(s: string): PriceBeliefKey {
  const parts = s.split('|');
  if (parts[0] !== 'price:v1' || parts.length !== 11) throw new Error('Invalid belief key: shape');
  const names = ['e', 'p', 'a', 'c', 'u', 'uu', 'b', 'cur', 'loc', 'vk'];
  const values = names.map((name, i) => {
    const part = parts[i + 1] ?? '';
    const prefix = `${name}=`;
    if (!part.startsWith(prefix)) throw new Error(`Invalid belief key: expected "${name}="`);
    return part.slice(prefix.length);
  });
  const [e, p, a, c, u, uu, b, cur, loc, vk] = values as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const key: PriceBeliefKey = {
    kind: 'price',
    version: 1,
    entityId: parseId('ent', unescapeField(e)),
    plan: unescapeField(p),
    arrangement: oneOf(ARRANGEMENTS, a, 'arrangement'),
    conditionHash: c === '-' ? null : c,
    unit: oneOf(UNITS, u, 'unit'),
    usageUnit: uu === '-' ? null : unescapeField(uu),
    billingPeriod: oneOf(PERIODS, b, 'billing period'),
    currency: unescapeField(cur),
    locale: loc,
    valueKind: oneOf(VALUE_KINDS, vk, 'value kind'),
  };
  if (key.conditionHash !== null && !/^[0-9a-f]{40}$/.test(key.conditionHash))
    throw new Error('Invalid belief key: condition hash');
  if (!/^[A-Z]{3}$/.test(key.currency) && !/^unknown@[a-z0-9.-]+$/.test(key.currency))
    throw new Error('Invalid belief key: currency');
  if (key.locale !== 'und' && Intl.getCanonicalLocales(key.locale)[0] !== key.locale)
    throw new Error('Invalid belief key: locale');
  if (encodePriceKey(key) !== s) throw new Error('Invalid belief key: not canonical');
  return key;
}

const ARRANGEMENT_OF: Partial<Record<VerifiedEvidence['modality'], Arrangement>> = {
  current: 'list',
  conditional: 'conditional',
  promotional: 'promotional',
  planned: 'planned',
};

/**
 * The key a price statement belongs to, or null. Historical and negated statements and non-price
 * statements have no key. The locale comes from the source URL.
 */
export function keyForEvidence(
  e: Omit<VerifiedEvidence, 'beliefKey'>,
  source: { domain: string; urlNorm: string },
): string | null {
  const value = e.fields.value;
  if (e.kind !== 'price' || value === null || e.polarity !== 'affirmed') return null;
  const arrangement = ARRANGEMENT_OF[e.modality];
  if (arrangement === undefined) return null;
  let conditionHash: string | null = null;
  if (arrangement === 'conditional' || arrangement === 'promotional') {
    const cond = e.fields.conditions === null ? '' : normalizeConditions(e.fields.conditions);
    if (cond.length === 0) return null;
    conditionHash = sha1(cond);
  }
  const key: PriceBeliefKey = {
    kind: 'price',
    version: 1,
    entityId: e.entityId,
    plan:
      e.fields.planNorm === null
        ? 'unspecified'
        : normalizePlan(e.fields.planNorm) || 'unspecified',
    arrangement,
    conditionHash,
    unit: value.unit,
    usageUnit: value.usageUnit === null ? null : normalizeUsageUnit(value.usageUnit),
    billingPeriod: value.billingPeriod,
    currency:
      value.currency === 'unknown' ? `unknown@${registrableDomain(source.domain)}` : value.currency,
    locale: deriveLocale(source.urlNorm),
    valueKind: value.valueKind,
  };
  return encodePriceKey(key);
}

/** `release:v1|e=<entity>|t=<sha1(normalised title)>`. Releases are an event log, not single-valued beliefs. */
export function encodeReleaseKey(k: ReleaseKey): string {
  return `release:v1|e=${escapeField(k.entityId)}|t=${k.titleHash}`;
}

export function releaseKeyForEvidence(
  e: Pick<VerifiedEvidence, 'kind' | 'entityId' | 'fields' | 'polarity'>,
): string | null {
  const title = e.fields.releaseTitle;
  if (e.kind !== 'release' || e.polarity !== 'affirmed' || !title) return null;
  return encodeReleaseKey({
    kind: 'release',
    version: 1,
    entityId: e.entityId,
    titleHash: sha1(normalizeConditions(title)),
  });
}

/** The `planned` key that shadows a list key: same dimensions, arrangement planned. */
export function plannedTwinKey(listKey: string): string {
  const k = decodePriceKey(listKey);
  return encodePriceKey({ ...k, arrangement: 'planned', conditionHash: null });
}

/**
 * ADR-37. `equal`: identical in every dimension, locale included. `comparable`: same entity, arrangement,
 * conditions and locale, differing only where one side is `unspecified` (plan, unit, billing period), where
 * a currency is `unknown@…` against a known one, or in value kind. Anything else, and any difference of
 * locale (`und` included), is `different`.
 */
export function comparableKeys(
  a: PriceBeliefKey,
  b: PriceBeliefKey,
): 'equal' | 'comparable' | 'different' {
  if (encodePriceKey(a) === encodePriceKey(b)) return 'equal';
  if (a.entityId !== b.entityId) return 'different';
  if (a.locale !== b.locale) return 'different';
  if (a.arrangement !== b.arrangement || a.conditionHash !== b.conditionHash) return 'different';
  if (a.plan !== b.plan && a.plan !== 'unspecified' && b.plan !== 'unspecified') return 'different';
  if (a.unit !== b.unit) {
    if (a.unit !== 'unspecified' && b.unit !== 'unspecified') return 'different';
  } else if (a.usageUnit !== b.usageUnit) return 'different';
  if (
    a.billingPeriod !== b.billingPeriod &&
    a.billingPeriod !== 'unspecified' &&
    b.billingPeriod !== 'unspecified'
  )
    return 'different';
  if (a.currency !== b.currency) {
    const ua = a.currency.startsWith('unknown@');
    const ub = b.currency.startsWith('unknown@');
    // Two unknown currencies of different sources, or two different known ones, never merge.
    if (ua === ub) return 'different';
  }
  return 'comparable';
}
