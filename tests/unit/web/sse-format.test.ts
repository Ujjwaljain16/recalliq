import { describe, expect, it } from 'vitest';
import {
  conversationLabel,
  outcomeNote,
  safeHref,
  sentenceMarker,
  splitCitations,
} from '../../../web/js/format.js';
import { createSseParser, type ParsedSseEvent } from '../../../web/js/sse-parser.js';
import { formatSseEvent } from '../../../src/server/sse.js';

function parse(chunks: string[]) {
  const events: ParsedSseEvent[] = [];
  const comments: string[] = [];
  const p = createSseParser(
    (e) => events.push(e),
    (c) => comments.push(c),
  );
  for (const c of chunks) p.feed(c);
  p.end();
  return { events, comments };
}

describe('SSE parser', () => {
  it('reads what the server writes, however the bytes are split', () => {
    const wire =
      formatSseEvent(1, 'answer.delta', { sentenceIndex: 0, text: 'a\nb' }) +
      ': heartbeat\n\n' +
      formatSseEvent(2, 'turn.completed', { status: 'complete' });
    for (const size of [1, 2, 5, 17, wire.length]) {
      const chunks = wire.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
      const { events, comments } = parse(chunks);
      expect(events.map((e) => [e.id, e.event])).toEqual([
        ['1', 'answer.delta'],
        ['2', 'turn.completed'],
      ]);
      expect(JSON.parse(events[0]!.data)).toEqual({ sentenceIndex: 0, text: 'a\nb' });
      expect(comments).toEqual(['heartbeat']);
    }
  });

  it('handles CRLF, joins multi-line data, and drops an unfinished event', () => {
    const { events } = parse(['event: x\r\ndata: one\r\ndata: two\r\n\r\nevent: y\r\ndata: lost']);
    expect(events).toEqual([{ id: null, event: 'x', data: 'one\ntwo' }]);
  });
});

describe('presentation rules', () => {
  const sources = [
    { n: 1, url: 'https://a.example/p', title: 'A' },
    { n: 2, url: 'javascript:alert(1)', title: 'bad' },
  ];

  it('links a citation only to a known, safe source', () => {
    const segs = splitCitations('Costs $5 [1] or $6 [2] or $7 [3].', sources);
    expect(segs.filter((s) => s.type === 'cite').map((s) => s.text)).toEqual(['[1]']);
    expect(segs.map((s) => s.text).join('')).toBe('Costs $5 [1] or $6 [2] or $7 [3].');
  });

  it('only makes http and https links', () => {
    expect(safeHref('https://x.example/a')).toBe('https://x.example/a');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('marks unverified, unchecked and truncated sentences with words, not colour alone', () => {
    expect(sentenceMarker('unverified', ['free_number'])?.label).toBe('unverified');
    expect(sentenceMarker('unchecked')?.label).toBe('not checked');
    expect(sentenceMarker('truncated')?.label).toBe('cut off');
    expect(sentenceMarker('verified')).toBeNull();
    expect(sentenceMarker('no_claims')).toBeNull();
  });

  it('describes partial, failed and interrupted outcomes honestly', () => {
    expect(outcomeNote('partial', { hasAnswer: true })?.text).toContain('partial');
    expect(outcomeNote('failed', { hasAnswer: true })?.kind).toBe('error');
    expect(outcomeNote('interrupted', { hasAnswer: false })?.text).toContain('before an answer');
    expect(outcomeNote('interrupted', { hasAnswer: true })?.text).toContain('cut off');
    expect(outcomeNote('complete', { hasAnswer: true })).toBeNull();
    expect(outcomeNote('clarify', { hasAnswer: true })).toBeNull();
  });

  it('labels conversations', () => {
    expect(conversationLabel({ title: null, preview: 'hi' })).toBe('hi');
    expect(conversationLabel({ title: null, preview: null })).toBe('Empty conversation');
  });
});
