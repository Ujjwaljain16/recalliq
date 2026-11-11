import { describe, expect, it } from 'vitest';
import { SseParser } from '../../../src/llm/sse-parser.js';

function parseAll(chunks: string[]): Array<{ event: string; data: string }> {
  const p = new SseParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.end()];
}

describe('SseParser', () => {
  it('parses a simple event', () => {
    expect(parseAll(['event: a\ndata: {"x":1}\n\n'])).toEqual([{ event: 'a', data: '{"x":1}' }]);
  });

  it('handles an event split at every possible character boundary', () => {
    const text = 'event: a\ndata: one\ndata: two\n\nevent: b\ndata: three\n\n';
    const whole = parseAll([text]);
    for (let i = 1; i < text.length; i++) {
      expect(parseAll([text.slice(0, i), text.slice(i)])).toEqual(whole);
    }
    expect(whole).toEqual([
      { event: 'a', data: 'one\ntwo' },
      { event: 'b', data: 'three' },
    ]);
  });

  it('accepts CRLF and bare CR, including a CR LF pair split across chunks', () => {
    expect(parseAll(['event: a\r\ndata: x\r\n\r\n'])).toEqual([{ event: 'a', data: 'x' }]);
    expect(parseAll(['event: a\rdata: x\r\r'])).toEqual([{ event: 'a', data: 'x' }]);
    expect(parseAll(['event: a\r', '\ndata: x\r', '\n\r', '\n'])).toEqual([
      { event: 'a', data: 'x' },
    ]);
  });

  it('ignores comments, id and retry, and defaults the event name', () => {
    expect(parseAll([': hi\nid: 4\nretry: 10\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('drops one leading space only, and tolerates a field without a colon', () => {
    expect(parseAll(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }]);
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
  });

  it('does not dispatch an event with no data, and discards an unterminated one on end()', () => {
    expect(parseAll(['event: a\n\n'])).toEqual([]);
    const p = new SseParser();
    expect(p.push('event: a\ndata: partial')).toEqual([]);
    expect(p.end()).toEqual([]);
  });
});
