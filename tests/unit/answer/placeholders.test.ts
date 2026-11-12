import { describe, expect, it } from 'vitest';
import {
  MAX_PLACEHOLDER_CHARS,
  PlaceholderParser,
  parsePlaceholderBody,
  tokenOf,
  type StreamItem,
} from '../../../src/answer/placeholders.js';

/** Merges adjacent text items so results are comparable across chunkings. */
function run(chunks: string[]): StreamItem[] {
  const p = new PlaceholderParser();
  const items = [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
  const out: StreamItem[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.type === 'text' && last?.type === 'text') last.text += it.text;
    else out.push({ ...it });
  }
  return out;
}

describe('parsePlaceholderBody', () => {
  it.each([
    ['F3', { kind: 'finding', ord: 3, variant: 'current' }],
    ['F12:baseline', { kind: 'finding', ord: 12, variant: 'baseline' }],
    ['F999:verdict', { kind: 'finding', ord: 999, variant: 'verdict' }],
    ['F3:derived:0', { kind: 'finding_derived', ord: 3, index: 0 }],
    ['M:msg_abc-1', { kind: 'message', messageId: 'msg_abc-1' }],
    ['S:src_x9', { kind: 'source', snapshotId: 'src_x9' }],
  ])('accepts %s', (body, ref) => {
    expect(parsePlaceholderBody(body)).toEqual(ref);
    expect(tokenOf(ref as never)).toBe(`[[${body}]]`);
  });

  it.each([
    'F0',
    'F1000',
    'f3',
    'F3:other',
    'F3:derived',
    'F3:derived:x',
    'M:abc',
    'S:msg_1',
    'F3 ',
    '',
    'F03',
  ])('rejects %j', (body) => {
    expect(parsePlaceholderBody(body)).toBeNull();
  });
});

describe('PlaceholderParser', () => {
  const placeholder = (token: string): StreamItem => ({
    type: 'placeholder',
    token,
    ref: parsePlaceholderBody(token.slice(2, -2))!,
  });

  it('parses text and placeholders in one delta', () => {
    expect(run(['Costs [[F1]] now.'])).toEqual([
      { type: 'text', text: 'Costs ' },
      placeholder('[[F1]]'),
      { type: 'text', text: ' now.' },
    ]);
  });

  it('a placeholder split across two deltas is held and emitted once', () => {
    const p = new PlaceholderParser();
    expect(p.push('Costs [[F')).toEqual([{ type: 'text', text: 'Costs ' }]);
    expect(p.pending).toBe('[[F');
    expect(p.push('1]] ok')).toEqual([placeholder('[[F1]]'), { type: 'text', text: ' ok' }]);
  });

  it('a placeholder split across three deltas, even between the brackets', () => {
    expect(run(['a [', '[F2:ver', 'dict]] b'])).toEqual([
      { type: 'text', text: 'a ' },
      placeholder('[[F2:verdict]]'),
      { type: 'text', text: ' b' },
    ]);
    expect(run(['a [[F2:verdict]', '] b'])).toEqual(run(['a [[F2:verdict]] b']));
  });

  it('gives the same result for every way of cutting the input into two or three deltas', () => {
    const text =
      'x [[F1]] y [[F2:baseline]] z [[M:msg_1]] [[S:src_1]] [[F3:derived:1]] [[F9 [[ bad]] w';
    const whole = run([text]);
    for (let i = 0; i <= text.length; i++) {
      expect(run([text.slice(0, i), text.slice(i)])).toEqual(whole);
      for (let j = i; j <= text.length; j += 3) {
        expect(run([text.slice(0, i), text.slice(i, j), text.slice(j)])).toEqual(whole);
      }
    }
  });

  it('drops and flags a placeholder that does not match the grammar', () => {
    expect(run(['a [[F0]] b'])).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'malformed', raw: '[[F0]]' },
      { type: 'text', text: ' b' },
    ]);
  });

  it('an opening [[ never closed within 64 characters is dropped, flagged, and the text goes on', () => {
    const filler = 'x'.repeat(100);
    const items = run([`a [[${filler}`]);
    expect(items[0]).toEqual({ type: 'text', text: 'a ' });
    expect(items[1]).toEqual({
      type: 'malformed',
      raw: `[[${'x'.repeat(MAX_PLACEHOLDER_CHARS - 2)}`,
    });
    expect(items[2]).toEqual({ type: 'text', text: 'x'.repeat(100 - (MAX_PLACEHOLDER_CHARS - 2)) });
    // the same when it arrives in small deltas
    const chunks = `a [[${filler}`.match(/.{1,5}/g) ?? [];
    expect(run(chunks)).toEqual(items);
  });

  it('holds up to exactly 64 characters: a closing ]] at the limit is accepted, one later is not', () => {
    const at64 = `[[M:msg_${'a'.repeat(MAX_PLACEHOLDER_CHARS - 2 - 'M:msg_'.length - 2)}]]`;
    expect(at64).toHaveLength(MAX_PLACEHOLDER_CHARS);
    expect(run([at64])[0]?.type).toBe('placeholder');
    const at65 = at64.replace(']]', 'a]]');
    expect(run([at65])[0]?.type).toBe('malformed');
  });

  it('an unfinished fragment at the end of the stream is dropped and flagged; a lone [ is text', () => {
    expect(run(['done [[F1'])).toEqual([
      { type: 'text', text: 'done ' },
      { type: 'malformed', raw: '[[F1' },
    ]);
    expect(run(['array[', ''])).toEqual([{ type: 'text', text: 'array[' }]);
    expect(run(['a [1] b'])).toEqual([{ type: 'text', text: 'a [1] b' }]);
  });
});
