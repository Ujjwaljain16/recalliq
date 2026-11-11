export class InvalidUrlError extends Error {
  constructor(reason: string) {
    super(`Invalid source URL: ${reason}`);
    this.name = 'InvalidUrlError';
  }
}

export interface NormalizedUrl {
  /** The URL as it will be stored and cited: no credentials, no fragment. Query kept as received. */
  url: string;
  /** Source identity (`url_norm`). */
  urlNorm: string;
  /** Lowercase host without `www.` and without port. */
  domain: string;
}

const MAX_URL_LENGTH = 2048;

/**
 * Tracking-only query parameters. Deliberately narrow: anything not listed is kept, because parameters such as
 * `plan`, `currency`, `country`, `region`, `lang`, `billing`, `id` or a bare `ref` can change what a page shows
 * (Q-001 decision D2: remove ONLY tracking parameters). The architecture sketch also names bare `ref`; it is kept
 * here because it can be meaningful (a git ref, a plan reference). Reported to the orchestrator.
 */
const TRACKING_EXACT = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'mkt_tok',
  'vero_id',
  'oly_anon_id',
  'oly_enc_id',
  'ref_src',
  'ref_url',
  'spm',
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_EXACT.has(n);
}

/**
 * Normalises a URL for source identity. Only http and https are accepted. Lowercases scheme and host, drops
 * credentials, fragment, default port, a leading `www.`, tracking parameters and a trailing slash, resolves dot
 * segments, and sorts the remaining query parameters so their order does not matter. Throws `InvalidUrlError`.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH)
    throw new InvalidUrlError('empty or too long');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new InvalidUrlError('not parseable');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidUrlError(`unsupported scheme ${u.protocol}`);
  }
  if (u.hostname === '') throw new InvalidUrlError('no host');

  u.username = '';
  u.password = '';
  u.hash = '';

  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) if (!isTrackingParam(k)) kept.push([k, v]);
  kept.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  const query = new URLSearchParams(kept).toString();

  const host = u.hostname.replace(/^www\./, '');
  const port = u.port === '' ? '' : `:${u.port}`;
  const path = u.pathname.replace(/\/+$/, '');

  // `url` keeps the page's own host spelling and query, minus credentials and fragment.
  const url = u.toString();
  return {
    url,
    urlNorm: `${u.protocol}//${host}${port}${path}${query ? `?${query}` : ''}`,
    domain: host,
  };
}
