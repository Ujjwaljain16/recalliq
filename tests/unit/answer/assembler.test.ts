import { describe, expect, it } from 'vitest';
import { SentenceAssembler } from '../../../src/answer/assembler.js';
import { PlaceholderParser } from '../../../src/answer/placeholders.js';
import { defaultRenderer } from '../../../src/answer/render.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { finding, recordsFor } from './builders.js';

function assemble(text: string) {
  const events: SseEvent[] = [];
  const records = recordsFor([finding(1)]);
  const a = new SentenceAssembler({
    records,
    renderer: defaultRenderer,
    t3a: { userMessage: '', localDates: [], findings: records.findings.size ? [finding(1)] : [] },
    emit: (e) => {
      events.push(e);
      return true;
    },
    requestJudge: () => false,
  });
  const p = new PlaceholderParser();
  a.feed(p.push(text));
  a.feed(p.flush());
  a.finish();
  return { a, events };
}

describe('sentence boundaries', () => {
  it('splits on terminators followed by whitespace, not on decimals, abbreviations or list markers', () => {
    const { a } = assemble(
      'Version 3.5 is out. See e.g. the docs. Really?\n1. First item\n2. Second item',
    );
    expect(a.sentences.map((s) => s.text)).toEqual([
      'Version 3.5 is out.',
      'See e.g. the docs.',
      'Really?',
      '1. First item',
      '2. Second item',
    ]);
  });

  it('keeps separators so the rendered text is exactly what was streamed', () => {
    const { a, events } = assemble('One.  Two.\n\nThree.');
    const streamed = events
      .flatMap((e) => (e.event === 'answer.delta' ? [e.data.text] : []))
      .join('');
    expect(streamed).toBe('One.  Two.\n\nThree.');
    expect(a.seps).toEqual(['', '  ', '\n\n']);
  });

  it('a terminator followed by a closing quote still ends the sentence', () => {
    const { a } = assemble('He said "stop." Then left.');
    expect(a.sentences.map((s) => s.text)).toEqual(['He said "stop."', 'Then left.']);
  });
});

describe('late results', () => {
  it('can confirm or downgrade a verified sentence but never upgrade a flagged one', () => {
    const { a, events } = assemble('Costs [[F1]]. It is $100.');
    expect(a.sentences.map((s) => s.status)).toEqual(['verified', 'unverified']);
    a.update(1, 'verified', []);
    expect(a.sentences[1]?.status).toBe('unverified');
    a.update(1, 'unchecked', ['judge_unavailable']);
    expect(a.sentences[1]?.status).toBe('unverified');
    a.update(0, 'unchecked', ['judge_unavailable']);
    expect(a.sentences[0]?.status).toBe('unchecked');
    a.update(0, 'verified', []);
    expect(a.sentences[0]?.status).toBe('unchecked'); // unchecked never becomes verified again
    expect(events.filter((e) => e.event === 'verification').length).toBeGreaterThan(0);
  });

  it('a truncated sentence is never changed by a late result', () => {
    const records = recordsFor([finding(1)]);
    const a = new SentenceAssembler({
      records,
      renderer: defaultRenderer,
      t3a: { userMessage: '', localDates: [], findings: [] },
      emit: () => true,
      requestJudge: () => false,
    });
    a.feed([{ type: 'text', text: 'Half a sent' }]);
    a.truncate(false);
    a.update(0, 'unverified', ['judge_partial']);
    expect(a.sentences[0]?.status).toBe('truncated');
  });
});
