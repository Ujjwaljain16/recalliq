import { describe, expect, it } from 'vitest';
import { ACME, NOW, outcome, raw, rawWith, run, snapshot, value, verifier } from './support.js';

const BASE = 'Acme Pro $90 per user per month';

describe('T0 citation integrity', () => {
  it('T-EV-T0-01: a citation to a snapshot that was not supplied fails', () => {
    const r = raw(BASE, { snapshotRef: 'src_other' });
    const ev = run(r, { text: BASE });
    expect(ev.verification.status).toBe('fail');
    expect(ev.beliefKey).toBeNull();
  });

  it('T-EV-T0-02: a citation to another entity fails', () => {
    const ev = run(raw(BASE, { entityRef: 'ent_beta' }));
    expect(ev.verification.status).toBe('fail');
  });
});

describe('T1 verbatim quote and context grounding', () => {
  it('T-EV-T1-01: a verbatim quote passes', () => {
    expect(outcome(run(raw(BASE)), 'quote_verbatim')).toBe('pass');
  });

  it('T-EV-T1-02: a paraphrased quote fails and nothing else is trusted', () => {
    const ev = run(raw('Acme Pro costs $90 per user monthly'), { text: BASE });
    expect(outcome(ev, 'quote_verbatim')).toBe('fail');
    expect(ev.verification.status).toBe('fail');
  });

  it('T-EV-T1-03: a quote with a changed digit fails (digits are never folded)', () => {
    const ev = run(raw('Acme Pro $80 per user per month'), { text: BASE });
    expect(outcome(ev, 'quote_verbatim')).toBe('fail');
  });

  it('T-EV-T1-04: a quote that starts inside a number fails', () => {
    const ev = run(raw('Acme Pro $90 per user per month'), {
      text: 'Acme Pro $190 per user per month',
    });
    expect(outcome(ev, 'quote_verbatim')).toBe('fail');
    const ev2 = run(raw('$90 per user'), { text: 'Acme Pro $900 per user' });
    expect(outcome(ev2, 'quote_verbatim')).toBe('fail');
  });

  it('T-EV-T1-05: a quote that drops a currency prefix fails', () => {
    const clipped = run(raw('$90 per user per month'), {
      text: 'Acme Pro US$90 per user per month',
    });
    expect(outcome(clipped, 'quote_verbatim')).toBe('fail');
  });

  it('T-EV-T1-06: a dropped negation fails', () => {
    const ev = run(raw('Acme Pro is available at $90 per user per month'), {
      text: 'Acme Pro is not available at $90 per user per month',
    });
    expect(outcome(ev, 'quote_verbatim')).toBe('fail');
  });

  it('T-EV-T1-07: whitespace, curly quotes and non-breaking spaces are tolerated', () => {
    const text = 'Acme Pro   $90 per user\nper month';
    const ev = run(raw('Acme Pro $90 per user per month'), { text });
    expect(outcome(ev, 'quote_verbatim')).toBe('pass');
  });

  it('T-EV-T1-08: an over-long quote or context fails', () => {
    const long = `Acme Pro $90 per user per month ${'x '.repeat(220)}`;
    expect(outcome(run(raw(long)), 'quote_verbatim')).toBe('fail');
    const ev = run(raw(BASE, { contextQuote: 'Acme '.repeat(50) }), {
      text: `${'Acme '.repeat(50)}\n${BASE}`,
    });
    expect(outcome(ev, 'context_verbatim')).toBe('fail');
  });

  it('T-EV-T1-09: a context that is not in the snapshot fails', () => {
    const ev = run(raw(BASE, { contextQuote: 'Plans for Acme' }), { text: BASE });
    expect(outcome(ev, 'context_verbatim')).toBe('fail');
  });
});

