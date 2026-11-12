import { findAmounts, markerFor } from './currency.js';

/**
 * Binding of unit and billing-period cues to the amount they describe, for a quote that holds several prices
 * ("Essentials $49/month (monthly) or $35/month (annual)"). A cue that belongs to another price must never
 * satisfy the claim for this one.
 *
 * Within one segment each price owns:
 *  - its head: the text right after it, up to the first separator (comma, semicolon, pipe, colon, "or",
 *    "and", full stop; separators inside parentheses do not count);
 *  - billing clauses that continue it ("..., billed annually");
 *  - a label before it, when the piece just before it is nothing but a cue ("| monthly | $49 |").
 * Text before the first price (and what trails the last price) belongs to no price in particular and is
 * shared: "Current list rates (per seat) are approximately: ...". A cue-only piece sitting between two prices
 * is given to the following price when the first price was labelled first, to the previous one when the first
 * price carried its cue after it, and is ambiguous otherwise.
 */

const MASK = '§';
const BOUNDARY = /[,;|:\n]|\s(?:or|and)\s|\.(?=\s|$)/g;
const LEADING_BOUNDARY = /^\s*(?:[,;|:]|(?:or|and)\s|\.(?:\s|$))/i;
const CONTINUATION = /^(?:billed|paid|charged)\b/i;
const PURE_CUE =
  /^(?:[\s/()-]|per|mo|month|monthly|year|yearly|annual|annually|billed|paid|charged|user|seat|seats|member|each|one[- ]time|a|an|every|flat|fee|rate)+$/i;

interface Piece {
  text: string;
}

/** Splits at separators that are not inside parentheses. Empty pieces are dropped. */
function pieces(text: string): Piece[] {
  const masked = text.replace(/\([^)]*\)/g, (m) =>
    m.replace(/[,;|:\n]/g, MASK).replace(/\s(or|and)\s/gi, (x) => MASK.repeat(x.length)),
  );
  const out: Piece[] = [];
  let from = 0;
  for (const m of masked.matchAll(BOUNDARY)) {
    out.push({ text: text.slice(from, m.index) });
    from = m.index + m[0].length;
  }
  out.push({ text: text.slice(from) });
  return out.map((p) => ({ text: p.text.trim() })).filter((p) => p.text.length > 0);
}

export interface PriceBinding {
  /** Cue text attached to the claimed amount (head, continuations, label). */
  own: string;
  /** Cue text that belongs to no particular price. */
  shared: string;
  /** Cue text attached to the other prices. */
  others: string;
  /** A cue-only piece between two prices could belong to either. */
  ambiguous: boolean;
  /** The same amount appears at more than one price in the segment. */
  duplicateAmount: boolean;
}

interface Owned {
  head: string[];
  label: string[];
}

/**
 * The binding of the amount whose digits start at `digitStart` (offset in `seg`), or null when the segment
 * holds a single price, so single-price quotes are judged exactly as before.
 */
export function bindPrice(seg: string, digitStart: number): PriceBinding | null {
  const prices = findAmounts(seg)
    .filter((t) => seg.charAt(t.end) !== '%')
    .map((t) => ({ t, m: markerFor(seg, t) }))
    .filter((x) => x.m.hasMarker)
    .sort((a, b) => a.m.start - b.m.start);
  const me = prices.findIndex((p) => p.t.start === digitStart);
  const mine = prices[me];
  if (prices.length < 2 || !mine) return null;

  const owned: Owned[] = prices.map(() => ({ head: [], label: [] }));
  const shared: string[] = [];
  const lastIndex = prices.length - 1;
  const cueOnly = (p: Piece) => PURE_CUE.test(p.text) && !CONTINUATION.test(p.text);

  // After each price: a head glued to it, and billing clauses that continue it.
  let trailingCue = false;
  prices.forEach((price, j) => {
    const next = prices[j + 1];
    const gap = seg.slice(price.m.end, next ? next.m.start : seg.length);
    const ps = pieces(gap);
    const o = owned[j];
    if (!o) return;
    const glued = !LEADING_BOUNDARY.test(gap);
    const head = glued ? ps[0] : undefined;
    if (head) o.head.push(head.text);
    const clauses = glued ? ps.slice(1) : ps;
    for (const p of clauses) if (CONTINUATION.test(p.text)) o.head.push(p.text);
    if (j === lastIndex) {
      for (const p of clauses) {
        if (CONTINUATION.test(p.text)) continue;
        // a trailing cue-only cell after the last price continues it ("| $35 | annual |")
        if (!glued && cueOnly(p) && clauses.length === 1) {
          o.head.push(p.text);
          trailingCue = true;
        } else shared.push(p.text);
      }
    }
  });

  // Before the first price: a cue-only piece right before it is its label; the rest is shared.
  const first = prices[0];
  const prefix = pieces(seg.slice(0, first ? first.m.start : 0));
  const lastPrefix = prefix[prefix.length - 1];
  let firstLabelled = false;
  if (lastPrefix && cueOnly(lastPrefix)) {
    owned[0]?.label.push(lastPrefix.text);
    prefix.pop();
    firstLabelled = true;
  }
  shared.push(...prefix.map((p) => p.text));

  // Between prices: a separate cue-only piece before a price is its label. When it is the only piece in the
  // gap it could equally continue the previous price, so the layout decides: labels first, or cues after.
  let ambiguous = false;
  const cuesAfter = !firstLabelled && ((owned[0]?.head.length ?? 0) > 0 || trailingCue);
  for (let j = 1; j < prices.length; j++) {
    const prev = prices[j - 1];
    const here = prices[j];
    if (!prev || !here) continue;
    const gap = seg.slice(prev.m.end, here.m.start);
    const glued = !LEADING_BOUNDARY.test(gap);
    const ps = pieces(gap);
    const before = glued ? ps.slice(1) : ps;
    const piece = before[before.length - 1];
    if (!piece || !cueOnly(piece)) continue;
    if (before.length > 1 || glued) owned[j]?.label.push(piece.text);
    else if (firstLabelled) owned[j]?.label.push(piece.text);
    else if (cuesAfter) owned[j - 1]?.head.push(piece.text);
    else ambiguous = true;
  }

  const text = (o: Owned) => [...o.head, ...o.label].join(' ');
  const own = owned[me];
  return {
    own: own ? text(own) : '',
    shared: shared.join(' '),
    others: owned
      .filter((_, j) => j !== me)
      .map(text)
      .join(' '),
    ambiguous,
    duplicateAmount: prices.some((p, j) => j !== me && p.t.amount === mine.t.amount),
  };
}
