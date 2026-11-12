import { escapeRegExp } from '../shared/regexp.js';
import type { SentenceIssue } from '../shared/answer.js';
import { INVISIBLE } from '../llm/prompts/synthesis.js';
import {
  CURRENCY_PATTERNS,
  DATE_PATTERNS,
  DIGITS,
  FREE_DIGITS,
  PERCENT_PATTERNS,
  WORD_QUANTITY,
  monthNumber,
} from './t3a.js';

/**
 * The grounding check of a SOURCED sentence: a sentence the model wrote from the text of the sources, which cites
 * at least one source of this turn ([[S:src_..]]) and renders no finding. It is deterministic, runs on the
 * template with every placeholder removed, and compares the sentence only with the excerpts (title, domain and the
 * excerpt text exactly as the model was shown them) of the sources the sentence itself cites. No model takes part.
 *
 * Same-source binding: ONE cited excerpt must contain everything the sentence states, numbers and names together.
 * Citing two sources does not let a sentence take its number from one and its name or second number from the
 * other. Normalisation is identical on both sides and folds nothing: invisible and bidi characters are removed,
 * and any digit outside 0-9 or a full-width currency sign in the sentence fails the check outright (the excerpt
 * shown to the model was already NFKC-normalised, so an honest copy is ASCII).
 *
 * The rule, all strict:
 *  1. Every date (as T3a recognises dates: "3 November 2026", "Nov 3, 2026", "2026-11-03", "11/03/2026",
 *     "November 2026") must be a date of the cited text with the same day, month and year; a part the sentence
 *     leaves out (the year of "3 November") is not compared. Day/month order of a slash date may be either.
 *  2. Every version (three or more dotted parts, "24.1.0", "v24.1.0") must occur exactly in the cited text.
 *  3. Every currency amount must be an amount of the cited text in the same currency family with the same value.
 *     Normalised: thousands separators ("$1,200" = "$1200"), trailing zero decimals ("$20.00" = "$20"), symbol
 *     and code forms ("$20" = "US$20" = "USD 20" = "20 USD" = "20 dollars"; "€" = "EUR"; "£" = "GBP"; "CA$" =
 *     "CAD"; "A$" = "AUD"), magnitude words ("$1.5 million" = "$1,500,000"). A bare number in the text does not
 *     ground an amount: the source must state it as money.
 *  4. Every percentage must be a percentage of the cited text with the same value ("20%" = "20 percent").
 *  5. Every other number must occur as a number of the cited text, after the same normalisation (years
 *     included). The first component of a version in the text counts as a number ("24" from "24.1.0").
 *  6. Numbers written as words ("three plans", "twenty dollars") must occur as the same words in the cited text.
 *  7. Every capitalised name token of at least two letters ("Vercel", "Pro", "Node.js", "GPT-4o") must occur in
 *     the cited text as a whole word, ignoring case, unless it is the sentence's first word and a common word
 *     ("The", "Its", "According"), or the user's message contains it, or it is a word of the name or an alias of
 *     an entity of the turn. A month name inside a grounded date is part of that date.
 *
 * What it does not check: that a number is attached to the right thing (a correct price given to the wrong plan
 * passes when both occur in the cited text), negation, paraphrase, or lower-case content words. Change and
 * comparison words are not its business: T3a refuses them in a sourced sentence exactly as in any other.
 * Instructions inside a source are text like any other: they can only make a token "occur", never authorise a
 * citation, a finding, or a change word.
 */
export interface GroundingSource {
  title: string | null;
  domain: string;
  /** The excerpt shown to the model. Empty for a source the sentence may not rest on. */
  text: string;
}

export interface GroundingContext {
  userMessage: string;
  /** Names and aliases of the turn's entities. */
  entityNames: readonly string[];
}

type Issue = Extract<SentenceIssue, 'ungrounded_number' | 'ungrounded_name'>;

/** Words that are capitalised only because they start a sentence. Case-insensitive matching covers the rest. */
const COMMON_INITIAL = new Set(
  "a an the this that these those it its it's their there they he she we you your our his her my i'm i what which who when where why how yes no not also and but or so yet if as at by for from in into on of to with without about after before during since until while although though because however overall currently today according based both each every either neither all any some most many several few other another such per here note see use check read visit try compare unlike like only just even still otherwise instead meanwhile then thus therefore hence first second third finally next last".split(
    ' ',
  ),
);

