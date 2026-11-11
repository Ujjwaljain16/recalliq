import { describe, expect, it } from 'vitest';
import { SentenceAssembler, type Candidate } from '../../../src/answer/assembler.js';
import { PlaceholderParser } from '../../../src/answer/placeholders.js';
import { defaultRenderer } from '../../../src/answer/render.js';
import { finding, recordsFor } from './builders.js';

function assemble(chunks: string[], options: { discard?: boolean } = {}) {
  const candidates: Candidate[] = [];
  const records = recordsFor([finding(1)]);
  const a = new SentenceAssembler({
    records,
    renderer: defaultRenderer,
    t3a: { userMessage: '', localDates: [], findings: [finding(1)] },
    onCandidate: (c) => void candidates.push(c),
  });
  const p = new PlaceholderParser();
  for (const c of chunks) a.feed(p.push(c));
  if (options.discard) a.discardOpen();
  else {
    a.feed(p.flush());
    a.finish();
  }
  return { a, candidates };
}

describe('sentence boundaries', () => {
  it('splits on terminators followed by whitespace, not on decimals, abbreviations or list markers', () => {
    const { candidates } = assemble([
      'Version 3.5 is out. See e.g. the docs. Really?\n1. First item\n2. Second item',
    ]);
    expect(candidates.map((s) => s.text.replace(/[0-9]/g, '#'))).toEqual([
      'Version #.# is out.',
      'See e.g. the docs.',
      'Really?',
      '#. First item',
      '#. Second item',
    ]);
  });

  it('keeps the separators between sentences', () => {
    const { candidates } = assemble(['One.  Two.\n\nThree.']);
    expect(candidates.map((c) => c.sep)).toEqual(['', '  ', '\n\n']);
  });

  it('a terminator followed by a closing quote still ends the sentence', () => {
    const { candidates } = assemble(['He said "stop." Then left.']);
    expect(candidates.map((s) => s.text)).toEqual(['He said "stop."', 'Then left.']);
  });
});

describe('candidates carry their verdict, and the open sentence is never handed over early', () => {
  it('a sentence is handed over only when it ends, not while it is still arriving', () => {
    const records = recordsFor([finding(1)]);
    const seen: string[] = [];
    const a = new SentenceAssembler({
      records,
      renderer: defaultRenderer,
      t3a: { userMessage: '', localDates: [], findings: [] },
      onCandidate: (c) => void seen.push(c.text),
    });
    const p = new PlaceholderParser();
    a.feed(p.push('It costs [[F'));
    a.feed(p.push('1]] and more'));
    expect(seen).toEqual([]);
    expect(a.hasOpenSentence).toBe(true);
    a.feed(p.push(' text. Next'));
    expect(seen).toHaveLength(1);
  });

  it('flags free text and dropped placeholders as issues on the candidate', () => {
    const { candidates } = assemble(['Costs [[F1]]. It is $100. A [[F9]] b.']);
    expect(candidates.map((c) => c.issues)).toEqual([[], ['free_currency'], ['unknown_ref']]);
  });

  it('discarding the open sentence hands nothing over', () => {
    const { candidates } = assemble(['Done. Half a sent'], { discard: true });
    expect(candidates.map((c) => c.text)).toEqual(['Done.']);
  });
});
