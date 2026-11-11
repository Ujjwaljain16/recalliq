import { describe, expect, it } from 'vitest';
import { bindPrice } from '../../../src/evidence/binding.js';
import type { BillingPeriod, EntityContext } from '../../../src/shared/index.js';
import { ACME, outcome, raw, rawWith, run, value } from './support.js';

/**
 * Cues must be bound to the amount they follow. These are the quotes of a real page (Close), the permutations
 * that used to pass or fail wrongly, and the layouts around them. Prices are [SYNTHETIC] except the Close quote,
 * which is reproduced from the captured page.
 */

const CLOSE: EntityContext = {
  ...ACME,
  aliases: ['Close'],
  plans: ['essentials', 'growth', 'scale'],
  otherEntityAliases: [],
};
const HEADER = '## Close Plans & Pricing';
const QUOTE =
  'Current list rates (per seat) are approximately: Essentials $49/month (monthly) or $35/month (annual), Growth $109/month (monthly) or $99/month (annual), and Scale $149/month (monthly) or $139/month (annual).';

function close(plan: string, amount: number, billingPeriod: BillingPeriod, quote = QUOTE) {
  const r = rawWith(
    quote,
    {
      plan,
      planNorm: plan.toLowerCase(),
      value: value({ amount, billingPeriod }),
    },
    { contextQuote: HEADER },
  );
  return run(r, { text: `${HEADER}\n${quote}`, entity: CLOSE });
}

describe('prices with their own period cues in one quote', () => {
  const rows: Array<[string, number, number]> = [
    ['Essentials', 49, 35],
    ['Growth', 109, 99],
    ['Scale', 149, 139],
  ];

  it.each(rows)(
    'T-EV-BIND-01: %s: the monthly rate is monthly, the annual rate is monthly billed annually',
    (plan, monthly, annual) => {
      const m = close(plan, monthly, 'monthly');
      expect(outcome(m, 'billing_period')).toBe('pass');
      expect(m.verification.status).toBe('pass');
      const a = close(plan, annual, 'monthly_billed_annually');
      expect(outcome(a, 'billing_period')).toBe('pass');
      expect(a.verification.status).toBe('pass');
    },
  );

  it.each(rows)(
    'T-EV-BIND-02: %s: the annual rate can no longer be claimed as monthly',
    (plan, _monthly, annual) => {
      expect(outcome(close(plan, annual, 'monthly'), 'billing_period')).toBe('fail');
      expect(close(plan, annual, 'monthly').verification.status).toBe('fail');
    },
  );

  it.each(rows)(
    'T-EV-BIND-03: %s: the other contradicting permutations fail too',
    (plan, monthly, annual) => {
      expect(outcome(close(plan, monthly, 'monthly_billed_annually'), 'billing_period')).toBe(
        'fail',
      );
      expect(outcome(close(plan, monthly, 'annual'), 'billing_period')).toBe('fail');
      expect(outcome(close(plan, annual, 'annual'), 'billing_period')).toBe('fail');
    },
  );

  it('T-EV-BIND-04: an unspecified period still passes, and the lead-in "(per seat)" is shared by every price', () => {
    expect(outcome(close('Essentials', 35, 'unspecified'), 'billing_period')).toBe('pass');
    for (const [plan, monthly, annual] of rows) {
      expect(outcome(close(plan, monthly, 'monthly'), 'unit')).toBe('pass');
      expect(outcome(close(plan, annual, 'monthly_billed_annually'), 'unit')).toBe('pass');
    }
  });
});

describe('separators between prices', () => {
  const q =
    (text: string, entity = ACME) =>
    (plan: string, amount: number, period: BillingPeriod) =>
      run(
        rawWith(text, {
          plan,
          planNorm: plan.toLowerCase(),
          value: value({ amount, billingPeriod: period }),
        }),
        { entity },
      );

  it('T-EV-BIND-05: prices separated by commas', () => {
    const f = q(
      'Acme Starter $10 per user per month (monthly), Acme Pro $8 per user per month (annual)',
    );
    expect(outcome(f('Starter', 10, 'monthly'), 'billing_period')).toBe('pass');
    expect(outcome(f('Pro', 8, 'monthly'), 'billing_period')).toBe('fail');
    expect(outcome(f('Pro', 8, 'monthly_billed_annually'), 'billing_period')).toBe('pass');
  });

  it('T-EV-BIND-06: prices separated by "or", with a billing clause after the comma', () => {
    const f = q(
      'Acme Pro $10 per user per month, billed monthly, or $8 per user per month, billed annually',
    );
    const pro = (amount: number, period: BillingPeriod) => f('Pro', amount, period);
    expect(outcome(pro(8, 'monthly_billed_annually'), 'billing_period')).toBe('pass');
    expect(outcome(pro(8, 'monthly'), 'billing_period')).toBe('fail');
    expect(outcome(pro(10, 'monthly'), 'billing_period')).toBe('pass');
    expect(outcome(pro(10, 'monthly_billed_annually'), 'billing_period')).toBe('fail');
  });

  it('T-EV-BIND-07: an amount with no cue of its own while another price has one is weak, never pass', () => {
    const text = 'Acme Starter $20, Acme Pro $90 per user per month';
    const claim = (plan: string, amount: number) =>
      run(
        rawWith(text, {
          plan,
          planNorm: plan.toLowerCase(),
          value: value({
            amount,
            billingPeriod: 'monthly',
            unit: plan === 'Starter' ? 'unspecified' : 'per_seat',
          }),
        }),
      );
    const starter = claim('Starter', 20);
    expect(outcome(starter, 'billing_period')).toBe('weak');
    expect(starter.verification.status).toBe('weak');
    expect(outcome(claim('Pro', 90), 'billing_period')).toBe('pass');
  });

  it('T-EV-BIND-08: the same amount twice with different cues is weak', () => {
    const f = q('Acme Pro $20 per user per month (monthly) or $20 per user per month (annual)');
    expect(outcome(f('Pro', 20, 'monthly'), 'billing_period')).toBe('weak');
  });
});

