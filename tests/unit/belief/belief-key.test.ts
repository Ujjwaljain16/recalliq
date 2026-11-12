import { describe, expect, it } from 'vitest';
import {
  comparableKeys,
  decodePriceKey,
  encodePriceKey,
  plannedTwinKey,
  sha1,
} from '../../../src/belief/belief-key.js';
import { deriveLocale } from '../../../src/belief/locale.js';
import type { PriceBeliefKey } from '../../../src/shared/index.js';
import { ev, LIST_KEY } from './support.js';

function key(over: Partial<PriceBeliefKey> = {}): PriceBeliefKey {
  return {
    kind: 'price',
    version: 1,
    entityId: 'ent_acme',
    plan: 'pro',
    arrangement: 'list',
    conditionHash: null,
    unit: 'per_seat',
    usageUnit: null,
    billingPeriod: 'monthly',
    currency: 'USD',
    locale: 'en-GB',
    valueKind: 'exact',
    ...over,
  };
}

describe('price key encoding', () => {
  it('T-KEY-01: encodes in the canonical field order with the locale after the currency', () => {
    expect(encodePriceKey(key())).toBe(
      'price:v1|e=ent_acme|p=pro|a=list|c=-|u=per_seat|uu=-|b=monthly|cur=USD|loc=en-GB|vk=exact',
    );
  });

  it('T-KEY-02: round-trips, including locale, escaped plan text and a condition hash', () => {
    const keys = [
      key(),
      key({ locale: 'und', currency: 'unknown@acme.example' }),
      key({ plan: 'a|b=c%', usageUnit: 'gb-month', unit: 'usage' }),
      key({ arrangement: 'promotional', conditionHash: sha1('first year') }),
      key({ locale: 'de-DE', valueKind: 'lower_bound', billingPeriod: 'monthly_billed_annually' }),
    ];
    for (const k of keys) expect(decodePriceKey(encodePriceKey(k))).toEqual(k);
  });

  it('T-KEY-03: decoding throws on anything that is not canonical', () => {
    const good = encodePriceKey(key());
    for (const bad of [
      good.replace('price:v1', 'price:v2'),
      good.replace('a=list', 'a=LIST'),
      good.replace('loc=en-GB', 'loc=en_GB'),
      good.replace('loc=en-GB', 'loc=en-gb'),
      good.replace('|vk=exact', ''),
      `${good}|x=1`,
      good.replace('cur=USD', 'cur=usd'),
      good.replace('c=-', 'c=abc'),
      'release:v1|e=ent_acme|t=abc',
    ])
      expect(() => decodePriceKey(bad)).toThrow();
  });
});

describe('keyForEvidence', () => {
  it('T-KEY-04: modality maps to arrangement; historical, negated and non-price have no key', () => {
    const arr = (m: Parameters<typeof ev>[0]['modality'], conditions: string | null = null) => {
      const k = ev({ id: 'k', modality: m, conditions }).beliefKey;
      return k === null ? null : decodePriceKey(k).arrangement;
    };
    expect(arr('current')).toBe('list');
    expect(arr('planned')).toBe('planned');
    expect(arr('conditional', 'if 10 seats')).toBe('conditional');
    expect(arr('promotional', '20% off')).toBe('promotional');
    expect(arr('historical')).toBeNull();
    expect(ev({ id: 'n', polarity: 'negated' }).beliefKey).toBeNull();
  });

  it('T-KEY-05: promotional and conditional keys need conditions and differ per condition', () => {
    expect(ev({ id: 'a', modality: 'promotional', conditions: null }).beliefKey).toBeNull();
    const a = ev({ id: 'a', modality: 'promotional', conditions: '20% off' }).beliefKey;
    const b = ev({ id: 'b', modality: 'promotional', conditions: '  20%   OFF ' }).beliefKey;
    const c = ev({ id: 'c', modality: 'promotional', conditions: 'first month free' }).beliefKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(LIST_KEY);
  });

  it('T-KEY-06: an unknown currency is scoped to its registrable source domain', () => {
    const a = ev({
      id: 'a',
      value: { currency: 'unknown' },
      domain: 'pricing.acme.example',
    }).beliefKey;
    const b = ev({ id: 'b', value: { currency: 'unknown' }, domain: 'acme.example' }).beliefKey;
    const other = ev({
      id: 'c',
      value: { currency: 'unknown' },
      domain: 'other.example',
    }).beliefKey;
    expect(a).toBe(b);
    expect(a).toContain('cur=unknown@acme.example');
    expect(other).toContain('cur=unknown@other.example');
    expect(comparableKeys(decodePriceKey(a ?? ''), decodePriceKey(other ?? ''))).toBe('different');
  });

  it('T-KEY-07: the locale comes from the source URL', () => {
    const gb = ev({ id: 'a', urlNorm: 'acme.example/en-gb/pricing' }).beliefKey ?? '';
    const us = ev({ id: 'b', urlNorm: 'acme.example/en-us/pricing' }).beliefKey ?? '';
    const none = ev({ id: 'c', urlNorm: 'acme.example/pricing' }).beliefKey ?? '';
    expect(gb).toContain('loc=en-GB');
    expect(us).toContain('loc=en-US');
    expect(none).toContain('loc=und');
  });

  it('T-KEY-08: the planned twin shares every dimension but the arrangement', () => {
    const twin = decodePriceKey(plannedTwinKey(LIST_KEY));
    expect(twin).toEqual({ ...decodePriceKey(LIST_KEY), arrangement: 'planned' });
  });
});

