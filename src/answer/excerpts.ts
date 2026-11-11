import type { FindingSet } from '../shared/findings.js';
import type { Ms, SnapshotId } from '../shared/ids.js';
import { termHits } from '../shared/terms.js';
import { defuse } from '../llm/prompts/synthesis.js';

/** At most this many sources are shown to the answer model with an excerpt. */
export const EXCERPT_SOURCES = 6;
/** At most this many characters of one source. */
export const EXCERPT_CHARS = 1_200;
/** At most this many excerpt characters in one prompt. */
export const EXCERPT_TOTAL_CHARS = 8_000;

export interface SourceExcerpt {
  id: SnapshotId;
  domain: string;
  title: string | null;
  publishedAt: Ms | null;
  /**
   * Exactly the text the answer model is shown: links, email addresses and markdown removed, defused. A sourced
   * sentence is checked against this text, never against anything the model did not see.
   */
  excerpt: string;
}

/** A link: a scheme URL or a bare www. address. */
export const URL_LIKE = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;
/** An email address. */
export const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/**
 * Page text made fit to show or quote: markdown images and links reduced to their text, links and email
 * addresses removed, markdown emphasis, heading and quote markers dropped, invisible characters removed and
 * fences defused. Whitespace is kept (pricing tables rely on line structure).
 */
export function sanitizePageText(text: string): string {
  return defuse(
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(URL_LIKE, '')
      .replace(EMAIL, '')
      .replace(/^[ \t]*(?:#{1,6}|>+)[ \t]+/gm, '')
      .replace(/\*\*|__|`+/g, ''),
  );
}

/** One line of page text for a rendering: sanitised, on one line, at most `max` characters. */
export function pageLine(text: string, max: number): string {
  const line = sanitizePageText(text).replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

const tidy = (text: string): string =>
  text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Where the terms occur in the text (case-insensitive). */
function hitsOf(text: string, terms: readonly string[]): number[] {
  const hay = text.toLowerCase();
  const out: number[] = [];
  for (const t of terms) {
    for (let i = hay.indexOf(t); i !== -1; i = hay.indexOf(t, i + t.length)) out.push(i);
  }
  return out;
}

/** A hit counts for a window only with this much room after it, so the line it is on is not cut off. */
const HIT_ROOM = 80;

/**
 * The part of `text` (at most `limit` characters) that holds the most occurrences of the terms, starting at a
 * line or sentence start; the earliest such window on a tie, so a text without any term yields its beginning.
 * A cut is marked with an ellipsis, counted in `limit`.
 */
export function bestWindow(text: string, terms: readonly string[], limit: number): string {
  const t = tidy(text);
  if (t.length <= limit) return t;
  const chars = Math.max(1, limit - 2);
  const starts = [0];
  for (const m of t.matchAll(/\n|[.!?] /g)) starts.push(m.index + m[0].length);
  const hits = hitsOf(t, terms);
  const room = Math.min(HIT_ROOM, Math.floor(chars / 2));
  let best = 0;
  let bestScore = -1;
  for (const s of starts) {
    const score = hits.filter((h) => h >= s && h + room <= s + chars).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  let window = t.slice(best, best + chars);
  if (best + chars < t.length) {
    const cut = window.lastIndexOf(' ');
    if (cut > chars / 2) window = window.slice(0, cut);
    window = `${window}…`;
  }
  return best > 0 ? `…${window}` : window;
}

/**
 * The excerpts the answer model sees: sources with content of this turn only, those matching more query terms
 * first (ties keep the order of the sources), at most `EXCERPT_SOURCES`, each at most `EXCERPT_CHARS`, and
 * `EXCERPT_TOTAL_CHARS` in all.
 */
export function selectExcerpts(
  sources: FindingSet['sources'],
  terms: readonly string[],
): SourceExcerpt[] {
  const ranked = Object.entries(sources)
    .flatMap(([id, s], order) =>
      s.content && s.content.text.trim().length > 0
        ? [
            {
              id: id as SnapshotId,
              s,
              text: s.content.text,
              order,
              score: termHits(`${s.title ?? ''}\n${s.content.text}`, terms),
            },
          ]
        : [],
    )
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, EXCERPT_SOURCES);
  const out: SourceExcerpt[] = [];
  let left = EXCERPT_TOTAL_CHARS;
  for (const r of ranked) {
    if (left <= 0) break;
    const excerpt = bestWindow(sanitizePageText(r.text), terms, Math.min(EXCERPT_CHARS, left));
    left -= excerpt.length;
    out.push({
      id: r.id,
      domain: r.s.domain,
      title: r.s.title === null ? null : pageLine(r.s.title, 200),
      publishedAt: r.s.content?.publishedAt ?? null,
      excerpt,
    });
  }
  return out;
}
