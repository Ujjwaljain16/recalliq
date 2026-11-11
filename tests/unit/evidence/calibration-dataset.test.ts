import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAmounts } from '../../../src/evidence/currency.js';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import { goldClaimSatisfiesSpec } from '../../../src/evidence/eval/scoring.js';
import { locateVerbatim, normalizeText } from '../../../src/evidence/text.js';
import { normalizeUrl } from '../../../src/sources/url.js';

/**
 * Integrity of the calibration data set (docs/extraction-calibration.md). The pages are real public pages
 * captured through the project's search adapter; the labels were made by an AI reading them and need owner
 * spot-checking. These tests check the data, not the labels' truth.
 */
const set = loadCalibrationSet(join(import.meta.dirname, '..', '..', 'fixtures', 'calibration'));

describe('calibration data set: composition', () => {
  it('has at least 14 pages from at least 8 vendors', () => {
    expect(set.pages.length).toBeGreaterThanOrEqual(14);
    expect(new Set(set.pages.map((p) => p.gold.vendor.split(' ')[0])).size).toBeGreaterThanOrEqual(
      8,
    );
  });

  it('covers per-seat CRM, usage-based hosting, tiered billing and condition-heavy pages', () => {
    const cats = new Set(set.pages.flatMap((p) => p.gold.categories));
    for (const c of ['per_seat', 'usage_based', 'tiered_billing', 'conditions'] as const)
      expect(cats.has(c)).toBe(true);
  });

  it('has at least two negative controls with no gold claim', () => {
    const neg = set.pages.filter((p) => p.gold.categories.includes('negative_control'));
    expect(neg.length).toBeGreaterThanOrEqual(2);
    for (const p of neg) expect(p.gold.claims).toEqual([]);
    for (const p of set.pages.filter((x) => x.gold.claims.length === 0))
      expect(p.gold.categories).toContain('negative_control');
  });

  it('has several kinds of trap, and at least one trap on every page', () => {
    const kinds = new Set(set.pages.flatMap((p) => p.gold.traps.map((t) => t.kind)));
    for (const k of [
      'competitor',
      'annual_shown_per_month',
      'promotional',
      'usage_without_unit',
      'other_plan',
    ])
      expect(kinds.has(k as never)).toBe(true);
    for (const p of set.pages) expect(p.gold.traps.length).toBeGreaterThan(0);
  });

  it('flags the labels the reviewer is unsure of', () => {
    const conf = set.pages.flatMap((p) => p.gold.claims.map((c) => c.confidence));
    expect(conf.filter((c) => c === 'low').length).toBeGreaterThan(0);
    expect(conf.filter((c) => c === 'medium').length).toBeGreaterThan(0);
  });

  it('records the capture: manifest lists every page once, in files that exist', () => {
    const ids = set.manifest.pages.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(set.pages.map((p) => p.id)).toEqual(ids);
    expect(set.manifest.exa.contentMode).toBe('text');
    expect(set.manifest.exa.contentChars).toBe(6000);
    expect(set.manifest.exa.requests).toBeLessThanOrEqual(60);
    expect(set.manifest.labelledBy).toMatch(/AI/);
  });
});

describe('calibration data set: pages', () => {
  it.each(set.pages.map((p) => [p.id, p] as const))('%s is a well-formed capture', (_id, p) => {
    expect(p.page.text.length).toBeLessThanOrEqual(6000);
    expect(p.page.provider).toBe('exa');
    expect(Number.isNaN(Date.parse(p.page.capturedAt))).toBe(false);
    expect(p.page.urlNorm).toBe(normalizeUrl(p.page.url).urlNorm);
    const host = normalizeUrl(p.page.url).domain;
    const official = p.gold.entity.officialDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    expect(official).toBe(true);
  });

  it('keeps the pages as returned: no page text is empty or padded', () => {
    for (const p of set.pages)
      expect(p.page.text.trim()).toBe(p.page.text.replace(/^\s+/, '').trimEnd());
  });
});

