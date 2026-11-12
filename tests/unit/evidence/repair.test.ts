import { describe, expect, it } from 'vitest';
import { RepairingVerifier } from '../../../src/evidence/repair.js';
import type { EntityContext, RawEvidence } from '../../../src/shared/index.js';
import { ACME, NOW, outcome, rawWith, snapshot, value, verifier } from './support.js';

/** Prices are [SYNTHETIC]; the layouts are the ones the live run failed on. */
const ENTITY: EntityContext = { ...ACME, plans: ['pro'], otherEntityAliases: [] };
const HEADER = '## Acme Plans & Pricing';

function check(quote: string, over: Partial<NonNullable<RawEvidence['fields']['value']>>) {
  const r = rawWith(
    quote,
    { plan: 'Pro', planNorm: 'pro', value: value(over) },
    { contextQuote: HEADER },
  );
  const s = snapshot(`${HEADER}\n${quote}`);
  return {
    plain: verifier().verify(r, s, ENTITY, 'A1', NOW),
    repaired: new RepairingVerifier(verifier()).verify(r, s, ENTITY, 'A1', NOW),
  };
}

describe('label repair after verification', () => {
  it('a monthly price billed annually that was labelled annual is kept as monthly billed annually', () => {
    const { plain, repaired } = check('Pro $ 100 USD/user/month (billed annually)', {
      amount: 100,
      currency: 'USD',
      unit: 'per_seat',
      billingPeriod: 'annual',
    });
    expect(plain.verification.status).toBe('fail');
    expect(repaired.verification.status).not.toBe('fail');
    expect(repaired.fields.value?.billingPeriod).toBe('monthly_billed_annually');
    expect(repaired.fields.value?.amount).toBe(100);
    const detail = repaired.verification.checks.find((c) => c.check === 'billing_period')?.detail;
    expect(detail).toContain('label set from the text');
  });

  it('a bare dollar sign labelled USD is kept with the currency not stated', () => {
    const { plain, repaired } = check('Pro costs $20 per user per month.', {
      amount: 20,
      currency: 'USD',
      currencySymbol: '$',
      unit: 'per_seat',
      billingPeriod: 'monthly',
    });
    expect(outcome(plain, 'currency')).toBe('fail');
    expect(repaired.verification.status).not.toBe('fail');
    expect(repaired.fields.value?.currency).toBe('unknown');
  });

  it('a seat label with no seat word on the page becomes unspecified, never another unit', () => {
    const { plain, repaired } = check('Pro costs USD 20 per month.', {
      amount: 20,
      currency: 'USD',
      currencySymbol: null,
      unit: 'per_seat',
      billingPeriod: 'monthly',
    });
    expect(outcome(plain, 'unit')).toBe('fail');
    expect(repaired.fields.value?.unit).toBe('unspecified');
  });

  it('never repairs an amount the quote does not contain', () => {
    const { plain, repaired } = check('Pro costs USD 20 per month.', {
      amount: 25,
      currency: 'USD',
      currencySymbol: null,
      unit: 'unspecified',
      billingPeriod: 'monthly',
    });
    expect(plain.verification.status).toBe('fail');
    expect(repaired.verification.status).toBe('fail');
    expect(repaired.fields.value?.amount).toBe(25);
  });
});
