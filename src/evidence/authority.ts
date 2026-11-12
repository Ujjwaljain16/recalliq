import type { AuthorityClassifier, AuthorityTier, SourceSnapshot } from '../shared/evidence.js';

/** Second-level suffixes under which the registrable domain has three labels (a small, explicit list). */
const COMPOUND_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.in',
  'co.jp',
  'co.kr',
  'co.za',
  'com.br',
  'com.mx',
  'com.sg',
  'com.hk',
  'com.cn',
  'com.tr',
  'com.ar',
]);

export function hostOf(urlOrHost: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)
    ? urlOrHost
    : `https://${urlOrHost}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return urlOrHost.toLowerCase();
  }
}

/** The registrable domain of a host ("pricing.hubspot.com" -> "hubspot.com", "x.co.uk" -> "x.co.uk"). */
export function registrableDomain(urlOrHost: string): string {
  const labels = hostOf(urlOrHost)
    .replace(/^www\./, '')
    .split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return COMPOUND_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** True when `host` is exactly an official domain or a subdomain of one. `acme.com.evil.example` is not. */
export function isOfficialHost(host: string, officialDomains: readonly string[]): boolean {
  const h = hostOf(host).replace(/^www\./, '');
  return officialDomains.some((d) => {
    const o = hostOf(d).replace(/^www\./, '');
    return o.length > 0 && (h === o || h.endsWith(`.${o}`));
  });
}

export const PRICING_PATH =
  /(?:^|\/)(?:pricing|plans?|prices?|plans-and-pricing|pricing-plans|buy|compare-plans)(?:\/|$|[-_.])/i;
export const PRICING_HOST_LABEL = /^(?:pricing|plans|store|buy)\./i;

export interface AuthorityOptions {
  /** Curated reputable secondary sources (tier B). Injected; the default is deliberately short. */
  secondaryDomains?: readonly string[];
}

export const DEFAULT_SECONDARY_DOMAINS: readonly string[] = [
  'g2.com',
  'capterra.com',
  'reuters.com',
  'techcrunch.com',
  'theverge.com',
  'zdnet.com',
];

/**
 * A1: an official domain's pricing or product page. A2: any other page on an official domain
 * (announcements, docs, changelog). B: a curated secondary source. C: everything else. The title, and the
 * page text, play no part: only the host and the path do.
 */
export class DomainAuthorityClassifier implements AuthorityClassifier {
  private readonly secondary: readonly string[];

  constructor(opts: AuthorityOptions = {}) {
    this.secondary = opts.secondaryDomains ?? DEFAULT_SECONDARY_DOMAINS;
  }

  classify(s: SourceSnapshot, officialDomains: string[]): AuthorityTier {
    const source = s.url || s.domain;
    if (!isOfficialHost(source, officialDomains)) return this.secondaryOrC(s);
    let path: string;
    try {
      path = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s.url) ? s.url : `https://${s.urlNorm}`)
        .pathname;
    } catch {
      path = '';
    }
    return PRICING_PATH.test(path) || PRICING_HOST_LABEL.test(hostOf(source)) ? 'A1' : 'A2';
  }

  private secondaryOrC(s: SourceSnapshot): AuthorityTier {
    return isOfficialHost(s.url || s.domain, this.secondary) ? 'B' : 'C';
  }
}
