import type { CurrencyCode } from '../shared/evidence.js';

/**
 * Amounts and currency markers (architecture R2 table). A bare `$` or `¥` is `unknown` unless the quote or
 * its associated header carries an explicit currency declaration.
 */

export interface AmountToken {
  amount: number;
  /** Offsets of the digits only. */
  start: number;
  end: number;
  raw: string;
}

const AMOUNT_RE =
  /(?<![\d.,])(\d{1,3}(?:\.\d{3})+,\d{1,2}|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?!\d)(?![.,]\d)/g;

export function parseAmount(raw: string): number {
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(raw))
    return Number(raw.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return Number(raw.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(raw)) return Number(raw.replace(',', '.'));
  return Number(raw);
}

export function findAmounts(text: string): AmountToken[] {
  const out: AmountToken[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[1] ?? m[0];
    out.push({ amount: parseAmount(raw), start: m.index, end: m.index + raw.length, raw });
  }
  return out;
}

interface MarkerSpec {
  re: RegExp;
  code: CurrencyCode;
  symbol: string;
}

/** Longest marker first; each regex is anchored to the end of the text before the amount. */
const PREFIX: MarkerSpec[] = [
  { re: /(?:US\$|U\.S\.\$)\s?$/, code: 'USD', symbol: '$' },
  { re: /(?<![A-Za-z])(?:A\$|AU\$)\s?$/, code: 'AUD', symbol: '$' },
  { re: /(?<![A-Za-z])(?:C\$|CA\$)\s?$/, code: 'CAD', symbol: '$' },
  { re: /(?<![A-Za-z])NZ\$\s?$/, code: 'NZD', symbol: '$' },
  { re: /(?<![A-Za-z])S\$\s?$/, code: 'SGD', symbol: '$' },
  { re: /JP¥\s?$/, code: 'JPY', symbol: '¥' },
  { re: /CN¥\s?$/, code: 'CNY', symbol: '¥' },
  { re: /€\s?$/, code: 'EUR', symbol: '€' },
  { re: /£\s?$/, code: 'GBP', symbol: '£' },
  { re: /₹\s?$/, code: 'INR', symbol: '₹' },
  { re: /(?<![A-Za-z])Rs\.?\s?$/, code: 'INR', symbol: 'Rs.' },
  { re: /(?<![A-Za-z])CHF\s?$/, code: 'CHF', symbol: 'CHF' },
  { re: /(?<![A-Za-z])USD\s?$/, code: 'USD', symbol: 'USD' },
  { re: /(?<![A-Za-z])AUD\s?$/, code: 'AUD', symbol: 'AUD' },
  { re: /(?<![A-Za-z])CAD\s?$/, code: 'CAD', symbol: 'CAD' },
  { re: /(?<![A-Za-z])NZD\s?$/, code: 'NZD', symbol: 'NZD' },
  { re: /(?<![A-Za-z])SGD\s?$/, code: 'SGD', symbol: 'SGD' },
  { re: /(?<![A-Za-z])EUR\s?$/, code: 'EUR', symbol: 'EUR' },
  { re: /(?<![A-Za-z])GBP\s?$/, code: 'GBP', symbol: 'GBP' },
  { re: /(?<![A-Za-z])INR\s?$/, code: 'INR', symbol: 'INR' },
  { re: /(?<![A-Za-z])JPY\s?$/, code: 'JPY', symbol: 'JPY' },
  { re: /(?<![A-Za-z])CNY\s?$/, code: 'CNY', symbol: 'CNY' },
  { re: /\$\s?$/, code: 'unknown', symbol: '$' },
  { re: /¥\s?$/, code: 'unknown', symbol: '¥' },
];

const SUFFIX: MarkerSpec[] = [
  { re: /^\s?(?:USD|US dollars?|U\.S\. dollars?)(?![A-Za-z])/i, code: 'USD', symbol: 'USD' },
  { re: /^\s?(?:AUD|Australian dollars?)(?![A-Za-z])/i, code: 'AUD', symbol: 'AUD' },
  { re: /^\s?(?:CAD|Canadian dollars?)(?![A-Za-z])/i, code: 'CAD', symbol: 'CAD' },
  { re: /^\s?(?:NZD|New Zealand dollars?)(?![A-Za-z])/i, code: 'NZD', symbol: 'NZD' },
  { re: /^\s?(?:SGD|Singapore dollars?)(?![A-Za-z])/i, code: 'SGD', symbol: 'SGD' },
  { re: /^\s?(?:EUR|euros?)(?![A-Za-z])/i, code: 'EUR', symbol: 'EUR' },
  { re: /^\s?€/, code: 'EUR', symbol: '€' },
  { re: /^\s?(?:GBP)(?![A-Za-z])/i, code: 'GBP', symbol: 'GBP' },
  { re: /^\s?(?:INR)(?![A-Za-z])/i, code: 'INR', symbol: 'INR' },
  { re: /^\s?(?:CHF)(?![A-Za-z])/i, code: 'CHF', symbol: 'CHF' },
  { re: /^\s?(?:JPY|Japanese yen)(?![A-Za-z])/i, code: 'JPY', symbol: 'JPY' },
  { re: /^\s?(?:CNY|RMB|yuan)(?![A-Za-z])/i, code: 'CNY', symbol: 'CNY' },
];

