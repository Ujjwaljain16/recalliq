/** One dispatched server-sent event. */
export interface SseMessage {
  /** The `event:` field, or 'message' when absent (per the SSE specification). */
  event: string;
  /** The `data:` lines joined with "\n". */
  data: string;
}

/**
 * Incremental parser for `text/event-stream`. Feed it decoded text in arbitrary chunks (a chunk may end in
 * the middle of a line, or between the "\r" and "\n" of a line ending).
 *
 * Rules implemented: lines end in \n, \r or \r\n; a blank line dispatches the event; a line starting with ":"
 * is a comment; one optional space after the colon is dropped; `data` lines accumulate; `id` and `retry` are
 * ignored. An event that is still incomplete when the stream ends is discarded, as the specification says:
 * `end()` therefore returns nothing, and truncation is detected by the caller from the missing terminal event.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private hasData = false;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing "\r" might be the first half of "\r\n": wait for the next chunk.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      const dispatched = this.line(line);
      if (dispatched) out.push(dispatched);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Settles a pending final carriage return as a line ending, then discards any partial event. */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer.endsWith(String.fromCharCode(13))) {
      const dispatched = this.line(this.buffer.slice(0, -1));
      if (dispatched) out.push(dispatched);
    }
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.hasData = false;
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      const had = this.hasData;
      const msg: SseMessage = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      this.hasData = false;
      return had ? msg : null;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      this.hasData = true;
    }
    return null;
  }
}
