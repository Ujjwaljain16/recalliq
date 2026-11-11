import type { PlaceholderRef, SentenceIssue } from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';

/**
 * T3a: the deterministic free-text check (architecture R4, contracts §3). It runs on the TEMPLATE of one
 * sentence with every valid placeholder removed, so numbers inside rendered values are never seen as free
 * text. It flags what the model is not allowed to write itself: amounts, percentages, dates, other numbers,
 * verdict words without a compatible finding, and global "nothing changed" claims without support.
 */
export interface T3aContext {
  userMessage: string;
  /** `localDate` (YYYY-MM-DD) of every resolved candidate day in ResolvedContext.temporal. */
  localDates: readonly string[];
  /** Every finding of the turn (global negatives are judged against all of them). */
  findings: readonly Finding[];
  /** Numerals that belong to entity or plan names (e.g. the 365 of "Office 365"). */
  nameNumerals?: ReadonlySet<string>;
}

export interface T3aSentence {
  template: string;
  /** The valid placeholders of this sentence, with their findings where they have one. */
  refs: ReadonlyArray<{ ref: PlaceholderRef; finding: Finding | null }>;
}

const MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const monthNumber = (s: string): number => MONTH_INDEX[s.slice(0, 3).toLowerCase()] ?? 0;

const NUMWORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)';
const NUMWORDS = `${NUMWORD}(?:[\\s-]+(?:and\\s+)?${NUMWORD})*`;
const QUANTITY_NOUN =
  '(?:seats?|users?|people|licen[cs]es?|plans?|tiers?|months?|years?|days?|weeks?|hours?|requests?|calls?|tokens?|employees?|gb|tb|mb)';
const DIGITS = '\\d[\\d,]*(?:\\.\\d+)?';

const DATE_PATTERNS: Array<{ re: RegExp; kind: 'dmy' | 'mdy' | 'my' | 'iso' | 'slash' }> = [
  {
    re: new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b(?:,?\\s+(\\d{4}))?`,
      'gi',
    ),
    kind: 'dmy',
  },
  {
    re: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi'),
    kind: 'mdy',
  },
  { re: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{4})\\b`, 'gi'), kind: 'my' },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, kind: 'iso' },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, kind: 'slash' },
];

