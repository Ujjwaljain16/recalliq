import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAmounts } from '../../../src/evidence/currency.js';
import { entityContextOf, goldClaimToRaw, snapshotOf } from '../../../src/evidence/eval/build.js';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import { runOracle } from '../../../src/evidence/eval/oracle.js';
import {
  ownedDomainsFor,
  parseRegistry,
  registryFromGoldPages,
} from '../../../src/evidence/eval/registry.js';
import { RuleEvidenceVerifier } from '../../../src/evidence/verifier.js';

/**
 * The perfect-extraction oracle with and without an owner registry (ADR-41).
 *
 * The registry used here is a MEASUREMENT AID: each gold page's own vendor mapped to the domain of the page's
 * URL, derived from the data. It is not an owner registry and no registry ships as a default. It shows what the
 * verifier ceiling would be if the owner had registered the vendors of these pages.
 */
const set = loadCalibrationSet(join(import.meta.dirname, '..', '..', 'fixtures', 'calibration'));
const NOW = Date.UTC(2026, 10, 12, 12);
const verifier = new RuleEvidenceVerifier();
const aid = parseRegistry(registryFromGoldPages(set));
const without = runOracle(set, verifier, NOW);
const withRegistry = runOracle(set, verifier, NOW, aid);

/** Gold claims that move from weak to pass, with the registry, because only their subject was unbound. */
const NOW_PASSING = [
  'pipedrive-pricing/lite-annual-total',
  'pipedrive-pricing/ultimate-annual-total',
  'salesforce-sales-pricing/starter-usd',
  'salesforce-sales-pricing/starter-eur',
  'salesforce-sales-pricing/starter-aud',
  'salesforce-sales-pricing/pro-usd',
  'salesforce-sales-pricing/core-usd',
  'salesforce-sales-pricing/advanced-usd',
  'salesforce-sales-pricing/max-usd',
  'hubspot-sales-software/free',
  'supabase-pricing/free-from',
  'supabase-pricing/pro-from',
  'supabase-pricing/team-from',
  'supabase-pricing/micro-compute',
  'supabase-pricing/pro-disk-overage',
  'supabase-pricing/pro-egress-overage',
  'render-pricing/postgres-free',
  'render-pricing/postgres-1c-2g',
  'railway-plans/hobby',
  'railway-plans/pro',
  'railway-plans/egress-container',
  'notion-pricing/plus',
  'notion-pricing/business',
  'notion-pricing/free',
  'slack-pricing/free',
];

describe('oracle with and without a registry', () => {
  it('T-EV-OWN-60: with no registry the numbers are exactly what they were', () => {
    expect(withRegistryless()).toEqual({ total: 80, pass: 15, weak: 38, fail: 27 });
    expect(without.mismatches).toEqual([]);
  });

  it('T-EV-OWN-61: with the measurement-aid registry, 25 claims move from weak to pass and nothing else changes', () => {
    expect({
      pass: withRegistry.actualPass,
      weak: withRegistry.actualWeak,
      fail: withRegistry.actualFail,
    }).toEqual({ pass: 40, weak: 13, fail: 27 });
    const moved = without.claims.flatMap((a, i) => {
      const b = withRegistry.claims[i];
      return b && a.actual !== b.actual
        ? [{ id: `${a.pageId}/${a.claimId}`, from: a.actual, to: b.actual, was: a.failing }]
        : [];
    });
    expect(moved.map((m) => m.id)).toEqual(NOW_PASSING);
    for (const m of moved) {
      expect(m.from, m.id).toBe('weak');
      expect(m.to, m.id).toBe('pass');
      // the only thing that held them back was the unbound subject
      expect(
        m.was.every((f) => f.startsWith('subject_binding: weak')),
        m.id,
      ).toBe(true);
    }
  });

  it('T-EV-OWN-62: every pass by ownership says so, and a subject bound by the quote itself does not', () => {
    for (const p of set.pages) {
      const snap = snapshotOf(p.id, p.page);
      const entity = entityContextOf(p.id, p.gold, aid);
      for (const c of p.gold.claims) {
        const id = `${p.id}/${c.id}`;
        const ev = verifier.verify(goldClaimToRaw(p.id, c), snap, entity, 'A1', NOW);
        const detail =
          ev.verification.checks.find((x) => x.check === 'subject_binding')?.detail ?? '';
        const byOwnership = detail.includes('registered domain ownership');
        if (NOW_PASSING.includes(id)) expect(byOwnership, id).toBe(true);
        const namedInQuote = entity.aliases.some((al) =>
          c.quote.toLowerCase().includes(al.toLowerCase()),
        );
        if (namedInQuote) expect(byOwnership, id).toBe(false);
      }
    }
  });

  it('T-EV-OWN-63: ownership never changes a claim that already failed, and never adds a quote', () => {
    for (let i = 0; i < without.claims.length; i++) {
      const a = without.claims[i];
      const b = withRegistry.claims[i];
      if (a?.actual === 'fail') expect(b?.actual).toBe('fail');
    }
    for (const p of set.pages)
      for (const c of p.gold.claims) {
        const ev = verifier.verify(
          goldClaimToRaw(p.id, c),
          snapshotOf(p.id, p.page),
          entityContextOf(p.id, p.gold, aid),
          'A1',
          NOW,
        );
        expect(ev.quote).toBe(c.quote);
        expect(ev.contextQuote).toBe(c.contextQuote);
      }
  });
});

