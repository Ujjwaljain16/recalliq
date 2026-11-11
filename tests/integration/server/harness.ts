import { IN_MEMORY } from '../../../src/db/index.js';
import { startApplication, type Application } from '../../../src/app/application.js';
import type { Components } from '../../../src/app/components.js';
import { loadAppEnv, type AppEnv } from '../../../src/app/env.js';
import { createScriptedComponents, scriptedFactory } from '../../../src/app/scripted/index.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { T0 } from '../../helpers/db.js';

export const SECRET = 'test-secret-test-secret-test-secret-0123456789';

export interface RawSse {
  id: string | null;
  event: string;
  data: unknown;
}

export interface SseRead {
  status: number;
  headers: Headers;
  events: RawSse[];
  comments: string[];
  /** The raw text of the response body. */
  raw: string;
}

/** Parses an SSE body: events separated by a blank line, `:` lines are comments. */
export function parseSse(raw: string): { events: RawSse[]; comments: string[] } {
  const events: RawSse[] = [];
  const comments: string[] = [];
  for (const block of raw.split('\n\n')) {
    if (block.trim() === '') continue;
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim());
      else if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (data.length > 0) events.push({ id, event, data: JSON.parse(data.join('\n')) as unknown });
  }
  return { events, comments };
}

/** A fetch client with a cookie jar, standing in for one browser. */
export class Client {
  cookie: string | null = null;

  constructor(
    private readonly base: string,
    private readonly origin?: string,
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (this.origin) headers['Origin'] = this.origin;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    const set = res.headers.getSetCookie();
    for (const line of set) {
      const pair = line.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    return res;
  }

  async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await this.request(method, path, body);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async newConversation(): Promise<string> {
    const { status, body } = await this.json<{ conversation: { id: string } }>(
      'POST',
      '/api/conversations',
    );
    if (status !== 201) throw new Error(`create conversation failed: ${status}`);
    return body.conversation.id;
  }

  async turn(conversationId: string, text: string, key: string): Promise<SseRead> {
    const res = await this.request('POST', `/api/conversations/${conversationId}/turns`, {
      text,
      idempotencyKey: key,
    });
    const raw = await res.text();
    return { status: res.status, headers: res.headers, raw, ...parseSse(raw) };
  }
}

export interface TestApp {
  app: Application;
  clock: FixedClock;
  base: string;
  client(origin?: string): Client;
  env: AppEnv;
  stop(): Promise<void>;
}

export interface StartOptions {
  clock?: FixedClock;
  dbPath?: string;
  decorate?: (c: Components) => Components;
  heartbeatMs?: number;
  graceMs?: number;
  allowedOrigin?: string;
}

/** The real server, real SQLite with real migrations, the real orchestrator and the scripted components. */
export async function startTestApp(options: StartOptions = {}): Promise<TestApp> {
  const clock = options.clock ?? new FixedClock(T0);
  const base = loadAppEnv({
    APP_MODE: 'real',
    SESSION_SECRET: SECRET,
    ...(options.allowedOrigin ? { ALLOWED_ORIGIN: options.allowedOrigin } : {}),
    SHUTDOWN_GRACE_MS: String(options.graceMs ?? 5000),
  });
  const env: AppEnv = { ...base, config: { ...base.config, dbPath: options.dbPath ?? IN_MEMORY } };
  const app = await startApplication({
    env,
    factory: scriptedFactory(),
    clock,
    port: 0,
    ...(options.decorate ? { decorate: options.decorate } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  const url = `http://127.0.0.1:${app.port}`;
  return {
    app,
    clock,
    base: url,
    env,
    client: (origin) => new Client(url, origin),
    async stop() {
      await app.stop();
    },
  };
}

export function eventNames(events: RawSse[]): string[] {
  return events.map((e) => e.event);
}

export function typed(events: RawSse[]): SseEvent[] {
  return events.map((e) => ({ event: e.event, data: e.data }) as SseEvent);
}

export { createScriptedComponents };
