import type { ServerResponse } from 'node:http';
import type { SseEvent } from '../shared/sse.js';

/**
 * Server-Sent Events framing. `data` is JSON, which never contains a raw newline, but the encoder still splits
 * any line break into separate `data:` lines so that a value can never end an event early or inject a field.
 */
export function formatSseEvent(id: number, event: string, data: unknown): string {
  const json = JSON.stringify(data) ?? 'null';
  const lines = json.split(/\r\n|\r|\n/).map((line) => `data: ${line}`);
  // An event name comes from our own union, but strip line breaks anyway: it sits in a line-based protocol.
  const name = event.replace(/[\r\n]/g, ' ');
  return `id: ${id}\nevent: ${name}\n${lines.join('\n')}\n\n`;
}

export function formatSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]/g, ' ')}\n\n`;
}

/**
 * Writes one SSE response. Once the client has gone (or the response ended) every write is a silent no-op:
 * a disconnect never throws into the turn that is producing events (ADR-17).
 */
export class SseWriter {
  private nextId = 1;
  private started = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly res: ServerResponse,
    private readonly headers: Record<string, string>,
    private readonly heartbeatMs: number,
  ) {
    res.on('close', () => this.stop());
  }

  get closed(): boolean {
    return this.res.destroyed || this.res.writableEnded;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      ...this.headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders();
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.comment('heartbeat'), this.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  private write(chunk: string): void {
    if (this.closed) return;
    try {
      this.res.write(chunk);
    } catch {
      /* the socket is gone; the turn carries on */
    }
  }

  send(e: SseEvent): void {
    this.start();
    this.write(formatSseEvent(this.nextId++, e.event, e.data));
  }

  comment(text: string): void {
    if (!this.started) return;
    this.write(formatSseComment(text));
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  end(): void {
    this.stop();
    if (!this.closed) this.res.end();
  }
}