describe('every trap still fails', () => {
  it('T-EV-OWN-64: no labelled trap statement passes, with or without a registry', () => {
    let built = 0;
    for (const p of set.pages) {
      const snap = snapshotOf(p.id, p.page);
      for (const t of p.gold.traps) {
        const m = t.match;
        const tmpl =
          p.gold.claims.find((c) => m.amount === undefined || c.value.amount === m.amount) ??
          p.gold.claims[0];
        if (!tmpl) continue;
        const raw = goldClaimToRaw(p.id, tmpl);
        const value = { ...(raw.fields.value as NonNullable<typeof raw.fields.value>) };
        let quote = raw.quote;
        let ownQuote = true;
        if (m.quoteContains && m.amount === undefined) {
          const line = p.page.text
            .split('\n')
            .find((l) => m.quoteContains?.every((x) => l.toLowerCase().includes(x.toLowerCase())));
          if (!line) continue;
          quote = line.trim().slice(0, 400);
          ownQuote = false;
          const a = findAmounts(quote)[0];
          if (a) value.amount = a.amount;
        }
        if (m.amount !== undefined) value.amount = m.amount;
        if (m.unit?.[0]) value.unit = m.unit[0] as typeof value.unit;
        if (m.billingPeriod?.[0])
          value.billingPeriod = m.billingPeriod[0] as typeof value.billingPeriod;
        if (m.currency?.[0]) value.currency = m.currency[0];
        const mutant = {
          ...raw,
          quote,
          contextQuote: ownQuote ? raw.contextQuote : null,
          modality: (m.modality?.[0] ?? raw.modality) as typeof raw.modality,
          fields: {
            ...raw.fields,
            value,
            planNorm: m.planNorm ?? raw.fields.planNorm,
            plan: m.planNorm ?? raw.fields.plan,
          },
        };
        for (const registry of [undefined, aid]) {
          const status = verifier.verify(
            mutant,
            snap,
            entityContextOf(p.id, p.gold, registry),
            'A1',
            NOW,
          ).verification.status;
          expect(status, `${p.id}/${t.id} ${registry ? 'with' : 'without'} a registry`).not.toBe(
            'pass',
          );
        }
        built += 1;
      }
    }
    expect(built).toBe(56);
  });
});

describe('the evaluation registry', () => {
  it('T-EV-OWN-65: is optional, lists owned domains by name or alias, and drops a domain listed twice', () => {
    expect(ownedDomainsFor(undefined, ['Close'])).toEqual([]);
    const r = parseRegistry({
      Close: ['www.close.com'],
      'Zoho CRM': ['zoho.com'],
      Other: ['zoho.com'],
    });
    expect(ownedDomainsFor(r, ['Close', 'close crm'])).toEqual(['close.com']);
    expect(ownedDomainsFor(r, ['Zoho CRM'])).toEqual([]);
    expect(ownedDomainsFor(r, ['Unlisted'])).toEqual([]);
    expect(() => parseRegistry({ Close: 'close.com' })).toThrow();
  });

  it('T-EV-OWN-66: a gold page gets owned domains only when a registry is supplied', () => {
    const p = set.pages[0];
    if (!p) throw new Error('no pages');
    expect(entityContextOf(p.id, p.gold).ownedDomains).toBeUndefined();
    expect(entityContextOf(p.id, p.gold, aid).ownedDomains?.length).toBe(1);
  });
});

function withRegistryless() {
  return {
    total: without.total,
    pass: without.actualPass,
    weak: without.actualWeak,
    fail: without.actualFail,
  };
}