describe('cues placed before the amount, and tables', () => {
  const row = (text: string, plan: string, amount: number, period: BillingPeriod) =>
    run(
      rawWith(text, {
        plan,
        planNorm: plan.toLowerCase(),
        value: value({ amount, billingPeriod: period }),
      }),
      { entity: CLOSE },
    );

  it('T-EV-BIND-09: a label-first row with one price is judged as before', () => {
    const t = '| Close Essentials | monthly | $49 |';
    expect(outcome(row(t, 'Essentials', 49, 'monthly'), 'billing_period')).toBe('pass');
    expect(outcome(row(t, 'Essentials', 49, 'annual'), 'billing_period')).toBe('fail');
  });

  it('T-EV-BIND-10: a label-first row with two prices gives each price its own label', () => {
    const t = '| Close Essentials | monthly | $49 | annual | $35 |';
    expect(outcome(row(t, 'Essentials', 49, 'monthly'), 'billing_period')).toBe('pass');
    expect(outcome(row(t, 'Essentials', 35, 'annual'), 'billing_period')).toBe('pass');
    expect(outcome(row(t, 'Essentials', 35, 'monthly'), 'billing_period')).toBe('fail');
    expect(outcome(row(t, 'Essentials', 49, 'annual'), 'billing_period')).toBe('fail');
  });

  it('T-EV-BIND-11: a value-first row gives each price the cue after it', () => {
    const t = '| Close Essentials | $49 | monthly | $35 | annual |';
    expect(outcome(row(t, 'Essentials', 49, 'monthly'), 'billing_period')).toBe('pass');
    expect(outcome(row(t, 'Essentials', 35, 'annual'), 'billing_period')).toBe('pass');
    expect(outcome(row(t, 'Essentials', 35, 'monthly'), 'billing_period')).toBe('fail');
  });

  it('T-EV-BIND-12: a cue-only cell between two prices whose layout is unclear is weak for both', () => {
    const t = '| Close Essentials | $49 | monthly | $35 |';
    expect(outcome(row(t, 'Essentials', 49, 'monthly'), 'billing_period')).toBe('weak');
    expect(outcome(row(t, 'Essentials', 35, 'monthly'), 'billing_period')).toBe('weak');
  });
});

describe('single-price quotes are judged as before', () => {
  it('T-EV-BIND-13: the period and unit checks of a one-price quote are unchanged', () => {
    const q = 'Acme Pro $90 per user per month, billed annually';
    expect(bindPrice(q, q.indexOf('90'))).toBeNull();
    const ok = run(raw(q, {}, { billingPeriod: 'monthly_billed_annually' }));
    expect(outcome(ok, 'billing_period')).toBe('pass');
    expect(outcome(run(raw(q, {}, { billingPeriod: 'monthly' })), 'billing_period')).toBe('fail');
    expect(outcome(run(raw(q, {}, { billingPeriod: 'annual' })), 'billing_period')).toBe('fail');
    expect(
      outcome(run(raw(q, {}, { billingPeriod: 'monthly_billed_annually', unit: 'flat' })), 'unit'),
    ).toBe('fail');
  });

  it('T-EV-BIND-14: a percentage is not a second price', () => {
    const q = 'Acme Pro $90 per user per month, save 20% when billed annually';
    expect(bindPrice(q, q.indexOf('90'))).toBeNull();
  });
});

describe('unit cues belong to their price too', () => {
  const entity: EntityContext = { ...ACME, plans: ['seats', 'platform'] };
  const text = 'Acme Seats $20 per user per month; Acme Platform $500 flat fee per month';
  const claim = (plan: string, amount: number, unit: 'per_seat' | 'flat') =>
    run(
      rawWith(text, {
        plan,
        planNorm: plan.toLowerCase(),
        value: value({ amount, unit, billingPeriod: 'monthly' }),
      }),
      { entity },
    );

  it('T-EV-BIND-15: a seat marker on another price does not make this one per seat, nor stop it being flat', () => {
    expect(outcome(claim('Platform', 500, 'per_seat'), 'unit')).toBe('fail');
    expect(outcome(claim('Platform', 500, 'flat'), 'unit')).toBe('pass');
    expect(outcome(claim('Seats', 20, 'per_seat'), 'unit')).toBe('pass');
    expect(outcome(claim('Seats', 20, 'flat'), 'unit')).toBe('fail');
  });
});
