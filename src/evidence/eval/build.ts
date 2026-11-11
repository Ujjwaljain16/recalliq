import { createHash } from 'node:crypto';
import { normalizeUrl } from '../../sources/url.js';
import type {
  EntityContext,
  RawEvidence,
  SourceSnapshot,
  VerifiedEvidence,
} from '../../shared/evidence.js';
import type { EntityId, SnapshotId } from '../../shared/ids.js';
import type { CalibrationPage, GoldClaim, GoldFile, PageFile } from './gold.js';

/** Stable ids for the single entity and single snapshot of a calibration page. */
export const entityIdOf = (pageId: string): EntityId => `ent_${pageId}`;
export const snapshotIdOf = (pageId: string): SnapshotId => `src_${pageId}`;

/** The page as a source snapshot, the way the research pipeline would have stored a recorded fetch. */
export function snapshotOf(pageId: string, page: PageFile): SourceSnapshot {
  const n = normalizeUrl(page.url);
  return {
    id: snapshotIdOf(pageId),
    url: page.url,
    urlNorm: page.urlNorm,
    domain: n.domain,
    title: page.title ?? null,
    text: page.text,
    contentMode: 'text',
    sha256: createHash('sha256').update(page.text).digest('hex'),
    provider: page.provider,
    providerPublishedAt: null,
    providerLastUpdatedAt: null,
    observedAt: Date.parse(page.capturedAt),
    freshFetch: false,
    crawlStatus: 'unknown',
    origin: 'recorded',
  };
}

export function entityContextOf(pageId: string, gold: GoldFile): EntityContext {
  return {
    id: entityIdOf(pageId),
    aliases: [...gold.entity.aliases],
    plans: [...gold.entity.knownPlans],
    officialDomains: [...gold.entity.officialDomains],
    otherEntityAliases: [...gold.entity.otherEntityAliases],
  };
}

/** The ideal extraction of a gold claim: exactly what a perfect extractor would have proposed. */
export function goldClaimToRaw(pageId: string, claim: GoldClaim): RawEvidence {
  return {
    snapshotRef: snapshotIdOf(pageId),
    entityRef: entityIdOf(pageId),
    kind: 'price',
    fields: {
      plan: claim.plan,
      planNorm: claim.planNorm,
      attribute: 'price',
      value: { ...claim.value },
      conditions: claim.conditions,
    },
    quote: claim.quote,
    contextQuote: claim.contextQuote,
    polarity: 'affirmed',
    modality: claim.modality,
    effectiveFromText: null,
    eventDateText: null,
    significance: null,
    significanceReason: null,
  };
}

/** The checks that did not pass, as "check: outcome (detail)". */
export function failingChecks(ev: VerifiedEvidence): string[] {
  return ev.verification.checks
    .filter((c) => c.outcome === 'weak' || c.outcome === 'fail')
    .map((c) => `${c.check}: ${c.outcome}${c.detail ? ` (${c.detail})` : ''}`);
}

export function pageOf(p: CalibrationPage): { snapshot: SourceSnapshot; entity: EntityContext } {
  return { snapshot: snapshotOf(p.id, p.page), entity: entityContextOf(p.id, p.gold) };
}
