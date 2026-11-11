/**
 * Query terms for ranking sources and choosing excerpts: lower-case words of at least three letters or digits,
 * without common function words. Pure and deterministic; used only to order and trim untrusted text, never to
 * decide what is true.
 */
const STOP = new Set(
  'the and for with what which who whom whose when where why how does did doing done are was were has have had this that these those from into about than then them they their there here its not but you your our can could would should will shall may might must any all some most more less latest recent new now today tell show give find much many'.split(
    ' ',
  ),
);

export function termsOf(...texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text
      .normalize('NFKC')
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}][\p{L}\p{N}.]*/gu)) {
      const w = m[0].replace(/\.+$/, '');
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
      else if (/^\d+$/.test(w) && w.length >= 2) out.add(w);
    }
  }
  return [...out];
}

/** How many distinct terms occur in `text` (case-insensitive substring match). */
export function termHits(text: string, terms: readonly string[]): number {
  const hay = text.normalize('NFKC').toLowerCase();
  let n = 0;
  for (const t of terms) if (hay.includes(t)) n++;
  return n;
}
