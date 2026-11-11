import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../../src/shared/infrastructure.js';

export function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/llm/${name}`, import.meta.url)),
    'utf8',
  );
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

export type Handler = (call: RecordedCall, n: number) => Response | Promise<Response>;

/** A fetch that records every call and answers from `handler`. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const call: RecordedCall = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: body as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length));
  };
  return { fetch: impl as typeof fetch, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An SSE response whose body is delivered in exactly the given byte chunks. */
export function sseResponse(chunks: Array<string | Uint8Array>, tail?: 'hang'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      if (tail !== 'hang') controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Splits text into byte chunks of `size` (may cut a multi-byte character in two). */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export class ManualClock implements Clock {
  constructor(private t = 1000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
