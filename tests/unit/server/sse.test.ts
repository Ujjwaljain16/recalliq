import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { formatSseComment, formatSseEvent, SseWriter } from '../../../src/server/sse.js';

describe('SSE framing', () => {
  it('writes id, event and data lines and ends with a blank line', () => {
    expect(formatSseEvent(7, 'progress', { stage: 'ANALYZING', text: 'Thinking' })).toBe(
      'id: 7\nevent: progress\ndata: {"stage":"ANALYZING","text":"Thinking"}\n\n',
    );
  });

  it('keeps a newline inside a value on one data line (JSON escapes it)', () => {
    const frame = formatSseEvent(1, 'answer.delta', { text: 'line one\nline two\r\nthree' });
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines).toHaveLength(1);
    expect(frame).not.toContain('line one\nline two');
    expect(frame.endsWith('\n\n')).toBe(true);
    // exactly one blank line: the event cannot end early
    expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
    const payload = JSON.parse(dataLines[0]!.slice('data: '.length)) as { text: string };
    expect(payload.text).toBe('line one\nline two\r\nthree');
  });

  it('cannot be made to inject a field or a second event through the data', () => {
    const evil = 'x\n\nevent: error\ndata: {"code":"injected"}';
    const frame = formatSseEvent(1, 'answer.delta', { text: evil });
    expect(frame.match(/\n\n/g)).toHaveLength(1);
    expect(frame.split('\n').filter((l) => l.startsWith('event: '))).toEqual([
      'event: answer.delta',
    ]);
  });

  it('does not treat U+2028 as a line break, since SSE only breaks on LF, CR and CRLF', () => {
    const frame = formatSseEvent(2, 'warning', { text: 'a\u2028b' });
    const lines = frame.split('\n').filter((l) => l.startsWith('data: '));
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!.slice(6)) as { text: string }).text).toBe('a\u2028b');
  });

  it('strips line breaks from an event name', () => {
    expect(formatSseEvent(1, 'a\nb', {})).toContain('event: a b\n');
  });

  it('writes comments for heartbeats and flattens their line breaks', () => {
    expect(formatSseComment('heartbeat')).toBe(': heartbeat\n\n');
    expect(formatSseComment('x\ny')).toBe(': x y\n\n');
  });
});

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  head: { status: number; headers: Record<string, string> } | null = null;
  destroyed = false;
  writableEnded = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.head = { status, headers };
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
  }
}

describe('SseWriter', () => {
  it('sends headers with the first event, numbers events from 1, and ends the response', () => {
    const res = new FakeRes();
    const w = new SseWriter(res as unknown as ServerResponse, { 'X-Test': '1' }, 0);
    expect(res.head).toBeNull();
    w.send({ event: 'turn.started', data: { turnId: 'trn_1', userMessageId: 'msg_1' } });
    w.send({ event: 'progress', data: { stage: 'ANALYZING', text: 'x' } });
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers['Content-Type']).toContain('text/event-stream');
    expect(res.head?.headers['X-Test']).toBe('1');
    expect(res.chunks[0]).toContain('id: 1\n');
    expect(res.chunks[1]).toContain('id: 2\n');
    w.end();
    expect(res.writableEnded).toBe(true);
  });

  it('goes quiet once the client is gone and never throws', () => {
    const res = new FakeRes();
    const w = new SseWriter(res as unknown as ServerResponse, {}, 0);
    w.send({ event: 'progress', data: { stage: 'ANALYZING', text: 'a' } });
    res.destroyed = true;
    res.emit('close');
    expect(() =>
      w.send({ event: 'progress', data: { stage: 'ANALYZING', text: 'b' } }),
    ).not.toThrow();
    expect(res.chunks).toHaveLength(1);
  });

  it('does not write a heartbeat before the stream has started', () => {
    const res = new FakeRes();
    const w = new SseWriter(res as unknown as ServerResponse, {}, 0);
    w.comment('heartbeat');
    expect(res.chunks).toHaveLength(0);
  });
});