/** The pronoun "I" in contractions is never a name. */
const PRONOUN = /^i(?:['’](?:m|ve|ll|d))?$/i;

const VERSION = /(?<![\p{L}\p{N}.])v?(\d+(?:\.\d+){2,})(?![.]?\d)/giu;
const NAME = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*(?:[.'’&-][\p{L}\p{N}]+)*/gu;
const LIST_MARKER = /^(\s*)(?:[-*]\s+)?\d{1,2}[.)](?=\s)/;
const MAGNITUDE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
};

/** The same on both sides: invisible and bidi characters removed, nothing folded (full-width stays full-width). */
const normalize = (s: string): string => s.replace(INVISIBLE, '');

/** "1,200" -> "1200"; "20.00" -> "20"; "20.50" stays. */
export function canonicalNumber(raw: string): string {
  const n = raw.replace(/,+$/, '').replace(/,/g, '');
  return n.replace(/\.0+$/, '');
}

function currencyOf(match: string): string {
  const m = match.toLowerCase();
  if (/ca\$|\bcad\b/.test(m)) return 'CAD';
  if (/(?:^|[^a-z])a\$|\baud\b/.test(m)) return 'AUD';
  if (/€|\beur\b|euro/.test(m)) return 'EUR';
  if (/£|\bgbp\b|pound/.test(m)) return 'GBP';
  if (/¥|\bjpy\b/.test(m)) return 'JPY';
  if (/₹|\binr\b/.test(m)) return 'INR';
  return 'USD'; // $, US$, USD, dollars, bucks
}

interface Amount {
  currency: string;
  value: number;
}

function amountOf(match: string): Amount | null {
  const digits = new RegExp(DIGITS).exec(match);
  if (!digits) return null;
  const base = Number(canonicalNumber(digits[0]));
  if (!Number.isFinite(base)) return null;
  const tail = match
    .slice(digits.index + digits[0].length)
    .trim()
    .toLowerCase();
  const word = /^(k|m|bn|million|billion|thousand)\b/.exec(tail)?.[1];
  const cents = /^cents?\b/.test(tail);
  const value = base * (word ? (MAGNITUDE[word] ?? 1) : 1) * (cents ? 0.01 : 1);
  return { currency: currencyOf(match), value };
}

const sameValue = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

interface DateParts {
  y: number | null;
  m: number;
  d: number | null;
}

function datesOf(kind: (typeof DATE_PATTERNS)[number]['kind'], m: RegExpExecArray): DateParts[] {
  const g = (i: number): string => m[i] ?? '';
  const year = (s: string): number | null => (s === '' ? null : Number(s));
  switch (kind) {
    case 'dmy':
      return [{ y: year(g(3)), m: monthNumber(g(2)), d: Number(g(1)) }];
    case 'mdy':
      return [{ y: year(g(3)), m: monthNumber(g(1)), d: Number(g(2)) }];
    case 'my':
      return [{ y: Number(g(2)), m: monthNumber(g(1)), d: null }];
    case 'iso':
      return [{ y: Number(g(1)), m: Number(g(2)), d: Number(g(3)) }];
    case 'slash': {
      const y = Number(g(3).length === 2 ? `20${g(3)}` : g(3));
      const a = Number(g(1));
      const b = Number(g(2));
      return [
        { y, m: b, d: a },
        { y, m: a, d: b },
      ];
    }
  }
}

/** True when the sentence's date is covered by a date of the text: every part the sentence states matches. */
function dateCovered(want: DateParts, have: readonly DateParts[]): boolean {
  return have.some(
    (h) =>
      h.m === want.m && (want.d === null || h.d === want.d) && (want.y === null || h.y === want.y),
  );
}

/** What the cited text states, parsed once per check. */
interface Corpus {
  lower: string;
  dates: DateParts[];
  versions: Set<string>;
  amounts: Amount[];
  percents: number[];
  numbers: Set<string>;
}

function corpusOf(source: GroundingSource): Corpus {
  const text = normalize(`${source.title ?? ''}\n${source.domain}\n${source.text}`);
  const dates: DateParts[] = [];
  for (const { re, kind } of DATE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) dates.push(...datesOf(kind, m));
  }
  const versions = new Set<string>();
  const numbers = new Set<string>();
  for (const m of text.matchAll(new RegExp(VERSION.source, VERSION.flags))) {
    const v = m[1] ?? '';
    versions.add(v);
    numbers.add(v.split('.')[0] ?? '');
  }
  const amounts: Amount[] = [];
  for (const re of CURRENCY_PATTERNS.slice(0, 2)) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const a = amountOf(m[0]);
      if (a) amounts.push(a);
    }
  }
  const percents: number[] = [];
  const percentRe = PERCENT_PATTERNS[0];
  if (percentRe) {
    for (const m of text.matchAll(new RegExp(percentRe.source, percentRe.flags))) {
      const d = new RegExp(DIGITS).exec(m[0]);
      if (d) percents.push(Number(canonicalNumber(d[0])));
    }
  }
  for (const m of text.matchAll(new RegExp(DIGITS, 'g'))) numbers.add(canonicalNumber(m[0]));
  return { lower: text.toLowerCase(), dates, versions, amounts, percents, numbers };
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

/** One thing the sentence states that its source must contain. */
type Claim = (c: Corpus) => boolean;

