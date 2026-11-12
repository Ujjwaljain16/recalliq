import { describe, expect, it } from 'vitest';
import { OfficialDomains } from '../../../src/app/live/registry.js';
import type { EntityRow } from '../../../src/app/live/entities.js';
import type { EntityContext, NormalizedValue, RawEvidence } from '../../../src/shared/index.js';
import { ACME, raw, rawWith, run, value } from './support.js';

/**
 * Registered domain ownership as subject-binding evidence (ADR-41). The vendor name is never in the quote in
 * these cases: the only thing that can bind the subject is that the page is on a domain the owner's registry
 * maps to the entity. All pages, vendors and prices are [SYNTHETIC].
 */

const OWNED: EntityContext = { ...ACME, ownedDomains: ['acme.example'] };
const PRICE_ROW = '| Pro | $90 per user per month |';
const own = (
  text: string,
  r: RawEvidence = raw(PRICE_ROW),
  entity: EntityContext = OWNED,
  url?: string,
) =>
  run(r, {
    text,
    entity,
    ...(url
      ? { snap: { url, urlNorm: url.replace(/^https?:\/\//, ''), domain: new URL(url).hostname } }
      : {}),
  });
const subject = (ev: ReturnType<typeof run>) =>
  ev.verification.checks.find((c) => c.check === 'subject_binding');
const check = (ev: ReturnType<typeof run>, name: string) =>
  ev.verification.checks.find((c) => c.check === name)?.outcome;

const PAGE = `# Plans and pricing\n| Plan | Price |\n${PRICE_ROW}`;

describe('first-party pricing on a registered domain', () => {
  it("T-EV-OWN-01: a plan-tied price on the owner's pricing page is attributed, and says why", () => {
    const ev = own(PAGE);
    expect(subject(ev)?.outcome).toBe('pass');
    expect(subject(ev)?.detail).toBe(
      'subject bound by registered domain ownership, not by the quote: page published by the registered owner of acme.example; price tied to plan pro',
    );
    expect(ev.verification.status).toBe('pass');
    expect(ev.beliefKey).not.toBeNull();
    // the vendor name was not put into the quote or the context
    expect(ev.quote).toBe(PRICE_ROW);
    expect(ev.contextQuote).toBeNull();
  });

  it('T-EV-OWN-02: the same page without registry ownership stays weak, exactly as before', () => {
    for (const entity of [
      ACME,
      { ...ACME, ownedDomains: [] },
      { ...ACME, ownedDomains: ['other.example'] },
    ]) {
      const ev = own(PAGE, raw(PRICE_ROW), entity);
      expect(subject(ev)?.outcome).toBe('weak');
      expect(subject(ev)?.detail).toBe('only the official domain suggests the subject');
      expect(ev.verification.status).toBe('weak');
    }
  });

  it("T-EV-OWN-03: a subdomain of the owned domain is the owner's page; a look-alike host is not", () => {
    expect(
      subject(own(PAGE, raw(PRICE_ROW), OWNED, 'https://www.acme.example/pricing'))?.outcome,
    ).toBe('pass');
    expect(
      subject(own(PAGE, raw(PRICE_ROW), OWNED, 'https://shop.acme.example/pricing'))?.outcome,
    ).toBe('pass');
    for (const url of [
      'https://acme.example.evil.example/pricing',
      'https://notacme.example/pricing',
    ])
      expect(subject(own(PAGE, raw(PRICE_ROW), OWNED, url))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-04: quote-level naming is unchanged: a vendor name in the quote still binds, with no ownership detail', () => {
    const ev = own('Acme Pro $90 per user per month', raw('Acme Pro $90 per user per month'), ACME);
    expect(subject(ev)).toEqual({ check: 'subject_binding', outcome: 'pass' });
  });

  it('T-EV-OWN-05: "Compare plans" navigation on the vendor\'s own page is not a comparison', () => {
    const ev = own(`Compare plans\n${PAGE}`);
    expect(subject(ev)?.outcome).toBe('pass');
  });

  it('T-EV-OWN-06: a page that does not present pricing gets no page-level attribution', () => {
    const blog = 'We shipped a new release today.\n| Pro | $90 per user per month |';
    const ev = run(raw(PRICE_ROW), {
      text: blog,
      entity: OWNED,
      snap: {
        url: 'https://acme.example/news/release',
        urlNorm: 'acme.example/news/release',
        title: null,
      },
    });
    expect(subject(ev)?.outcome).toBe('weak');
  });
});

describe('blockers: no attribution inheritance', () => {
  const pageWith = (lead: string) => `# Plans and pricing\n${lead}\n${PRICE_ROW}`;

  it.each([
    ['T-EV-OWN-10', 'vs', 'Acme vs the market'],
    ['T-EV-OWN-11', 'versus', 'Pricing versus last year'],
    ['T-EV-OWN-12', 'compared to', 'Plans compared to rivals'],
    ['T-EV-OWN-13', 'alternative to', 'A cheaper alternative to the big names'],
    ['T-EV-OWN-14', 'switch from', 'Switch from your old tool'],
    ['T-EV-OWN-15', 'instead of', 'Pay for seats instead of usage'],
  ])('%s: a comparison cue (%s) above the price blocks the registry binding', (_id, _cue, lead) => {
    expect(subject(own(pageWith(lead)))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-16: a competitor comparison table gets no automatic attribution', () => {
    const text =
      '# Acme vs Beta Suite\n| Plan | Acme | Beta Suite |\n| Pro | $90 per user per month | $120 per user per month |';
    const ev = own(text, raw('| Pro | $90 per user per month | $120 per user per month |'));
    expect(subject(ev)?.outcome).toBe('weak');
    expect(ev.verification.status).not.toBe('pass');
  });

  it.each([
    ['T-EV-OWN-20', 'integrates with'],
    ['T-EV-OWN-21', 'Powered by'],
    ['T-EV-OWN-22', 'App marketplace'],
    ['T-EV-OWN-23', 'Add-on from a partner'],
    ['T-EV-OWN-24', 'Third-party connector'],
  ])('%s: an integration or third-party cue (%s) blocks the binding', (_id, cue) => {
    const text = `# Plans and pricing\n${cue}: Zapier Pro $90 per user per month`;
    const ev = own(text, raw('Zapier Pro $90 per user per month'));
    expect(subject(ev)?.outcome).toBe('weak');
  });

  it("T-EV-OWN-25: a third-party integration price on the owner's domain gets no automatic attribution", () => {
    const text = '## Integrations\nSlack integration\n| Pro | $90 per user per month |';
    expect(subject(own(text))?.outcome).toBe('weak');
  });

  it.each([
    ['T-EV-OWN-30', 'Our partners'],
    ['T-EV-OWN-31', 'Reseller listing'],
    ['T-EV-OWN-32', 'Agency directory'],
    ['T-EV-OWN-33', 'Authorised dealer'],
  ])('%s: a partner or reseller listing (%s) blocks the binding', (_id, lead) => {
    expect(subject(own(`# Plans and pricing\n${lead}\n${PRICE_ROW}`))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-34: a testimonial or quoted price blocks the binding', () => {
    const quoted = 'Pro: "costs $90 per user per month"';
    expect(subject(own(`# Plans and pricing\n${quoted}`, raw(quoted)))?.outcome).toBe('weak');
    const story = `# Customer story\n${PRICE_ROW}`;
    expect(subject(own(story))?.outcome).toBe('weak');
    for (const cue of ['Case study', 'Reviews', 'Testimonials'])
      expect(subject(own(`# Plans and pricing\n${cue}\n${PRICE_ROW}`))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-35: an embedded external pricing table blocks the binding', () => {
    const text = '# Plans and pricing\nEmbedded widget\n| Pro | $90 per user per month |';
    expect(subject(own(text))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-36: a known other entity named near the price blocks the binding', () => {
    const text =
      '# Plans and pricing\nBeta Suite customers get a discount\n| Pro | $90 per user per month |';
    expect(subject(own(text))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-37: a price list that names another organisation blocks the binding', () => {
    const text = '# Plans and pricing\nGlobex Pricing\n| Pro | $90 per user per month |';
    expect(subject(own(text))?.outcome).toBe('weak');
    const ours = '# Plans and pricing\nAcme Pricing\n| Pro | $90 per user per month |';
    expect(subject(own(ours))?.outcome).toBe('pass');
  });

  it('T-EV-OWN-38: the title is scanned too', () => {
    const ev = run(raw(PRICE_ROW), {
      text: PAGE,
      entity: OWNED,
      snap: { title: 'Acme alternatives and comparison' },
    });
    expect(subject(ev)?.outcome).toBe('weak');
  });
});

describe('ownership that is unknown, conflicting or not enough', () => {
  it('T-EV-OWN-40: a vendor name elsewhere on the page, with no registered domain, binds nothing', () => {
    const text = '# Acme pricing\nAcme is a CRM.\n| Pro | $90 per user per month |';
    const ev = own(text, raw(PRICE_ROW), ACME, 'https://other.example/pricing');
    expect(subject(ev)?.outcome).toBe('weak');
  });

  it('T-EV-OWN-41: a domain listed for two entities is owned by neither', () => {
    const row = (name: string, domains: string[] = []): EntityRow => ({
      id: `ent_${name.toLowerCase()}`,
      name,
      aliases: [],
      plans: [],
      officialDomains: domains,
    });
    const acme = row('Acme');
    const other = row('Other');
    new OfficialDomains({ acme: ['acme.example'], other: ['acme.example'] }).apply([acme, other]);
    expect(acme.ownedDomains).toEqual([]);
    expect(other.ownedDomains).toEqual([]);
    const context: EntityContext = { ...ACME, ownedDomains: acme.ownedDomains ?? [] };
    expect(subject(own(PAGE, raw(PRICE_ROW), context))?.outcome).toBe('weak');
  });

  it('T-EV-OWN-41b: a domain another entity also carries is owned by neither, whatever the registry says', () => {
    const row = (name: string, domains: string[]): EntityRow => ({
      id: `ent_${name.toLowerCase()}`,
      name,
      aliases: [],
      plans: [],
      officialDomains: domains,
    });
    const acme = row('Acme', []);
    const rival = row('Rival', ['acme.example']);
    new OfficialDomains({ acme: ['acme.example'] }).apply([acme, rival]);
    expect(acme.ownedDomains).toEqual([]);
    expect(acme.officialDomains).toEqual([]);
  });

  it('T-EV-OWN-42: a domain an entity merely carries from an earlier source is not registry ownership', () => {
    const acme: EntityRow = {
      id: 'ent_acme',
      name: 'Acme',
      aliases: [],
      plans: [],
      officialDomains: ['acme.example'],
    };
    OfficialDomains.none().apply([acme]);
    expect(acme.officialDomains).toContain('acme.example');
    // Not registry ownership: only the domains that are exactly the name, never the carried acme.example.
    expect(acme.ownedDomains).not.toContain('acme.example');
    expect(acme.ownedDomains).toContain('acme.com');
    new OfficialDomains({ Acme: ['acme.example'] }).apply([acme]);
    expect(acme.ownedDomains).toEqual(['acme.example']);
  });

  it('T-EV-OWN-43: a price with no plan named is not attributed by ownership', () => {
    const ev = own(PAGE, rawWith(PRICE_ROW, { plan: null, planNorm: null }));
    expect(check(ev, 'plan_binding')).toBe('n/a');
    expect(subject(ev)?.outcome).toBe('weak');
    expect(ev.verification.status).toBe('weak');
  });

  it('T-EV-OWN-44: a plan that the quote does not tie to the price keeps the claim from passing', () => {
    const wrong = own(PAGE, rawWith(PRICE_ROW, { plan: 'Enterprise', planNorm: 'enterprise' }));
    expect(check(wrong, 'plan_binding')).toBe('fail');
    expect(subject(wrong)?.outcome).toBe('weak');
    expect(wrong.verification.status).toBe('fail');
    const text = '# Plans and pricing\nPro\n$90 per user per month';
    const apart = own(text, rawWith('$90 per user per month', { plan: 'Pro', planNorm: 'pro' }));
    expect(check(apart, 'plan_binding')).not.toBe('pass');
    expect(apart.verification.status).not.toBe('pass');
  });

  it("T-EV-OWN-45: a competitor price on the owner's domain is still caught", () => {
    const text = '# Plans and pricing\nBeta Pro $90 per user per month';
    const ev = own(text, raw('Beta Pro $90 per user per month'));
    expect(check(ev, 'competitor_attribution')).toBe('fail');
    expect(subject(ev)?.outcome).toBe('fail');
    expect(ev.verification.status).toBe('fail');
  });
});

describe('ownership binds the subject and nothing else', () => {
  const MULTI =
    'Pro $49/month (monthly) or $35/month (annual), Starter $20/month (monthly) or $15/month (annual)';
  const text = `# Plans and pricing\n${MULTI}`;
  const claim = (amount: number, billingPeriod: NormalizedValue['billingPeriod']) =>
    own(text, rawWith(MULTI, { value: value({ amount, billingPeriod, unit: 'unspecified' }) }));

  it('T-EV-OWN-50: the annual rate claimed as monthly still fails the billing period while the subject is bound', () => {
    const ev = claim(35, 'monthly');
    expect(subject(ev)?.outcome).toBe('pass');
    expect(subject(ev)?.detail).toContain('registered owner of acme.example');
    expect(check(ev, 'billing_period')).toBe('fail');
    expect(ev.verification.status).toBe('fail');
    expect(ev.beliefKey).toBeNull();
  });

  it('T-EV-OWN-51: the right period passes, and the other checks are as they were', () => {
    const ok = claim(35, 'monthly_billed_annually');
    expect(subject(ok)?.outcome).toBe('pass');
    expect(check(ok, 'billing_period')).toBe('pass');
    expect(ok.verification.status).toBe('pass');
    const unitWrong = own(PAGE, rawWith(PRICE_ROW, { value: value({ unit: 'flat' }) }));
    expect(check(unitWrong, 'unit')).toBe('fail');
    expect(unitWrong.verification.status).toBe('fail');
    const currency = own(PAGE, raw(PRICE_ROW, {}, { currency: 'USD' }));
    expect(check(currency, 'currency')).toBe('fail');
  });

  it('T-EV-OWN-52: a billing cue on a following line cannot be contradicted by a claim that ownership lets through', () => {
    const page = '# Plans and pricing\n### Pro\n$10 per user/month\n\nBilled yearly';
    const r = rawWith('$10 per user/month\n\nBilled yearly', {}, { contextQuote: '### Pro' });
    r.fields.value = value({ amount: 10, billingPeriod: 'monthly' });
    const ev = own(page, r);
    expect(subject(ev)?.outcome).toBe('weak');
    expect(ev.verification.status).not.toBe('pass');
  });

  it('T-EV-OWN-53: modality, negation and historical cues are still judged on the quote', () => {
    const was = 'Pro was $90 per user per month';
    const ev = own(`# Plans and pricing\n${was}`, raw(was));
    expect(check(ev, 'historical_cue')).toBe('fail');
    expect(ev.verification.status).toBe('fail');
  });
});
