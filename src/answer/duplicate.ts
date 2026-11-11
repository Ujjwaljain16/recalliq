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