/** Collects a claim for every match of `re` and blanks the match, so later patterns do not read it again. */
function collect(
  text: string,
  re: RegExp,
  claim: (m: RegExpExecArray) => Claim,
  out: Claim[],
): string {
  let masked = text;
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    out.push(claim(m));
    masked = mask(masked, m.index, m[0].length);
  }
  return masked;
}

/** Whole-word, case-insensitive occurrence of `word` in `lowerText`. */
function hasWord(lowerText: string, word: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(word.toLowerCase())}(?![\\p{L}\\p{N}])`,
    'u',
  ).test(lowerText);
}

/** A digit outside 0-9 (full-width, Arabic-Indic, ...) or a full-width currency sign: never matched to ASCII. */
const FOREIGN_NUMERAL = /(?![0-9])\p{Nd}|[＄￠￡￥￦％]/u;

/**
 * Checks one sourced sentence against the sources it cites. `template` is the sentence as the model wrote it;
 * placeholders are removed here. Returns the issues found, in a stable order; empty means it is grounded: there
 * is ONE cited source whose text contains every number and every name the sentence states.
 */
export function checkGrounding(
  template: string,
  cited: readonly GroundingSource[],
  ctx: GroundingContext,
): Issue[] {
  const corpora = cited.filter((s) => s.text.trim().length > 0).map(corpusOf);
  const sentence = normalize(template).replace(/\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length));
  if (FOREIGN_NUMERAL.test(sentence)) return ['ungrounded_number'];
  let text = sentence.replace(LIST_MARKER, (m) => ' '.repeat(m.length));
  const numbers: Claim[] = [];

  // 1. dates, before anything reads their digits
  for (const { re, kind } of DATE_PATTERNS) {
    text = collect(
      text,
      re,
      (m) => (c) => datesOf(kind, m).some((want) => dateCovered(want, c.dates)),
      numbers,
    );
  }
  // 2. versions, exactly
  text = collect(text, VERSION, (m) => (c) => c.versions.has(m[1] ?? ''), numbers);
  // 3. amounts (numeric forms by value, word forms literally)
  for (const re of CURRENCY_PATTERNS.slice(0, 2)) {
    text = collect(
      text,
      re,
      (m) => {
        const want = amountOf(m[0]);
        return (c) =>
          want !== null &&
          c.amounts.some((a) => a.currency === want.currency && sameValue(a.value, want.value));
      },
      numbers,
    );
  }
  const literal =
    (m: RegExpExecArray): Claim =>
    (c) =>
      c.lower.includes(m[0].trim().toLowerCase().replace(/\s+/g, ' '));
  for (const re of CURRENCY_PATTERNS.slice(2)) text = collect(text, re, literal, numbers);
  // 4. percentages
  const [percentNumeric, ...percentWords] = PERCENT_PATTERNS;
  if (percentNumeric) {
    text = collect(
      text,
      percentNumeric,
      (m) => {
        const d = new RegExp(DIGITS).exec(m[0]);
        const want = d ? Number(canonicalNumber(d[0])) : Number.NaN;
        return (c) => c.percents.some((p) => sameValue(p, want));
      },
      numbers,
    );
  }
  for (const re of percentWords) text = collect(text, re, literal, numbers);
  // 6. numbers in words
  text = collect(text, WORD_QUANTITY, literal, numbers);
  // 5. every other number
  text = collect(text, FREE_DIGITS, (m) => (c) => c.numbers.has(canonicalNumber(m[0])), numbers);

  // 7. names
  const names: Claim[] = [];
  const userLower = normalize(ctx.userMessage).toLowerCase();
  const entityLower = ctx.entityNames.map((n) => normalize(n).toLowerCase());
  const firstWord = /[\p{L}\p{N}]/u.exec(text)?.index ?? -1;
  for (const m of text.matchAll(NAME)) {
    const token = m[0].replace(/['’]s$/, '');
    if ((token.match(/\p{L}/gu) ?? []).length < 2 || PRONOUN.test(token)) continue;
    if (m.index === firstWord && COMMON_INITIAL.has(token.toLowerCase())) continue;
    if (hasWord(userLower, token)) continue;
    if (entityLower.some((n) => hasWord(n, token))) continue;
    names.push((c) => hasWord(c.lower, token));
  }

  // Same-source binding: one cited source must hold everything at once.
  const all = [...numbers, ...names];
  if (all.length === 0 || corpora.some((c) => all.every((claim) => claim(c)))) return [];
  const issues: Issue[] = [];
  const numbersAlone = corpora.some((c) => numbers.every((claim) => claim(c)));
  const namesAlone = corpora.some((c) => names.every((claim) => claim(c)));
  if (!numbersAlone) issues.push('ungrounded_number');
  if (!namesAlone || numbersAlone) issues.push('ungrounded_name');
  return issues;
}
