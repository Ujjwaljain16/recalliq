import type { VerifiedEvidence } from '../shared/evidence.js';
import type { Ms } from '../shared/ids.js';

/**
 * The content as-of time of an observation (ADR-36, owner decision 2026-11-12): the latest instant at which
 * the observation shows what the source displayed.
 *
 * - a live crawl (`freshFetch`, which the verifier sets only for `fresh_fetch` AND `crawl_status = ok`):
 *   `observedAt`;
 * - otherwise the provider's last-updated time when it reports one (the conservative, earlier time);
 * - otherwise unknown (`null`). Publication time is NOT a substitute: it says when something was first
 *   published, not what the page showed later.
 *
 * Derived only from fields that exist today; no dedicated capture-time field is assumed.
 */
export function contentAsOf(
  e: Pick<VerifiedEvidence, 'freshFetch' | 'observedAt' | 'providerLastUpdatedAt'>,
): Ms | null {
  if (e.freshFetch) return e.observedAt;
  return e.providerLastUpdatedAt;
}