const CURRENCY_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:US\\$|CA\\$|A\\$|[$€£¥₹]|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\\b)\\s?${DIGITS}(?:\\s?(?:k|m|bn|million|billion|thousand)\\b)?`,
    'gi',
  ),
  new RegExp(`${DIGITS}\\s?(?:USD|EUR|GBP|dollars?|euros?|pounds?|bucks|cents?)\\b`, 'gi'),
  new RegExp(`\\b${NUMWORDS}\\s+(?:dollars?|euros?|pounds?|bucks|cents?)\\b`, 'gi'),
];
const PERCENT_PATTERNS: RegExp[] = [
  new RegExp(`${DIGITS}\\s?(?:%|(?:percent|per cent|pct)\\b)`, 'gi'),
  new RegExp(`\\b${NUMWORDS}\\s+(?:percent|per cent)\\b`, 'gi'),
];
const WORD_QUANTITY = new RegExp(`\\b${NUMWORDS}\\s+${QUANTITY_NOUN}\\b`, 'gi');
const FREE_DIGITS = new RegExp(`(?<![\\p{L}\\d])${DIGITS}`, 'gu');

const NOSIGN = /\bno (?:sign|evidence|indication)s? of (?:any |a )?changes?\b/gi;
const GLOBAL_NEGATIVE =
  /\b(?:none of them(?: (?:has |have )?changed)?|none of the (?:\w+ ){0,2}changed|no changes|nothing (?:has )?changed|all (?:of them )?(?:are |remain |stay )?(?:the )?same|all unchanged)\b/gi;

type Predicate = (f: Finding) => boolean;
const is =
  (...verdicts: Array<Finding['verdict']>): Predicate =>
  (f) =>
    verdicts.includes(f.verdict);
const releaseKind =
  (...kinds: Array<'launch' | 'change' | 'removal'>): Predicate =>
  (f) =>
    f.verdict === 'releases_found' && (f.releases ?? []).some((r) => kinds.includes(r.kind));

/** Phrase families and the finding verdicts that justify them (contracts §3). */
export const VERDICT_FAMILIES: Array<{ id: string; re: RegExp; ok: Predicate }> = [
  {
    id: 'up',
    re: /\b(?:raised|raises|increased|increases|went up|gone up|goes up|rose|hiked)\b/i,
    ok: (f) => f.verdict === 'changed' && f.direction === 'up',
  },
  {
    id: 'down',
    re: /\b(?:cut|cuts|lowered|lowers|reduced|reduces|dropped|drops|went down|decreased)\b/i,
    ok: (f) => f.verdict === 'changed' && f.direction === 'down',
  },
  { id: 'unchanged', re: /\b(?:unchanged|same price|no change)\b/i, ok: is('unchanged_confirmed') },
  {
    id: 'nosign',
    re: new RegExp(NOSIGN.source, 'i'),
    ok: is('unchanged_confirmed', 'no_evidence_of_change'),
  },
  {
    id: 'differs',
    re: /\b(?:different now|differs|differ)\b/i,
    ok: is('differs_timing_unknown', 'changed'),
  },
  {
    id: 'launch',
    re: /\b(?:launched|launches|released|shipped|introduced)\b/i,
    ok: releaseKind('launch', 'change'),
  },
  { id: 'removal', re: /\b(?:discontinued|removed|retired|sunset)\b/i, ok: releaseKind('removal') },
  {
    id: 'wrong',
    re: /\b(?:was wrong|out of date|outdated|incorrect)\b/i,
    ok: is('baseline_incorrect'),
  },
];

const isChange =
  (direction: 'up' | 'down'): Predicate =>
  (f) =>
    f.verdict === 'changed' && f.direction === direction;

type LexiconCategory = 'up' | 'down' | 'more' | 'less' | 'neutral' | 'launch' | 'removal';

/**
 * Broad lexicon of words that imply a price or product change over time, or a comparison. A blacklist can
 * never be complete, so these are not the only line of defence: the synthesis prompt forbids free-text change
 * language, and this list is applied conservatively (when in doubt the sentence is withheld). The verdict
 * families above are matched first; whatever they cover keeps its own rule.
 */
export const CHANGE_LEXICON: Array<{ cat: LexiconCategory; re: RegExp }> = [
  {
    cat: 'up',
    re: /\b(?:rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|ris(?:e|es|ing)|rose|risen|jump(?:s|ed|ing)?|surg(?:e|es|ed|ing)|spik(?:e|es|ed|ing)|climb(?:s|ed|ing)?|hik(?:e|es|ed|ing)|bump(?:s|ed|ing)?|doubl(?:e|es|ed|ing)|tripl(?:e|es|ed|ing)|quadrupl(?:e|es|ed|ing)|up ?tick(?:s|ed|ing)?|mark(?:ed)? ?ups?|marked up)\b/i,
  },
  {
    cat: 'down',
    re: /\b(?:cut(?:s|ting)?|slash(?:es|ed|ing)?|drop(?:s|ped|ping)?|fall(?:s|ing|en)?|fell|plung(?:e|es|ed|ing)|dip(?:s|ped|ping)?|decreas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing|tion)|lower(?:s|ed|ing)?|discount(?:s|ed|ing)?|halv(?:e|es|ed|ing)|down ?tick(?:s|ed|ing)?|mark(?:ed)? ?downs?|marked down)\b/i,
  },
  {
    cat: 'more',
    re: /\b(?:pricier|priciest|pricey|costlier|costliest|more expensive|more costly|costs? more|costing more)\b/i,
  },
  {
    cat: 'less',
    re: /\b(?:cheaper|cheapest|less expensive|less costly|costs? less|costing less)\b/i,
  },
  {
    cat: 'neutral',
    re: /\b(?:chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|(?:went|gone) (?:from|to|up|down|over|under|higher|lower)|now costs?|used to|previously|formerly|no longer|any ?more|new pric(?:e|es|ing)|re ?pric(?:e|es|ed|ing)|adjust(?:s|ed|ing|ment)?|revis(?:e|es|ed|ion))\b/i,
  },
  {
    cat: 'removal',
    re: /\b(?:deprecat(?:e|es|ed|ing)|discontinu(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|retir(?:e|es|ed|ing)|sunset(?:s|ted|ting)?|phas(?:e|es|ed|ing) out|end(?:ed)? of life)\b/i,
  },
  {
    cat: 'launch',
    re: /\b(?:launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)|introduc(?:e|es|ed|ing)|unveil(?:s|ed|ing)?|announc(?:e|es|ed|ing)|roll(?:s|ed|ing)? out|new (?:plan|tier|feature|version))\b/i,
  },
];

const chars = (...codes: number[]): string => String.fromCharCode(...codes);
/** Zero-width characters and the soft hyphen, which can be slipped into a word to hide it. */
const ZERO_WIDTH = new RegExp(`[${chars(0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff)}]`, 'g');
/** Hyphen look-alikes: the Unicode dashes, minus sign, small and full-width hyphen-minus. */
const DASHES = new RegExp(
  `[${chars(0x2010)}-${chars(0x2015)}${chars(0x2212, 0x2043, 0xfe58, 0xfe63, 0xff0d)}]`,
  'g',
);
/** Apostrophe look-alikes: typographic quotes, modifier letter apostrophe, prime, grave and acute accents. */
const APOSTROPHES = new RegExp(`[${chars(0x2018, 0x2019, 0x02bc, 0x2032, 0x0060, 0x00b4)}]`, 'g');
const GREEK_CYRILLIC = new RegExp(`[${chars(0x0370)}-${chars(0x04ff)}]`, 'g');
/** Characters that look like Latin letters but are not (a small, common set). */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  і: 'i',
  ј: 'j',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  ν: 'v',
  ρ: 'p',
  τ: 't',
  υ: 'u',
};

/**
 * Normalises text for word matching: compatibility forms (full-width letters), look-alike letters, zero-width and
 * soft-hyphen characters, every kind of dash and apostrophe, case and spacing. Returns two variants, one where
 * hyphens separate words ("up-ticked" -> "up ticked") and one where they vanish ("re-priced" -> "repriced").
 */
export function textVariants(text: string): string[] {
  const base = text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(DASHES, '-')
    .replace(APOSTROPHES, "'")
    .toLowerCase()
    .replace(GREEK_CYRILLIC, (c) => HOMOGLYPHS[c] ?? c);
  const spaced = base.replace(/-+/g, ' ').replace(/\s+/g, ' ');
  const joined = base.replace(/-+/g, '').replace(/\s+/g, ' ');
  return [spaced, joined];
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

/** Replaces every match of `re` for which `flag(match)` is true with blanks, collecting `issue` once. */
function sweep(
  text: string,
  re: RegExp,
  onMatch: (m: RegExpExecArray) => 'flag' | 'allow',
  issues: Set<SentenceIssue>,
  issue: SentenceIssue,
): string {
  let out = text;
  for (const m of text.matchAll(re)) {
    if (onMatch(m) === 'flag') issues.add(issue);
    out = mask(out, m.index, m[0].length);
  }
  return out;
}

function numeralsOf(s: string): Set<string> {
  return new Set([...s.matchAll(new RegExp(DIGITS, 'g'))].map((m) => m[0].replace(/,/g, '')));
}

function dateAllowed(
  kind: (typeof DATE_PATTERNS)[number]['kind'],
  m: RegExpExecArray,
  localDates: readonly string[],
): boolean {
  const days = localDates.map((d) => {
    const [y, mo, da] = d.split('-').map(Number);
    return { y: y ?? 0, m: mo ?? 0, d: da ?? 0 };
  });
  const g = (i: number): string => m[i] ?? '';
  switch (kind) {
    case 'dmy':
    case 'mdy': {
      const day = Number(kind === 'dmy' ? g(1) : g(2));
      const month = monthNumber(kind === 'dmy' ? g(2) : g(1));
      const year = g(3) === '' ? null : Number(g(3));
      return days.some((x) => x.d === day && x.m === month && (year === null || x.y === year));
    }
    case 'my':
      return days.some((x) => x.m === monthNumber(g(1)) && x.y === Number(g(2)));
    case 'iso':
      return localDates.includes(g(0));
    case 'slash': {
      const a = Number(g(1));
      const b = Number(g(2));
      const year = Number(g(3).length === 2 ? `20${g(3)}` : g(3));
      return days.some(
        (x) => x.y === year && ((x.d === a && x.m === b) || (x.d === b && x.m === a)),
      );
    }
  }
}

/** Returns the issues of one sentence's free text, in a stable order. Empty means the text is clean. */
export function checkFreeText(sentence: T3aSentence, ctx: T3aContext): SentenceIssue[] {
  const issues = new Set<SentenceIssue>();
  let text = sentence.template.replace(/\[\[[^\]]*\]\]/g, ' ');
  const userText = ctx.userMessage;
  const userLower = userText.toLowerCase();
  const userNumerals = numeralsOf(userText);

  // Dates first, so their digits are not read as free numbers.
  for (const { re, kind } of DATE_PATTERNS) {
    text = sweep(
      text,
      re,
      (m) => (dateAllowed(kind, m, ctx.localDates) ? 'allow' : 'flag'),
      issues,
      'free_date',
    );
  }
  // Amounts and percentages are exempt only when the user typed the very same token.
  const echoed = (m: RegExpExecArray): 'flag' | 'allow' =>
    userLower.includes(m[0].trim().toLowerCase()) ? 'allow' : 'flag';
  for (const re of CURRENCY_PATTERNS) text = sweep(text, re, echoed, issues, 'free_currency');
  for (const re of PERCENT_PATTERNS) text = sweep(text, re, echoed, issues, 'free_percent');

  // A list marker at the start of the sentence ("1. ") is not a number.
  text = text.replace(/^(\s*)(\d{1,2})([.)])(?=\s)/, '$1 $3');

  text = sweep(
    text,
    WORD_QUANTITY,
    (m) => {
      const words = m[0].toLowerCase().match(new RegExp(NUMWORD, 'g')) ?? [];
      return words.every((w) => new RegExp(`\\b${w}\\b`, 'i').test(userText)) ? 'allow' : 'flag';
    },
    issues,
    'free_number',
  );
  text = sweep(
    text,
    FREE_DIGITS,
    (m) => {
      const n = m[0].replace(/,/g, '');
      return userNumerals.has(n) || ctx.nameNumerals?.has(n) ? 'allow' : 'flag';
    },
    issues,
    'free_number',
  );

  // Global negatives: judged against every finding of the turn.
  const negatives = [...text.matchAll(GLOBAL_NEGATIVE)];
  const noSign = new RegExp(NOSIGN.source, 'i').test(text);
  let globalSupported = false;
  if (negatives.length > 0) {
    const all = ctx.findings;
    const verdicts = all.map((f) => f.verdict);
    const everyQuiet =
      all.length > 0 &&
      verdicts.every(
        (v) => v === 'unchanged_confirmed' || v === 'no_evidence_of_change' || v === 'none_found',
      );
    const needsNoSignWording = verdicts.some(
      (v) => v === 'no_evidence_of_change' || v === 'none_found',
    );
    const supported = everyQuiet && !(needsNoSignWording && !noSign);
    if (negatives.length > 0 && !supported) issues.add('unsupported_global_negative');
    // A sentence that makes a supported global claim needs no placeholder for its no-change wording.
    globalSupported = negatives.length > 0 && supported;
    for (const m of negatives) text = mask(text, m.index, m[0].length);
  }

  // Verdict words need a compatible finding in the same sentence. Matching runs on normalised text and on a
  // hyphen-free variant, so case, spacing, look-alike characters and hyphenation do not hide a word.
  const variants = textVariants(text);
  const linked = sentence.refs.flatMap((r) => (r.finding ? [r.finding] : []));
  let rest = variants;
  for (const family of VERDICT_FAMILIES) {
    const skip = globalSupported && (family.id === 'nosign' || family.id === 'unchanged');
    if (!skip && variants.some((v) => family.re.test(v)) && !linked.some(family.ok)) {
      issues.add('unsupported_verdict_word');
    }
    rest = rest.map((v) => v.replace(new RegExp(family.re.source, 'gi'), ' '));
  }

  // Broad change lexicon (structural rule). Words the families above already cover keep their own rule; every
  // other word that implies a change over time or a comparison is allowed only when the sentence is about a
  // finding (it has a finding placeholder, or the turn has findings) AND carries a `:verdict` or `:baseline`
  // placeholder of a finding whose verdict fits. A plain current-value placeholder never justifies it.
  const aboutFindings = sentence.refs.some((r) => r.finding !== null) || ctx.findings.length > 0;
  if (aboutFindings) {
    const anchored = sentence.refs.flatMap((r) =>
      r.finding && r.ref.kind === 'finding' && r.ref.variant !== 'current' ? [r.finding] : [],
    );
    const distinct = new Set(linked.map((f) => f.ord)).size;
    for (const { cat, re } of CHANGE_LEXICON) {
      if (!rest.some((v) => re.test(v))) continue;
      const ok =
        (cat === 'up' && anchored.some(isChange('up'))) ||
        (cat === 'down' && anchored.some(isChange('down'))) ||
        (cat === 'neutral' &&
          (anchored.some(is('changed', 'differs_timing_unknown', 'baseline_incorrect')) ||
            anchored.some(releaseKind('removal')))) ||
        (cat === 'removal' && anchored.some(releaseKind('removal'))) ||
        (cat === 'launch' && anchored.some(releaseKind('launch', 'change'))) ||
        // A comparison between several findings is judged by the T3b judge, not forbidden.
        ((cat === 'more' || cat === 'less') && distinct >= 2) ||
        (cat === 'more' && anchored.some(isChange('up'))) ||
        (cat === 'less' && anchored.some(isChange('down')));
      if (!ok) issues.add('unsupported_verdict_word');
    }
  }

  const order: SentenceIssue[] = [
    'free_currency',
    'free_percent',
    'free_date',
    'free_number',
    'unsupported_verdict_word',
    'unsupported_global_negative',
  ];
  return order.filter((i) => issues.has(i));
}