describe('context association', () => {
  it('T-EV-CTX-01: a header above the quote is associated', () => {
    const text = '## Acme plans\nPro | $90 per user per month';
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'context_association')).toBe('pass');
  });

  it('T-EV-CTX-02: a header after the quote is not associated', () => {
    const text = 'Pro | $90 per user per month\n## Acme plans';
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'context_association')).toBe('weak');
  });

  it('T-EV-CTX-03: a header more than 1,500 characters above is not associated', () => {
    const text = `## Acme plans\n${'filler text here. '.repeat(120)}\nPro | $90 per user per month`;
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'context_association')).toBe('weak');
  });

  it('T-EV-CTX-04: another entity heading in between breaks the association', () => {
    const text = '## Acme plans\n## Beta Suite\nPro | $90 per user per month';
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'context_association')).toBe('weak');
    expect(ev.verification.status).not.toBe('pass');
  });
});

describe('subject binding and competitor attribution', () => {
  it('T-EV-SUBJ-01: an alias in the value segment passes', () => {
    const ev = run(raw(BASE));
    expect(outcome(ev, 'subject_binding')).toBe('pass');
    expect(ev.verification.status).toBe('pass');
    expect(ev.beliefKey).not.toBeNull();
  });

  it('T-EV-SUBJ-02: an alias in an associated header passes', () => {
    const text = '## Acme plans\nPro | $90 per user per month';
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'subject_binding')).toBe('pass');
    expect(ev.verification.status).toBe('pass');
  });

  it('T-EV-SUBJ-03: a title that names the entity cannot attribute a price', () => {
    const ev = run(raw('Pro $90 per user per month'), { snap: { title: 'Acme pricing' } });
    expect(outcome(ev, 'subject_binding')).toBe('weak');
    expect(ev.verification.status).toBe('weak');
    expect(ev.beliefKey).toBeNull();
  });

  it('T-EV-SUBJ-04: the URL or an official domain alone cannot attribute a price', () => {
    const ev = run(raw('Pro $90 per user per month'), {
      snap: { url: 'https://acme.example/acme-pricing', title: null },
    });
    expect(outcome(ev, 'subject_binding')).toBe('weak');
    expect(ev.verification.status).not.toBe('pass');
  });

  it('T-EV-SUBJ-05: a competitor closest to the value fails', () => {
    const text = 'Acme is popular, but Beta Pro costs $90 per user per month';
    const ev = run(raw('Acme is popular, but Beta Pro costs $90 per user per month'), { text });
    expect(outcome(ev, 'competitor_attribution')).toBe('fail');
    expect(outcome(ev, 'subject_binding')).toBe('fail');
    expect(ev.verification.status).toBe('fail');
  });

  it('T-EV-SUBJ-06: our entity closest to the value passes even when a competitor is mentioned', () => {
    const q = 'Compared to Beta, Acme Pro costs $90 per user per month';
    const ev = run(raw(q));
    expect(outcome(ev, 'competitor_attribution')).toBe('pass');
    expect(ev.verification.status).toBe('pass');
  });

  it('T-EV-SUBJ-07: a comparison sentence attributes each price to its own vendor', () => {
    const q = 'Acme Pro $90 per user per month vs Beta Pro $120 per user per month';
    const beta = run(raw(q, {}, { amount: 120 }));
    expect(outcome(beta, 'competitor_attribution')).toBe('fail');
    const acme = run(raw(q));
    expect(outcome(acme, 'competitor_attribution')).toBe('pass');
  });

  it('T-EV-SUBJ-08: an alias in a header that is not associated gives weak', () => {
    const text = '## Acme plans\nfiller\n## Beta Suite\nPro | $90 per user per month';
    const ev = run(raw('Pro | $90 per user per month', { contextQuote: '## Acme plans' }), {
      text,
    });
    expect(outcome(ev, 'subject_binding')).toBe('weak');
  });

  it('T-EV-SUBJ-09: no entity alias anywhere near the value gives weak, never pass', () => {
    const ev = run(raw('Pro $90 per user per month'), { snap: { title: null } });
    expect(ev.verification.status).toBe('weak');
  });

  it('T-EV-SUBJ-10: a planted price on a page that names a competitor is not attributed to us', () => {
    const text = 'Acme Pro, the market leader. Beta CRM Pro: $5 per user per month';
    const ev = run(raw('Beta CRM Pro: $5 per user per month', {}, { amount: 5 }), { text });
    expect(ev.verification.status).not.toBe('pass');
  });
});

