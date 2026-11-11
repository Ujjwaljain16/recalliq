import { describe, expect, it } from 'vitest';
import { findAmounts, markerFor } from '../../../src/evidence/currency.js';
import { outcome, raw, run } from './support.js';

/**
 * A currency code written right after an amount that has a bare symbol in front ("$ 25 USD") is an explicit
 * marker (architecture R2 table: `USD` is USD). A bare symbol on its own stays unknown.
 */
describe('a code after a bare symbol names the currency', () => {
  const marker = (text: string) => {
    const tok = findAmounts(text)[0];
    if (!tok) throw new Error('no amount');
    return markerFor(text, tok);
  };

  it('$ 25 USD resolves to USD and is not bare', () => {
    const m = marker('$ 25 USD/User/Month');
    expect(m.code).toBe('USD');
    expect(m.bare).toBe(false);
    expect(m.symbol).toBe('$');
  });

  it('keeps the other dollar currencies and the yen codes that the symbol can stand for', () => {
    expect(marker('$20 CAD per month').code).toBe('CAD');
    expect(marker('$9 AUD').code).toBe('AUD');
    expect(marker('¥5,000 JPY').code).toBe('JPY');
    expect(marker('¥300 CNY').code).toBe('CNY');
  });

  it('does not let a code the symbol cannot stand for decide: $ 25 EUR stays unknown', () => {
    const m = marker('$ 25 EUR');
    expect(m.code).toBe('unknown');
    expect(m.bare).toBe(true);
  });

  it('a bare $ with nothing after it is still unknown', () => {
    const m = marker('$25/user/month');
    expect(m.code).toBe('unknown');
    expect(m.bare).toBe(true);
  });

  it('a code that is not directly after the amount does not count', () => {
    expect(marker('$25 per user, billed in USD').code).toBe('unknown');
  });

  it('the verifier accepts USD for "$ 25 USD/User/Month" and rejects unknown for it', () => {
    const quote = '$ 25 USD/User/Month (Billed annually)';
    const base = { text: quote };
    const usd = run(
      raw(
        quote,
        {},
        {
          amount: 25,
          currency: 'USD',
          currencySymbol: '$',
          billingPeriod: 'monthly_billed_annually',
        },
      ),
      base,
    );
    expect(outcome(usd, 'currency')).toBe('pass');
    const unknown = run(
      raw(
        quote,
        {},
        {
          amount: 25,
          currency: 'unknown',
          currencySymbol: '$',
          billingPeriod: 'monthly_billed_annually',
        },
      ),
      base,
    );
    expect(outcome(unknown, 'currency')).toBe('fail');
  });

  it('the verifier still rejects USD for a bare $ without a code', () => {
    const quote = 'Pro: $90 per user per month';
    const ev = run(raw(quote, {}, { amount: 90, currency: 'USD', currencySymbol: '$' }), {
      text: quote,
    });
    expect(outcome(ev, 'currency')).toBe('fail');
  });
});
