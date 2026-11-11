import {
  hostOf,
  isOfficialHost,
  PRICING_HOST_LABEL,
  PRICING_PATH,
  registrableDomain,
} from './authority.js';
import { findPhrase, normalizeText } from './text.js';

/**
 * Registered domain ownership as subject-binding evidence (ADR-41).
 *
 * A domain the owner's registry explicitly maps to an entity makes that entity the publisher of a page on the
 * domain. That is page-level evidence only: a price is attributed to the entity when it is also tied to one of
 * the entity's own plans (the plan binding must pass) and nothing on or above the statement signals that the
 * price is somebody else's. The blockers are conservative and deterministic; they are not a semantic detector.
 * When one fires the subject binding stays weak, exactly as it is without a registry.
 */

/** "Compare plans" is a navigation label on a vendor's own page, not a comparison with another vendor. */
const COMPARISON =
  /\b(?:vs\.?|versus|compared\s+(?:to|with)|comparison|compare(?!\s+(?:plans?|features|editions|tiers|packages|all))|alternatives?\s+to|alternative\s+to|switch(?:ing)?\s+from|instead\s+of|better\s+than|competitors?)\b/i;
const INTEGRATION =
  /\b(?:integrat(?:es|ion|ions|ed)\s+with|integrations?|connectors?|app\s+marketplace|marketplace|powered\s+by|built\s+on|add-?ons?\s+from|third[- ]party|plug-?ins?|extensions?\s+from)\b/i;
const PARTNER =
  /\b(?:partners?|partnership|resellers?|agency|agencies|authori[sz]ed\s+dealer|certified\s+(?:partner|consultant)|listing\s+by)\b/i;
const TESTIMONIAL =
  /\b(?:testimonials?|customer\s+stor(?:y|ies)|case\s+stud(?:y|ies)|reviews?|reviewed\s+by|according\s+to|said|says)\b/i;
/** Quotation marks around a sentence that holds a number: somebody is being quoted. */
const QUOTED_NUMBER = /["“”][^"“”]{0,300}\d[^"“”]{0,300}["“”]/;
/** Embedded external content: widgets, iframes, tables pulled in from another site. */
const EMBEDDED = /\b(?:embedded|iframe|widget|via\s+[A-Z][\w.-]+\.(?:com|io|net|org))\b/i;
const ORG_PRICING =
  /\b([A-Z][A-Za-z0-9&.-]*(?:[ \t]+[A-Z][A-Za-z0-9&.-]*){0,2})(?:'s)?[ \t]+(?:[Pp]ricing|[Pp]rice\s+[Ll]ist|[Pp]lans?)\b/g;
const GENERIC_LEAD = new Set([
  'our',
  'the',
  'current',
  'simple',
  'flexible',
  'transparent',
  'all',
  'choose',
  'view',
  'see',
  'pick',
  'your',
  'compare',
  'monthly',
  'annual',
  'yearly',
  'pricing',
  'plans',
  'plan',
  'free',
  'team',
  'business',
  'enterprise',
  'per',
  'seat',
  'subscription',
  'standard',
  'custom',
  'volume',
  'usage',
  'cloud',
  'pay',
  'new',
  'crm',
  'sales',
  'deal',
  'deals',
  'default',
  'managed',
  'database',
  'databases',
  'hosting',
  'marketing',
  'service',
  'services',
  'software',
  'product',
  'products',
  'platform',
  'api',
  'support',
  'hub',
  'and',
  'for',
  'of',
]);

export interface OwnershipInput {
  title: string | null;
  /** Up to 1,500 characters of the page above the quote. */
  above: string;
  contextQuote: string | null;
  quote: string;
  selfAliases: readonly string[];
  otherAliases: readonly string[];
  plans: readonly string[];
}

/** The registered domain that owns the page's host, or null. */
export function ownedDomainOf(
  source: string,
  ownedDomains: readonly string[] | undefined,
): string | null {
  if (!ownedDomains || ownedDomains.length === 0) return null;
  if (!isOfficialHost(source, ownedDomains)) return null;
  const host = hostOf(source).replace(/^www\./, '');
  const hit = ownedDomains.find((d) => {
    const o = hostOf(d).replace(/^www\./, '');
    return host === o || host.endsWith(`.${o}`);
  });
  return hit === undefined ? registrableDomain(source) : hostOf(hit).replace(/^www\./, '');
}

/** The page is clearly presenting pricing, plans or products: a pricing path or host, a title or a heading. */
export function pageLooksLikePricing(
  url: string,
  urlNorm: string,
  title: string | null,
  text: string,
): boolean {
  let path: string;
  try {
    path = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${urlNorm}`).pathname;
  } catch {
    path = '';
  }
  if (PRICING_PATH.test(path) || PRICING_HOST_LABEL.test(hostOf(url || urlNorm))) return true;
  const word = /\b(?:pricing|plans?|price\s+list|rates)\b/i;
  if (title !== null && word.test(title)) return true;
  return text.split('\n').some((l) => l.trim().length > 0 && l.length < 80 && word.test(l));
}

/** Why the page-level attribution must not be inherited by this price, or null when nothing blocks it. */
export function ownershipBlocker(i: OwnershipInput): string | null {
  const region = normalizeText([i.title ?? '', i.above, i.contextQuote ?? '', i.quote].join('\n'));
  const checks: Array<[RegExp, string]> = [
    [COMPARISON, 'a comparison with another product'],
    [INTEGRATION, 'an integration or third-party product'],
    [PARTNER, 'a partner, reseller or agency listing'],
    [TESTIMONIAL, 'a testimonial, review or quoted material'],
    [EMBEDDED, 'embedded external content'],
  ];
  for (const [re, why] of checks) if (re.test(region)) return why;
  if (QUOTED_NUMBER.test(normalizeText(i.quote))) return 'a quoted price';
  for (const alias of i.otherAliases)
    if (findPhrase(region, alias).length > 0) return `another known entity (${alias})`;
  for (const m of region.matchAll(ORG_PRICING)) {
    const name = m[1] ?? '';
    // Every word must be generic or part of this vendor's own name or plans; otherwise the capitalised phrase
    // may be another organisation's name.
    const ours = [...i.selfAliases, ...i.plans].map((a) => a.toLowerCase());
    const foreign = name.split(/\s+/).filter((w) => {
      const lw = w.toLowerCase();
      return !GENERIC_LEAD.has(lw) && !ours.some((o) => o.split(/\s+/).includes(lw));
    });
    if (foreign.length > 0) return `a price list of another organisation (${name})`;
  }
  return null;
}