describe('currency', () => {
  const cases: Array<[string, string, string, string, 'pass' | 'fail']> = [
    ['T-EV-CUR-01', 'Acme Pro US$90 per user per month', 'USD', '$', 'pass'],
    ['T-EV-CUR-02', 'Acme Pro A$90 per user per month', 'AUD', '$', 'pass'],
    ['T-EV-CUR-03', 'Acme Pro C$90 per user per month', 'CAD', '$', 'pass'],
    ['T-EV-CUR-04', 'Acme Pro €90 per user per month', 'EUR', '€', 'pass'],
    ['T-EV-CUR-05', 'Acme Pro £90 per user per month', 'GBP', '£', 'pass'],
    ['T-EV-CUR-06', 'Acme Pro 90 CHF per user per month', 'CHF', 'CHF', 'pass'],
    ['T-EV-CUR-07', 'Acme Pro $90 per user per month', 'unknown', '$', 'pass'],
    ['T-EV-CUR-08', 'Acme Pro $90 per user per month', 'USD', '$', 'fail'],
    ['T-EV-CUR-09', 'Acme Pro A$90 per user per month', 'USD', '$', 'fail'],
    ['T-EV-CUR-10', 'Acme Pro CA$90 per user per month', 'AUD', '$', 'fail'],
    ['T-EV-CUR-11', 'Acme Pro ¥90 per user per month', 'JPY', '¥', 'fail'],
    ['T-EV-CUR-12', 'Acme Pro ¥90 per user per month', 'unknown', '¥', 'pass'],
  ];
  it.each(cases)('%s: %s as %s is %s', (_id, quote, currency, symbol, expected) => {
    const ev = run(raw(quote, {}, { currency, currencySymbol: symbol }));
    expect(outcome(ev, 'currency')).toBe(expected);
  });

  it('T-EV-CUR-13: a bare $ with a declaration in the associated header resolves', () => {
    const text = '## Acme prices (All prices in USD)\nPro | $90 per user per month';
    const ev = run(
      raw(
        'Pro | $90 per user per month',
        { contextQuote: '## Acme prices (All prices in USD)' },
        { currency: 'USD' },
      ),
      { text },
    );
    expect(outcome(ev, 'currency')).toBe('pass');
    expect(ev.fields.value?.currency).toBe('USD');
    const bad = run(
      raw(
        'Pro | $90 per user per month',
        { contextQuote: '## Acme prices (All prices in USD)' },
        { currency: 'unknown' },
      ),
      { text },
    );
    expect(outcome(bad, 'currency')).toBe('fail');
  });

  it('T-EV-CUR-14: a declaration of euros does not make a bare $ euros', () => {
    const text = '## Acme plans (All prices in EUR)\nPro | $90 per user per month';
    const ev = run(
      raw(
        'Pro | $90 per user per month',
        { contextQuote: '## Acme plans (All prices in EUR)' },
        { currency: 'EUR' },
      ),
      { text },
    );
    expect(outcome(ev, 'currency')).toBe('fail');
  });

  it('T-EV-CUR-15: an amount with no adjacent currency marker is weak, not a price', () => {
    const ev = run(
      raw(
        'Acme Pro for 90 users',
        {},
        {
          currency: 'unknown',
          currencySymbol: null,
          unit: 'unspecified',
          billingPeriod: 'unspecified',
        },
      ),
    );
    expect(outcome(ev, 'value_presence')).toBe('weak');
    expect(ev.verification.status).toBe('weak');
  });

  it('T-EV-CUR-16: a percentage is not the price', () => {
    const ev = run(raw('Acme Pro save 90% on $120 per user per month', {}, { amount: 90 }));
    expect(outcome(ev, 'value_presence')).toBe('fail');
  });
});

