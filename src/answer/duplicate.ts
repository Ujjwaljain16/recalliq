/**
 * Duplicate-text check. A placeholder renders a complete statement or value by itself ("no verified price was
 * found", "US$90 per user per month (pro) [1]"), so the free text around it must not say the same thing again
 * ("No verified price was found for Neon [[F1]]." would be read as "... for Neon no verified price was found.").
 *
 * A sentence is flagged when its free text, compared case-insensitively and ignoring punctuation and
 * whitespace, contains the whole rendered text of one of its placeholders (when that has at least two
 * words), or a distinctive run of three consecutive words of it. This is a backstop for the common failure,
 * not a paraphrase detector: a restatement in different words passes.
 */

/** Words that carry no content of their own; a run made only of these (and one other word) is not distinctive. */
const STOPWORDS = new Set(
  'a an and are as at be been by for from in is it its of on or per the this that to was were with user users month months year years seat seats plan'.split(
    ' ',
  ),
);

/** Number of consecutive words that counts as a repeated run. */
export const RUN_WORDS = 3;
/** A run is distinctive when at least this many of its words are not stopwords. */
export const MIN_CONTENT_WORDS = 2;

/** What a sentence says, for spotting a repeat: its numbers and the product and plan names it uses. */
export interface ClaimSignature {
  numbers: Set<string>;
  names: Set<string>;
}

export function claimSignature(text: string): ClaimSignature {
  const plain = text.normalize('NFKC');
  const numbers = new Set(plain.match(/\d[\d,.]*\d|\d/g)?.map((n) => n.replace(/,/g, '')) ?? []);
  // The "According to <domain>" opening says where a statement comes from, not what it says.
  const body = plain.replace(/according to \S+/gi, ' ');
  const names = new Set((body.match(/\p{Lu}[\p{L}\p{N}-]*/gu) ?? []).map((n) => n.toLowerCase()));
  return { numbers, names };
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * True when a sentence repeats an earlier one: the same numbers (at least one, the citation number included) and
 * product or plan names that one sentence contains in full in the other. The quick section and the verified
 * section can both quote the same source; the second quote is dropped. Two different products at the same price
 * from the same source are not a repeat, because neither's names contain the other's.
 */
export function repeatsClaim(a: ClaimSignature, b: ClaimSignature): boolean {
  if (a.numbers.size === 0 || a.numbers.size !== b.numbers.size) return false;
  if (!isSubset(a.numbers, b.numbers)) return false;
  return isSubset(a.names, b.names) || isSubset(b.names, a.names);
}

/** Lower case, letters and digits only, split into words. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/**
 * True when the free text repeats what a placeholder renders. `template` has its placeholders as `[[...]]`
 * tokens; free-text segments are the pieces between them, so a run never spans a placeholder.
 */
export function repeatsRenderedText(
  template: string,
  placeholders: ReadonlyArray<{ rendered: string }>,
): boolean {
  const segments = template.split(/\[\[[^\]]*\]\]/).map(words);
  for (const p of placeholders) {
    const rw = words(p.rendered);
    if (rw.length === 0) continue;
    if (rw.length >= 2 && segments.some((seg) => containsRun(seg, rw))) return true;
    for (let i = 0; i + RUN_WORDS <= rw.length; i++) {
      const run = rw.slice(i, i + RUN_WORDS);
      if (run.filter((w) => !STOPWORDS.has(w)).length < MIN_CONTENT_WORDS) continue;
      if (segments.some((seg) => containsRun(seg, run))) return true;
    }
  }
  return false;
}
