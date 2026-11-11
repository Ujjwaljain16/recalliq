import type { EvidenceVerifier } from '../../shared/evidence.js';
import type { Ms } from '../../shared/ids.js';
import { failingChecks, goldClaimToRaw, pageOf } from './build.js';
import type { CalibrationSet } from './gold.js';
import type { EntityRegistry } from './registry.js';

export type Status = 'pass' | 'weak' | 'fail';

export interface OracleClaimResult {
  pageId: string;
  claimId: string;
  expected: Status;
  actual: Status;
  /** Checks that were weak or failed, with the verifier's detail. */
  failing: string[];
}

export interface OracleReport {
  claims: OracleClaimResult[];
  total: number;
  actualPass: number;
  actualWeak: number;
  actualFail: number;
  /** Claims whose actual outcome differs from the labelled expectation. */
  mismatches: OracleClaimResult[];
}

/**
 * Runs the ideal extraction (every gold claim, exactly as labelled) through a verifier. A gold claim that
 * should be extractable but does not pass shows that the extraction contract (what the model must quote and
 * which fields it must set) cannot be met for that page, or that the label is wrong.
 */
export function runOracle(
  set: CalibrationSet,
  verifier: EvidenceVerifier,
  now: Ms,
  registry?: EntityRegistry,
): OracleReport {
  const claims: OracleClaimResult[] = [];
  for (const p of set.pages) {
    const { snapshot, entity } = pageOf(p, registry);
    for (const c of p.gold.claims) {
      const ev = verifier.verify(goldClaimToRaw(p.id, c), snapshot, entity, 'A1', now);
      claims.push({
        pageId: p.id,
        claimId: c.id,
        expected: c.expected.status,
        actual: ev.verification.status,
        failing: failingChecks(ev),
      });
    }
  }
  const count = (s: Status) => claims.filter((c) => c.actual === s).length;
  return {
    claims,
    total: claims.length,
    actualPass: count('pass'),
    actualWeak: count('weak'),
    actualFail: count('fail'),
    mismatches: claims.filter((c) => c.expected !== c.actual),
  };
}
