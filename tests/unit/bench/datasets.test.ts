import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../scripts/bench/csv.js';
import {
  parseFreshQa,
  parseLongMemDate,
  parseLongMemEval,
  parseSimpleQa,
} from '../../../scripts/bench/datasets.js';
import { FRESHQA_CSV, LONGMEMEVAL_JSON, SIMPLEQA_CSV } from './fixtures.js';

describe('CSV reader', () => {
  it('handles quoted commas, doubled quotes, embedded line breaks and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\nplain,,end\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['plain', '', 'end'],
    ]);
  });

  it('refuses a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/quoted field/);
  });
});

describe('SimpleQA loader', () => {
  it('reads problem, answer and the topic from the metadata dict, with row-number ids', () => {
    const items = parseSimpleQa(SIMPLEQA_CSV);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      id: 'simpleqa-0',
      topic: 'Science and technology',
      answerType: 'Person',
      answer: 'Ada Example',
    });
    expect(items[3]?.question).toBe('On which date did the made-up "Blue Hour" gallery open?');
    expect(items[3]?.answer).toBe('May 3, 1999');
  });

  it('rejects a row without a topic', () => {
    const bad = `metadata,problem,answer\n"{'answer_type': 'Person'}",Q?,A`;
    expect(() => parseSimpleQa(bad)).toThrow(/topic/);
  });
});

describe('FreshQA loader', () => {
  it('skips the lines before the header and keeps every accepted answer', () => {
    const items = parseFreshQa(FRESHQA_CSV);
    expect(items.map((i) => i.id)).toEqual(['freshqa-0', 'freshqa-1', 'freshqa-2', 'freshqa-3']);
    expect(items[0]).toMatchObject({
      split: 'TEST',
      falsePremise: true,
      factType: 'slow-changing',
      answers: ['No cat has walked on Mars.'],
    });
    expect(items[1]).toMatchObject({
      factType: 'fast-changing',
      nextReview: '07/01/2026',
      answers: ['Jane Placeholder', 'J. Placeholder'],
    });
    expect(items[2]?.split).toBe('DEV');
  });

  it('rejects an unknown fact type', () => {
    const bad = FRESHQA_CSV.replace(
      'never-changing,https://example.org/h',
      'rarely,https://example.org/h',
    );
    expect(() => parseFreshQa(bad)).toThrow(/FreshQA row 2/);
  });
});

describe('LongMemEval loader', () => {
  it('reads sessions with their dates as UTC, roles and the abstention flag', () => {
    const items = parseLongMemEval(LONGMEMEVAL_JSON);
    expect(items).toHaveLength(2);
    const [first, second] = items;
    expect(first?.questionAt).toBe(Date.UTC(2023, 4, 21, 9, 0));
    expect(first?.sessions[0]?.at).toBe(Date.UTC(2023, 4, 20, 10, 0));
    expect(first?.sessions[0]?.turns[0]).toMatchObject({ role: 'user', hasAnswer: true });
    expect(first?.sessions[1]?.turns[1]).toMatchObject({ role: 'assistant', hasAnswer: false });
    expect(first?.abstention).toBe(false);
    expect(second?.abstention).toBe(true);
    expect(second?.answer).toBe('2');
  });

  it('parses the dataset date format and rejects others', () => {
    expect(parseLongMemDate('2023/04/10 (Mon) 23:07')).toBe(Date.UTC(2023, 3, 10, 23, 7));
    expect(() => parseLongMemDate('2023-04-10 23:07')).toThrow();
  });

  it('rejects sessions and dates of different lengths', () => {
    const bad = [{ ...LONGMEMEVAL_JSON[0], haystack_dates: ['2023/05/20 (Sat) 10:00'] }];
    expect(() => parseLongMemEval(bad)).toThrow(/same length/);
  });
});