export interface MarkerResult {
  /** Resolved ISO code, or 'unknown' for a bare `$` / `¥` / no marker. */
  code: CurrencyCode;
  /** As displayed, or null when no marker is adjacent. */
  symbol: string | null;
  /** Index where the marker starts (or the amount start when there is none). */
  start: number;
  /** Index where the marker ends (or the amount end when there is none). */
  end: number;
  /** A marker (symbol or code) is adjacent to the amount. */
  hasMarker: boolean;
  /** Only a bare `$` or `¥`, which needs a declaration to resolve. */
  bare: boolean;
}

/** The currency marker adjacent to an amount occurrence, if any. */
export function markerFor(text: string, tok: AmountToken): MarkerResult {
  const before = text.slice(Math.max(0, tok.start - 8), tok.start);
  for (const p of PREFIX) {
    const m = p.re.exec(before);
    if (m) {
      const bare = p.code === 'unknown';
      if (bare) {
        // "$ 25 USD": a code written right after the amount names the currency of the bare symbol, provided
        // it is a currency that symbol can stand for. A bare symbol on its own stays unknown.
        const next = text.slice(tok.end, tok.end + 20);
        for (const s of SUFFIX) {
          const sm = s.re.exec(next);
          if (sm && declarationFitsSymbol(s.code, p.symbol)) {
            return {
              code: s.code,
              symbol: p.symbol,
              start: tok.start - m[0].length,
              end: tok.end + sm[0].length,
              hasMarker: true,
              bare: false,
            };
          }
        }
      }
      return {
        code: p.code,
        symbol: p.symbol,
        start: tok.start - m[0].length,
        end: tok.end,
        hasMarker: true,
        bare,
      };
    }
  }
  const after = text.slice(tok.end, tok.end + 20);
  for (const s of SUFFIX) {
    const m = s.re.exec(after);
    if (m) {
      return {
        code: s.code,
        symbol: s.symbol,
        start: tok.start,
        end: tok.end + m[0].length,
        hasMarker: true,
        bare: false,
      };
    }
  }
  return {
    code: 'unknown',
    symbol: null,
    start: tok.start,
    end: tok.end,
    hasMarker: false,
    bare: false,
  };
}

const DECLARED: Array<[RegExp, CurrencyCode]> = [
  [/\b(?:USD|U\.?S\.? dollars?)\b/i, 'USD'],
  [/\b(?:CAD|Canadian dollars?)\b/i, 'CAD'],
  [/\b(?:AUD|Australian dollars?)\b/i, 'AUD'],
  [/\b(?:NZD|New Zealand dollars?)\b/i, 'NZD'],
  [/\b(?:SGD|Singapore dollars?)\b/i, 'SGD'],
  [/\b(?:JPY|Japanese yen)\b/i, 'JPY'],
  [/\b(?:CNY|RMB|renminbi|yuan)\b/i, 'CNY'],
];

const DECLARATION_FRAME =
  /\b(?:all\s+)?(?:prices?|pricing|amounts?|fees?|rates?|costs?)\b[^.\n|]{0,40}?\b(?:in|are\s+in|shown\s+in|quoted\s+in|listed\s+in|displayed\s+in)\s+([^.\n|,;)]{2,30})|\bcurrency\s*:\s*([^.\n|,;)]{2,30})/gi;

/** An explicit statement of the currency of the prices on the page ("All prices in USD"). */
export function declaredCurrency(text: string): CurrencyCode | null {
  for (const m of text.matchAll(DECLARATION_FRAME)) {
    const phrase = m[1] ?? m[2] ?? '';
    for (const [re, code] of DECLARED) if (re.test(phrase)) return code;
  }
  return null;
}

/** Which currencies a bare symbol may be declared as. */
export function declarationFitsSymbol(code: CurrencyCode, symbol: string | null): boolean {
  if (symbol === '$') return ['USD', 'CAD', 'AUD', 'NZD', 'SGD'].includes(code);
  if (symbol === '¥') return ['JPY', 'CNY'].includes(code);
  return false;
}
