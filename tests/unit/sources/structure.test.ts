import { describe, expect, it } from 'vitest';
import { parseSourceStructure } from '../../../src/sources/structure.js';

const PRICING = `# AcmeCRM Pricing

## Plans (USD, billed annually)

| Plan | Price per user / month | Contacts |
|---|---|---|
| Starter | $20 | 1,000 |
| Pro | $90 | 10,000 |

Notes
-----
Prices in USD.`;

describe('parseSourceStructure', () => {
  it('reports headings, table headers and rows with adjacent cells intact', () => {
    const s = parseSourceStructure(PRICING);
    expect(s.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'AcmeCRM Pricing'],
      [2, 'Plans (USD, billed annually)'],
      [2, 'Notes'],
    ]);
    expect(s.tables).toHaveLength(1);
    expect(s.tables[0]?.headers).toEqual(['Plan', 'Price per user / month', 'Contacts']);
    expect(s.tables[0]?.rows).toEqual([
      ['Starter', '$20', '1,000'],
      ['Pro', '$90', '10,000'],
    ]);
  });

  it('does not alter its input (no mutation, no flattening)', () => {
    const copy = `${PRICING}`;
    parseSourceStructure(PRICING);
    expect(PRICING).toBe(copy);
  });

  it('keeps currency symbols and labels, and escaped pipes', () => {
    const s = parseSourceStructure('| Plan | Price |\n|:--|--:|\n| A \\| B | €15 EUR |');
    expect(s.tables[0]?.rows).toEqual([['A | B', '€15 EUR']]);
  });

  it('ignores fenced code and bullet lists followed by dashes', () => {
    const s = parseSourceStructure('```\n# not a heading\n| a | b |\n|--|--|\n```\n- item\n---');
    expect(s.headings).toEqual([]);
    expect(s.tables).toEqual([]);
  });

  it('handles CRLF, empty input and text with no structure', () => {
    expect(parseSourceStructure('')).toEqual({ headings: [], tables: [] });
    expect(parseSourceStructure('just a sentence | with a pipe').tables).toEqual([]);
    expect(parseSourceStructure('# A\r\n\r\n| x |\r\n|---|\r\n| 1 |').tables[0]?.rows).toEqual([
      ['1'],
    ]);
  });

  it('is linear on huge input', () => {
    const big = `${'| a | b |\n|--|--|\n| 1 | 2 |\n\n'.repeat(5000)}${'x\n'.repeat(100000)}`;
    const t = Date.now();
    const s = parseSourceStructure(big);
    expect(s.tables).toHaveLength(5000);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