describe('calibration data set: gold claims', () => {
  const claims = set.pages.flatMap((p) => p.gold.claims.map((c) => ({ p, c })));

  it('has gold claims at all', () => {
    expect(claims.length).toBeGreaterThanOrEqual(50);
  });

  it('keeps ids unique within a page and at most 8 claims on a page (the extractor keeps 8 per kind)', () => {
    for (const p of set.pages) {
      const ids = p.gold.claims.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      const tids = p.gold.traps.map((t) => t.id);
      expect(new Set(tids).size).toBe(tids.length);
      expect(p.gold.claims.length).toBeLessThanOrEqual(8);
    }
  });

  it('quotes are verbatim, at most 400 characters; contexts verbatim, at most 200, and above the quote', () => {
    for (const { p, c } of claims) {
      const text = normalizeText(p.page.text);
      const where = `${p.id}/${c.id}`;
      expect(c.quote.length, where).toBeLessThanOrEqual(400);
      const q = locateVerbatim(text, normalizeText(c.quote));
      expect(q, `${where} quote`).not.toBeNull();
      if (c.contextQuote !== null) {
        expect(c.contextQuote.length, where).toBeLessThanOrEqual(200);
        const h = locateVerbatim(text, normalizeText(c.contextQuote));
        expect(h, `${where} context`).not.toBeNull();
        expect(h!.end, `${where} context is above the quote`).toBeLessThanOrEqual(q!.start);
      }
      if (c.bestAchievable) {
        const b = c.bestAchievable;
        expect(b.quote.length).toBeLessThanOrEqual(400);
        const bq = locateVerbatim(text, normalizeText(b.quote));
        expect(bq, `${where} best quote`).not.toBeNull();
        if (b.contextQuote !== null) {
          expect(b.contextQuote.length).toBeLessThanOrEqual(200);
          const bh = locateVerbatim(text, normalizeText(b.contextQuote));
          expect(bh, `${where} best context`).not.toBeNull();
          expect(bh!.end).toBeLessThanOrEqual(bq!.start);
        }
      }
    }
  });

  it('the claimed amount is in the quote, and a usage unit goes with unit usage only', () => {
    for (const { p, c } of claims) {
      const amounts = findAmounts(normalizeText(c.quote)).map((a) => a.amount);
      expect(
        amounts.some((a) => Math.abs(a - c.value.amount) < 1e-9),
        `${p.id}/${c.id} amount in quote`,
      ).toBe(true);
      expect(c.value.usageUnit !== null, `${p.id}/${c.id}`).toBe(c.value.unit === 'usage');
      if (c.modality === 'promotional' || c.modality === 'conditional')
        expect(c.conditions, `${p.id}/${c.id}`).not.toBeNull();
    }
  });

  it('every claim that does not pass says why, and one that passes does not', () => {
    for (const { p, c } of claims) {
      const where = `${p.id}/${c.id}`;
      if (c.expected.status === 'pass') expect(c.expected.reason, where).toBeUndefined();
      else expect(c.expected.reason?.length ?? 0, where).toBeGreaterThan(0);
      if (c.bestAchievable) {
        // Recorded only when it improves the outcome to pass.
        expect(c.bestAchievable.status, where).toBe('pass');
        expect(c.expected.status, where).not.toBe('pass');
      }
    }
  });

  it('no gold claim satisfies a trap or sits in the ignorable list by accident', () => {
    for (const p of set.pages) {
      for (const c of p.gold.claims) {
        for (const t of p.gold.traps)
          expect(goldClaimSatisfiesSpec(c, t.match), `${p.id}/${c.id} matches trap ${t.id}`).toBe(
            false,
          );
      }
    }
  });

  it('traps and ignorable entries are never empty except on a negative control', () => {
    for (const p of set.pages) {
      for (const t of [...p.gold.traps, ...p.gold.ignorable]) {
        const empty = Object.keys(t.match).length === 0;
        if (empty) expect(p.gold.claims.length, `${p.id}/${t.id}`).toBe(0);
      }
    }
  });
});