describe('unit', () => {
  const q = (tail: string) => `Acme Pro $90 ${tail}`;
  it('T-EV-UNIT-01: per_seat with a seat marker passes', () => {
    expect(outcome(run(raw(q('per user per month'))), 'unit')).toBe('pass');
  });
  it('T-EV-UNIT-02: per_seat without a marker fails', () => {
    expect(outcome(run(raw(q('per month'))), 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-03: no seat language is never flat', () => {
    expect(outcome(run(raw(q('per month'), {}, { unit: 'flat' })), 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-04: "per account" makes flat', () => {
    expect(outcome(run(raw(q('per account per month'), {}, { unit: 'flat' })), 'unit')).toBe(
      'pass',
    );
  });
  it('T-EV-UNIT-05: flat claimed on per-seat text fails', () => {
    expect(outcome(run(raw(q('per user per month'), {}, { unit: 'flat' })), 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-06: no marker means unspecified', () => {
    const ev = run(raw(q('per month'), {}, { unit: 'unspecified' }));
    expect(outcome(ev, 'unit')).toBe('pass');
    expect(ev.verification.status).toBe('pass');
  });
  it('T-EV-UNIT-07: usage with a metered marker and the unit in the text passes', () => {
    const ev = run(
      raw(
        q('per GB-month'),
        {},
        { unit: 'usage', usageUnit: 'gb-month', billingPeriod: 'unspecified' },
      ),
    );
    expect(outcome(ev, 'unit')).toBe('pass');
  });
  it('T-EV-UNIT-08: usage without a metered marker fails', () => {
    const ev = run(raw(q('per month'), {}, { unit: 'usage', usageUnit: 'gb-month' }));
    expect(outcome(ev, 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-09: usage without a usage unit fails', () => {
    const ev = run(
      raw(q('per GB'), {}, { unit: 'usage', usageUnit: null, billingPeriod: 'unspecified' }),
    );
    expect(outcome(ev, 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-10: a usage unit that is not in the text fails', () => {
    const ev = run(
      raw(q('per GB'), {}, { unit: 'usage', usageUnit: 'vcpu-hour', billingPeriod: 'unspecified' }),
    );
    expect(outcome(ev, 'unit')).toBe('fail');
  });
  it('T-EV-UNIT-11: a usage unit on a non-usage price fails', () => {
    expect(outcome(run(raw(q('per user per month'), {}, { usageUnit: 'gb' })), 'unit')).toBe(
      'fail',
    );
  });
});

describe('billing period', () => {
  const q = (tail: string) => `Acme Pro $90 per user ${tail}`;
  it.each([
    ['T-EV-BILL-01', 'per month', 'monthly', 'pass'],
    ['T-EV-BILL-02', 'per year', 'annual', 'pass'],
    ['T-EV-BILL-03', 'per month, billed annually', 'monthly_billed_annually', 'pass'],
    ['T-EV-BILL-04', 'per month, billed annually', 'monthly', 'fail'],
    ['T-EV-BILL-05', 'per month, billed annually', 'annual', 'fail'],
    ['T-EV-BILL-06', 'per year', 'monthly', 'fail'],
    ['T-EV-BILL-07', 'per month', 'monthly_billed_annually', 'fail'],
    ['T-EV-BILL-08', 'per month', 'unspecified', 'pass'],
    ['T-EV-BILL-09', 'one-time', 'one_time', 'pass'],
    ['T-EV-BILL-10', 'per user', 'one_time', 'fail'],
  ] as const)('%s: "%s" as %s is %s', (_id, tail, period, expected) => {
    const ev = run(raw(q(tail), {}, { billingPeriod: period }));
    expect(outcome(ev, 'billing_period')).toBe(expected);
  });
});

describe('plan binding and intervening tier', () => {
  it('T-EV-PLAN-01: the plan next to the value passes', () => {
    expect(outcome(run(raw(BASE)), 'plan_binding')).toBe('pass');
  });
  it('T-EV-PLAN-02: another plan closer to the value fails (intervening tier)', () => {
    const q = 'Acme Pro, Starter $20 per user per month';
    const ev = run(raw(q, {}, { amount: 20 }));
    expect(outcome(ev, 'plan_binding')).toBe('fail');
    expect(outcome(ev, 'intervening_tier')).toBe('fail');
  });
  it('T-EV-PLAN-03: a plan that is not in the quote fails', () => {
    const ev = run(raw('Acme Enterprise $90 per user per month'));
    expect(outcome(ev, 'plan_binding')).toBe('fail');
  });
  it('T-EV-PLAN-04: a price in a table column is bound by its column header', () => {
    const header = '| | Starter | Pro |';
    const row = '| Price | $20 per user per month | $90 per user per month |';
    const text = `Acme plans\n${header}\n|---|---|---|\n${row}`;
    const pro = rawWith(row, { plan: 'Pro', planNorm: 'pro' }, { contextQuote: header });
    pro.fields.value = value({ amount: 90 });
    const evPro = run(pro, { text });
    expect(outcome(evPro, 'plan_binding')).toBe('pass');
    const wrong = rawWith(row, { plan: 'Starter', planNorm: 'starter' }, { contextQuote: header });
    wrong.fields.value = value({ amount: 90 });
    expect(outcome(run(wrong, { text }), 'plan_binding')).toBe('fail');
  });
  it('T-EV-PLAN-05: no plan claimed is not applicable', () => {
    const ev = run(rawWith(BASE, { plan: null, planNorm: null }));
    expect(outcome(ev, 'plan_binding')).toBe('n/a');
  });
});

describe('negation, historical, conditional, promotional, planned cues', () => {
  it('T-EV-NEG-01: "no longer" bound to the value requires negated polarity', () => {
    const q = 'Acme Pro is no longer offered at $90 per user per month';
    expect(outcome(run(raw(q)), 'negation')).toBe('fail');
    const ev = run(raw(q, { polarity: 'negated' }));
    expect(outcome(ev, 'negation')).toBe('pass');
    expect(ev.beliefKey).toBeNull();
  });
  it('T-EV-NEG-02: negated polarity without a cue fails', () => {
    expect(outcome(run(raw(BASE, { polarity: 'negated' })), 'negation')).toBe('fail');
  });
  it('T-EV-NEG-03: a negation cue about another amount is not bound to this value', () => {
    const q = 'Acme Pro is not $120 any more, it is $90 per user per month';
    expect(outcome(run(raw(q)), 'negation')).toBe('n/a');
  });
  it('T-EV-HIST-01: "was" bound to the value requires historical', () => {
    const q = 'Acme Pro was $90 per user per month';
    expect(outcome(run(raw(q)), 'historical_cue')).toBe('fail');
    const ev = run(raw(q, { modality: 'historical' }));
    expect(outcome(ev, 'historical_cue')).toBe('pass');
    expect(ev.beliefKey).toBeNull();
  });
  it('T-EV-HIST-02: the current price after "was $100, now" is not historical', () => {
    const q = 'Acme Pro was $100, now $90 per user per month';
    const ev = run(raw(q));
    expect(outcome(ev, 'historical_cue')).toBe('n/a');
    expect(ev.verification.status).toBe('pass');
  });
  it('T-EV-HIST-03: strikethrough markup marks the old price', () => {
    const q = 'Acme Pro ~~$90~~ per user per month';
    expect(outcome(run(raw(q)), 'historical_cue')).toBe('fail');
  });
  it('T-EV-HIST-04: historical modality without a cue fails', () => {
    expect(outcome(run(raw(BASE, { modality: 'historical' })), 'historical_cue')).toBe('fail');
  });
  it('T-EV-COND-01: "from" makes the value a lower bound', () => {
    const q = 'Acme Pro from $90 per user per month';
    expect(outcome(run(raw(q)), 'conditional_cue')).toBe('fail');
    expect(outcome(run(raw(q, {}, { valueKind: 'lower_bound' })), 'conditional_cue')).toBe('pass');
  });
  it('T-EV-COND-02: "up to" makes the value an upper bound; exact claimed on a bound fails', () => {
    const q = 'Acme Pro up to $90 per user per month';
    expect(outcome(run(raw(q, {}, { valueKind: 'upper_bound' })), 'conditional_cue')).toBe('pass');
    expect(outcome(run(raw(q)), 'conditional_cue')).toBe('fail');
  });
  it('T-EV-COND-03: a lower bound claimed with no cue fails', () => {
    expect(outcome(run(raw(BASE, {}, { valueKind: 'lower_bound' })), 'conditional_cue')).toBe(
      'fail',
    );
  });
  it('T-EV-COND-04: a conditional cue needs conditional modality and verbatim conditions', () => {
    const q = 'Acme Pro $90 per user per month if you commit to 10 seats';
    expect(outcome(run(raw(q)), 'conditional_cue')).toBe('fail');
    const ok = rawWith(q, { conditions: 'if you commit to 10 seats' }, { modality: 'conditional' });
    expect(outcome(run(ok), 'conditional_cue')).toBe('pass');
    const noText = rawWith(q, { conditions: null }, { modality: 'conditional' });
    expect(outcome(run(noText), 'conditional_cue')).toBe('fail');
    const invented = rawWith(
      q,
      { conditions: 'with a three year contract' },
      { modality: 'conditional' },
    );
    expect(outcome(run(invented), 'conditional_cue')).toBe('fail');
  });
  it('T-EV-COND-05: a promotion cue needs promotional modality', () => {
    const q = 'Acme Pro $90 per user per month, 20% off in the first year';
    expect(outcome(run(raw(q)), 'conditional_cue')).toBe('fail');
    const ok = rawWith(q, { conditions: '20% off in the first year' }, { modality: 'promotional' });
    expect(outcome(run(ok), 'conditional_cue')).toBe('pass');
  });
  it('T-EV-COND-06: promotional claimed with no cue fails', () => {
    const r = rawWith(BASE, { conditions: 'free' }, { modality: 'promotional' });
    expect(outcome(run(r), 'conditional_cue')).toBe('fail');
  });
});

describe('dates and planned prices', () => {
  const q = 'Acme Pro will cost $99 per user per month, effective 1 December 2026';
  it('T-EV-DATE-01: an explicit effective date is parsed by code', () => {
    const r = raw(q, { modality: 'planned', effectiveFromText: '1 December 2026' }, { amount: 99 });
    const ev = run(r);
    expect(outcome(ev, 'date_presence')).toBe('pass');
    expect(ev.effectiveFrom).toBe(Date.UTC(2026, 11, 1));
    expect(outcome(ev, 'planned_cue')).toBe('pass');
    expect(ev.verification.status).toBe('pass');
  });
  it('T-EV-DATE-02: a date that is not in the text is invented and fails', () => {
    const r = raw(q, { modality: 'planned', effectiveFromText: '1 January 2027' }, { amount: 99 });
    const ev = run(r);
    expect(outcome(ev, 'date_presence')).toBe('fail');
    expect(ev.effectiveFrom).toBeNull();
  });
  it('T-EV-DATE-03: a publication date is not an effective date', () => {
    const text = 'Acme Pro $90 per user per month. Published 3 November 2026';
    const r = raw('Acme Pro $90 per user per month. Published 3 November 2026', {
      effectiveFromText: '3 November 2026',
    });
    const ev = run(r, { text });
    expect(ev.effectiveFrom).toBeNull();
    expect(outcome(ev, 'date_presence')).toBe('weak');
  });
  it('T-EV-DATE-04: a month alone is weak and sets no precise date', () => {
    const r = raw(
      'Acme Pro will cost $99 per user per month from December 2026',
      {
        modality: 'planned',
        effectiveFromText: 'December 2026',
      },
      { amount: 99 },
    );
    const ev = run(r);
    expect(outcome(ev, 'date_presence')).toBe('weak');
    expect(ev.verification.status).toBe('weak');
  });
  it('T-EV-DATE-05: a future cue with no date is weak and kept out of beliefs', () => {
    const r = raw(
      'Acme Pro will cost $99 per user per month',
      { modality: 'planned' },
      { amount: 99 },
    );
    const ev = run(r);
    expect(outcome(ev, 'planned_cue')).toBe('weak');
    expect(ev.beliefKey).toBeNull();
  });
  it('T-EV-DATE-06: a future cue on a current statement fails', () => {
    const r = raw(
      'Acme Pro will cost $99 per user per month, effective 1 December 2026',
      {},
      { amount: 99 },
    );
    expect(outcome(run(r), 'planned_cue')).toBe('fail');
  });
  it('T-EV-DATE-07: a past effective date does not make the statement planned', () => {
    const r = raw('Acme Pro $90 per user per month, effective 1 September 2026', {
      effectiveFromText: '1 September 2026',
    });
    const ev = run(r);
    expect(outcome(ev, 'planned_cue')).toBe('n/a');
    expect(ev.effectiveFrom).toBe(Date.UTC(2026, 8, 1));
    expect(ev.verification.status).toBe('pass');
  });
  it('T-EV-DATE-08: a fresh fetch never sets effectiveFrom', () => {
    const ev = run(raw(BASE), { snap: { freshFetch: true } });
    expect(ev.effectiveFrom).toBeNull();
    expect(ev.displayedAtBasis).toBe('fresh_fetch');
  });
});

describe('time fields', () => {
  it('T-EV-TIME-01: a live crawl displays at observedAt', () => {
    const ev = run(raw(BASE));
    expect(ev.displayedAt).toBe(NOW - 1000);
    expect(ev.freshFetch).toBe(true);
  });
  it('T-EV-TIME-02: a flagged fetch whose crawl failed is not fresh', () => {
    const ev = run(raw(BASE), {
      snap: { crawlStatus: 'failed', providerLastUpdatedAt: NOW - 9000 },
    });
    expect(ev.freshFetch).toBe(false);
    expect(ev.displayedAtBasis).toBe('provider_last_updated');
  });
  it('T-EV-TIME-03: otherwise last updated, then published, then unknown', () => {
    const cached = { freshFetch: false };
    expect(
      run(raw(BASE), { snap: { ...cached, providerLastUpdatedAt: 5, providerPublishedAt: 1 } })
        .displayedAtBasis,
    ).toBe('provider_last_updated');
    expect(run(raw(BASE), { snap: { ...cached, providerPublishedAt: 1 } }).displayedAtBasis).toBe(
      'provider_published',
    );
    const unk = run(raw(BASE), { snap: cached });
    expect(unk.displayedAtBasis).toBe('unknown');
    expect(unk.displayedAt).toBeNull();
  });
});

describe('release and other statements', () => {
  it('T-EV-REL-01: a release statement with an explicit event date passes', () => {
    const q = 'Acme launched Acme Insights on 3 November 2026';
    const r = rawWith(
      q,
      {
        attribute: 'release',
        plan: null,
        planNorm: null,
        value: null,
        releaseTitle: 'Acme Insights',
        releaseKind: 'launch',
      },
      { kind: 'release', eventDateText: '3 November 2026' },
    );
    const ev = run(r);
    expect(ev.verification.status).toBe('pass');
    expect(ev.eventDate).toBe(Date.UTC(2026, 10, 3));
    expect(ev.beliefKey).toMatch(/^release:v1\|e=ent_acme\|t=/);
  });
  it('T-EV-REL-02: a release title that is not in the quote is weak', () => {
    const r = rawWith(
      'Acme launched something on 3 November 2026',
      {
        attribute: 'release',
        plan: null,
        planNorm: null,
        value: null,
        releaseTitle: 'Acme Insights',
      },
      { kind: 'release', eventDateText: '3 November 2026' },
    );
    expect(run(r).verification.status).toBe('weak');
  });
  it('T-EV-PRICE-01: a price statement with no value fails', () => {
    expect(run(raw(BASE, {}, null)).verification.status).toBe('fail');
  });
});

describe('verifier output', () => {
  it('T-EV-OUT-01: only pass statements carry a belief key', () => {
    expect(run(raw(BASE)).beliefKey).toMatch(/^price:v1\|e=ent_acme\|p=pro\|a=list\|/);
    expect(run(raw(BASE, {}, { amount: 91 })).beliefKey).toBeNull();
  });
  it('T-EV-OUT-02: the verifier is deterministic for identical input', () => {
    const v = verifier();
    const s = snapshot(BASE);
    const a = v.verify(raw(BASE), s, ACME, 'A1', NOW);
    const b = v.verify(raw(BASE), s, ACME, 'A1', NOW);
    expect({ ...a, id: '' }).toEqual({ ...b, id: '' });
  });
});
