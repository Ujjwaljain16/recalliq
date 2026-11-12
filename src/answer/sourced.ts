import type { SentenceIssue } from '../shared/answer.js';
import type { SnapshotId } from '../shared/ids.js';
import { EMAIL, URL_LIKE } from './excerpts.js';
import { checkGrounding, type GroundingContext, type GroundingSource } from './grounding.js';

/** A sourced sentence may quote at most this many characters (placeholders excluded). */
export const MAX_SOURCED_SENTENCE_CHARS = 200;
/** All sourced sentences of one answer together may quote at most this many characters. */
export const MAX_SOURCED_ANSWER_CHARS = 1_200;

export interface SourcedContext extends GroundingContext {
  /**
   * The sources shown to the model with an excerpt in this turn, keyed by their server-minted id, holding exactly
   * the excerpt text the model saw. A sourced sentence may cite only these: any other id (a source of an earlier
   * turn, a source with no excerpt, an id typed from history) fails closed.
   */
  shown: ReadonlyMap<SnapshotId, GroundingSource>;
}

const TOKEN = /\[\[[^\]]*\]\]/g;
const LABEL_STOP = new Set(
  'www com org net io dev app api co uk de fr docs blog news help support example'.split(' '),
);

/**
 * Every check of a sourced sentence besides T3a: each citation must be a shown source of this turn, the
 * sentence must contain no link or email address, it must stay within the per-sentence quote cap and within
 * what is left of the per-answer cap (`usedChars` so far), and it must pass the grounding check against ONE of
 * the excerpts it cites. Returns the issues and the quoted length this sentence would add.
 */
export function checkSourced(
  template: string,
  cited: readonly SnapshotId[],
  ctx: SourcedContext,
  usedChars: number,
): { issues: SentenceIssue[]; chars: number } {
  const issues: SentenceIssue[] = [];
  const sources: GroundingSource[] = [];
  for (const id of cited) {
    const src = ctx.shown.get(id);
    if (src) sources.push(src);
    else if (!issues.includes('ungrounded_source')) issues.push('ungrounded_source');
  }
  const free = template.replace(TOKEN, ' ');
  if (new RegExp(URL_LIKE.source, URL_LIKE.flags).test(free)) issues.push('sourced_link');
  else if (new RegExp(EMAIL.source, EMAIL.flags).test(free)) issues.push('sourced_link');
  const chars = free.replace(/\s+/g, ' ').trim().length;
  if (chars > MAX_SOURCED_SENTENCE_CHARS || usedChars + chars > MAX_SOURCED_ANSWER_CHARS) {
    issues.push('sourced_too_long');
  }
  issues.push(...checkGrounding(template, sources, ctx));
  return { issues, chars };
}

/** True when the sentence already names one of its sources: its domain, or a distinctive label of it. */
function names(text: string, source: GroundingSource): boolean {
  const lower = text.toLowerCase();
  const domain = source.domain.toLowerCase().replace(/^www\./, '');
  if (lower.includes(domain)) return true;
  return domain
    .split('.')
    .filter((l) => l.length >= 3 && !LABEL_STOP.has(l))
    .some((l) => new RegExp(`(?<![\\p{L}\\p{N}])${l}`, 'u').test(lower));
}

/**
 * Attribution: a released sourced sentence always says where it comes from. When it names none of its cited
 * sources, code opens it with "According to <domain>: ". Applied to the template and the text alike, so what is
 * stored is what was shown.
 */
export function attribute(
  sentence: { template: string; text: string },
  cited: readonly SnapshotId[],
  ctx: SourcedContext,
): { template: string; text: string } {
  const sources = cited.flatMap((id) => {
    const s = ctx.shown.get(id);
    return s ? [s] : [];
  });
  const first = sources[0];
  if (!first) return sentence;
  if (sources.some((s) => names(sentence.text.replace(TOKEN, ' '), s))) {
    return keepDomainSpelling(sentence, sources);
  }
  const prefix = `According to ${bareDomain(first.domain)}: `;
  return { template: prefix + sentence.template, text: prefix + sentence.text };
}

/** A domain as stored (lower case), without a leading `www.`. Never re-cased for the start of a sentence. */
const bareDomain = (domain: string): string => domain.toLowerCase().replace(/^www\./, '');

/**
 * An opening "According to Usatoday.com" written by the model is given the domain exactly as stored
 * ("usatoday.com"): a domain is not a word to capitalise. Only an exact, case-insensitive match of a cited
 * domain right after the opening "According to" is touched.
 */
function keepDomainSpelling(
  sentence: { template: string; text: string },
  sources: readonly GroundingSource[],
): { template: string; text: string } {
  const fix = (s: string): string => {
    const m = /^(\s*according to\s+)(?:www\.)?([^\s:,;]+?)(?=[\s:,;]|$)/i.exec(s);
    const written = m?.[2];
    if (!m || written === undefined) return s;
    const own = sources.find((x) => bareDomain(x.domain) === written.toLowerCase());
    if (!own) return s;
    return `${m[1] ?? ''}${bareDomain(own.domain)}${s.slice(m[0].length)}`;
  };
  return { template: fix(sentence.template), text: fix(sentence.text) };
}
