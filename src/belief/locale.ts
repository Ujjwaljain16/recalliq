/**
 * Locale from the source URL (ADR-37). Derived by code, never by the model, never from currency.
 * Evidence from several places is combined conservatively: anything unknown or contradictory is `und`.
 */

/** ISO 639-1 language codes accepted as a bare path segment or subdomain. */
const LANGUAGES = new Set(
  'aa ab af ak am ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(
    ' ',
  ),
);

/** Tracking and navigation words that are never locales even when they look like one. */
const NOT_LOCALES = new Set(['id', 'to', 'my', 'is', 'as', 'or', 'in', 'uk']);

const QUERY_KEYS = ['lang', 'locale', 'language', 'hl', 'lc'];

function canonical(tag: string): string | null {
  const cleaned = tag.replace(/_/g, '-');
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(cleaned)) return null;
  const [lang, region] = cleaned.split('-');
  if (!lang || !LANGUAGES.has(lang.toLowerCase())) return null;
  if (lang.length === 2 && NOT_LOCALES.has(lang.toLowerCase()) && region === undefined) return null;
  if (region !== undefined && !/^[A-Za-z]{2}$/.test(region)) return null;
  try {
    return Intl.getCanonicalLocales(cleaned)[0] ?? null;
  } catch {
    return null;
  }
}

function parseUrl(urlNorm: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(urlNorm) ? urlNorm : `https://${urlNorm}`);
  } catch {
    return null;
  }
}

export interface LocaleSources {
  path: string | null;
  subdomain: string | null;
  query: string | null;
}

export function localeSources(urlNorm: string): LocaleSources {
  const url = parseUrl(urlNorm);
  if (!url) return { path: null, subdomain: null, query: null };
  const first = url.pathname.split('/').find((p) => p.length > 0);
  const path = first ? canonical(first) : null;
  const labels = url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const sub = labels.length > 2 ? labels[0] : undefined;
  const subdomain = sub ? canonical(sub) : null;
  let query: string | null = null;
  for (const key of QUERY_KEYS) {
    const v = url.searchParams.get(key);
    if (v) {
      query = canonical(v);
      if (query) break;
    }
  }
  return { path, subdomain, query };
}

/** The canonical BCP-47 locale of a source URL, or `und`. Disagreeing signals give `und`. */
export function deriveLocale(urlNorm: string): string {
  const { path, subdomain, query } = localeSources(urlNorm);
  const found = [path, subdomain, query].filter((x): x is string => x !== null);
  const first = found[0];
  if (first === undefined) return 'und';
  return found.every((f) => f === first) ? first : 'und';
}