describe('comparableKeys (ADR-37)', () => {
  it('T-KEY-09: identical keys are equal, "und" included', () => {
    expect(comparableKeys(key(), key())).toBe('equal');
    expect(comparableKeys(key({ locale: 'und' }), key({ locale: 'und' }))).toBe('equal');
  });

  it('T-KEY-10: different locales are different, including und against a known locale', () => {
    expect(comparableKeys(key({ locale: 'en-GB' }), key({ locale: 'en-US' }))).toBe('different');
    expect(comparableKeys(key({ locale: 'und' }), key({ locale: 'en-GB' }))).toBe('different');
    expect(comparableKeys(key({ locale: 'en-GB' }), key({ locale: 'en' }))).toBe('different');
  });

  it('T-KEY-11: a value kind, an unspecified plan, unit or period, or an unknown currency is comparable', () => {
    expect(comparableKeys(key(), key({ valueKind: 'lower_bound' }))).toBe('comparable');
    expect(comparableKeys(key(), key({ plan: 'unspecified' }))).toBe('comparable');
    expect(comparableKeys(key(), key({ unit: 'unspecified' }))).toBe('comparable');
    expect(comparableKeys(key(), key({ billingPeriod: 'unspecified' }))).toBe('comparable');
    expect(comparableKeys(key(), key({ currency: 'unknown@acme.example' }))).toBe('comparable');
  });

  it('T-KEY-12: monthly against annual, another plan, arrangement, entity or currency is different', () => {
    expect(comparableKeys(key(), key({ billingPeriod: 'annual' }))).toBe('different');
    expect(comparableKeys(key(), key({ plan: 'starter' }))).toBe('different');
    expect(comparableKeys(key(), key({ arrangement: 'planned' }))).toBe('different');
    expect(comparableKeys(key(), key({ entityId: 'ent_beta' }))).toBe('different');
    expect(comparableKeys(key(), key({ currency: 'EUR' }))).toBe('different');
    expect(comparableKeys(key({ unit: 'per_seat' }), key({ unit: 'flat' }))).toBe('different');
    expect(
      comparableKeys(
        key({ unit: 'usage', usageUnit: 'gb' }),
        key({ unit: 'usage', usageUnit: 'hour' }),
      ),
    ).toBe('different');
    expect(
      comparableKeys(
        key({ currency: 'unknown@a.example' }),
        key({ currency: 'unknown@b.example' }),
      ),
    ).toBe('different');
  });
});

describe('locale derivation', () => {
  it.each([
    ['acme.example/en-gb/pricing', 'en-GB'],
    ['acme.example/en_US/pricing', 'en-US'],
    ['https://acme.example/de/preise', 'de'],
    ['https://fr.acme.example/pricing', 'fr'],
    ['https://en-gb.acme.example/pricing', 'en-GB'],
    ['acme.example/pricing?lang=pt-br', 'pt-BR'],
    ['acme.example/pricing?hl=ja', 'ja'],
    ['acme.example/pricing', 'und'],
    ['acme.example/uk/pricing', 'und'],
    ['acme.example/products/pricing', 'und'],
    ['acme.example/pricing?utm_source=x', 'und'],
    ['acme.example/en-gb/pricing?lang=de', 'und'],
    ['acme.example/xx-yy/pricing', 'und'],
    ['not a url at all', 'und'],
  ])('T-KEY-13: %s is %s', (url, expected) => {
    expect(deriveLocale(url)).toBe(expected);
  });
});
