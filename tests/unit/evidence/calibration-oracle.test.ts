import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goldClaimToRaw, pageOf } from '../../../src/evidence/eval/build.js';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import { runOracle } from '../../../src/evidence/eval/oracle.js';
import { RuleEvidenceVerifier } from '../../../src/evidence/verifier.js';

/**
 * The ideal extraction (every gold claim, exactly as labelled) through the real T0 to T2 verifier. A claim that
 * does not pass shows that the extraction contract cannot be met for that page with the quote and context
 * labelled, or that the label is wrong. The expected outcomes are pinned in the gold files, so a change to the
 * verifier that moves any of them fails here and has to be looked at.
 *
 * This is not a measurement of a model: no model is involved.
 */
const set = loadCalibrationSet(join(import.meta.dirname, '..', '..', 'fixtures', 'calibration'));
const NOW = Date.UTC(2026, 10, 12, 12);
const report = runOracle(set, new RuleEvidenceVerifier(), NOW);

describe('oracle: the ideal extraction through the real verifier', () => {
  it('verifies every gold claim with the outcome labelled for it', () => {
    expect(
      report.mismatches.map((m) => `${m.pageId}/${m.claimId}: ${m.expected} -> ${m.actual}`),
    ).toEqual([]);
  });

  it('runs all of the claims', () => {
    expect(report.total).toBe(set.pages.reduce((n, p) => n + p.gold.claims.length, 0));
    expect(report.actualPass + report.actualWeak + report.actualFail).toBe(report.total);
  });

  it('shows that not every extractable claim can pass: the contract has gaps', () => {
    // The point of the oracle. If this ever reads "every claim passes", the labels or the verifier changed.
    expect(report.actualPass).toBeGreaterThan(0);
    expect(report.actualPass).toBeLessThan(report.total);
  });

  it('a failing or weak claim always names the checks that stopped it', () => {
    for (const c of report.claims.filter((x) => x.actual !== 'pass'))
      expect(c.failing.length, `${c.pageId}/${c.claimId}`).toBeGreaterThan(0);
  });

  it('the best-achievable quote and context of a claim pass, as labelled', () => {
    const verifier = new RuleEvidenceVerifier();
    let checked = 0;
    for (const p of set.pages) {
      const { snapshot, entity } = pageOf(p);
      for (const c of p.gold.claims) {
        if (!c.bestAchievable) continue;
        const raw = {
          ...goldClaimToRaw(p.id, c),
          quote: c.bestAchievable.quote,
          contextQuote: c.bestAchievable.contextQuote,
        };
        const ev = verifier.verify(raw, snapshot, entity, 'A1', NOW);
        expect(ev.verification.status, `${p.id}/${c.id}`).toBe(c.bestAchievable.status);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
