import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Components } from '../../../src/app/components.js';
import type { TurnAnalysis } from '../../../src/shared/index.js';
import { count } from '../../helpers/db.js';
import { startTestApp, type TestApp } from './harness.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with a Host header of our choosing (fetch does not let a caller set Host). */
function raw(
  app: TestApp,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<RawResponse> {
  const target = new URL(app.base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, method, path, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function errorCode(r: RawResponse): string {
  return (JSON.parse(r.body) as { error: { code: string } }).error.code;
}

/** Holds every turn in analysis until released. */
function gate(): { release: () => void; decorate: (c: Components) => Components } {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => (release = resolve));
  return {
    release: () => release(),
    decorate: (c) => ({
      ...c,
      analyzer: {
        analyze: async (input, budget): Promise<TurnAnalysis> => {
          await open;
          return c.analyzer.analyze(input, budget);
        },
      },
    }),
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('DNS rebinding: only known host names are served', () => {
  it('refuses a foreign Host with 421 for GET, POST and static files, even with a matching Origin', async () => {
    t = await startTestApp();
    const port = new URL(t.base).port;
    const evil = { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` };
    for (const [method, path] of [
      ['GET', '/api/health'],
      ['GET', '/api/conversations'],
      ['POST', '/api/conversations'],
      ['GET', '/'],
      ['GET', '/js/main.js'],
    ] as const) {
      const res = await raw(t, method, path, evil);
      expect(res.status, `${method} ${path}`).toBe(421);
      expect(errorCode(res)).toBe('misdirected_request');
    }
    expect(count(t.app.db, 'users')).toBe(0);
    const malformed = await raw(t, 'GET', '/api/health', { Host: `localhost@evil.example` });
    expect(malformed.status).toBe(421);
  });

  it('serves localhost, 127.0.0.1 and [::1] on any port', async () => {
    t = await startTestApp();
    const port = new URL(t.base).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
      const res = await raw(t, 'GET', '/api/health', { Host: host });
      expect(res.status, host).toBe(200);
    }
    const post = await raw(t, 'POST', '/api/conversations', {
      Host: `localhost:${port}`,
      Origin: `http://localhost:${port}`,
    });
    expect(post.status).toBe(201);
  });

  it('serves the configured HOST and the ALLOWED_ORIGIN host, and nothing else', async () => {
    t = await startTestApp({
      vars: { HOST: '127.0.0.2' },
      allowedOrigin: 'https://app.example',
    });
    const port = new URL(t.base).port;
    expect((await raw(t, 'GET', '/api/health', { Host: `127.0.0.2:${port}` })).status).toBe(200);
    expect((await raw(t, 'GET', '/api/health', { Host: 'app.example' })).status).toBe(200);
    expect((await raw(t, 'GET', '/api/health', { Host: `127.0.0.3:${port}` })).status).toBe(421);
  });
});

describe('cross-origin defaults', () => {
  it('sends no CORS headers at all when ALLOWED_ORIGIN is not set', async () => {
    t = await startTestApp();
    expect(t.env.config.allowedOrigin).toBeUndefined();
    const res = await fetch(`${t.base}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const post = await fetch(`${t.base}/api/conversations`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(post.status).toBe(403);
  });
});

describe('the session cookie', () => {
  const cookieOf = async (app: TestApp): Promise<string> =>
    (await fetch(`${app.base}/api/conversations`, { method: 'POST' })).headers.get('set-cookie') ??
    '';

  it('is not Secure for a plain-http development server, and keeps its one-year Max-Age', async () => {
    t = await startTestApp();
    const cookie = await cookieOf(t);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
  });

  it('is Secure when NODE_ENV=production', async () => {
    t = await startTestApp({ vars: { NODE_ENV: 'production' } });
    expect(await cookieOf(t)).toContain('Secure');
  });

  it('is Secure when ALLOWED_ORIGIN is https', async () => {
    t = await startTestApp({ allowedOrigin: 'https://app.example' });
    expect(await cookieOf(t)).toContain('Secure');
  });
});

describe('quotas', () => {
  it('caps the turns one user has running across conversations, per user, until one finishes', async () => {
    const g = gate();
    t = await startTestApp({ decorate: g.decorate });
    const alice = t.client();
    const bob = t.client();
    const [a1, a2, a3] = [
      await alice.newConversation(),
      await alice.newConversation(),
      await alice.newConversation(),
    ];
    const b1 = await bob.newConversation();
    const running = [alice.turn(a1, 'One', 'k1'), alice.turn(a2, 'Two', 'k2')];
    await until(() => count(t!.app.db, 'turns', "status = 'running'") === 2);

    const refused = await alice.request('POST', `/api/conversations/${a3}/turns`, {
      text: 'Three',
      idempotencyKey: 'k3',
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'too_many_turns',
    );
    expect(count(t.app.db, 'turns')).toBe(2);

    // another user is not affected
    running.push(bob.turn(b1, 'Bob', 'kb'));
    await until(() => count(t!.app.db, 'turns', "status = 'running'") === 3);

    g.release();
    await Promise.all(running);
    const after = await alice.turn(a3, 'Three', 'k3');
    expect(after.status).toBe(200);
    expect(after.events.at(-1)?.event).toBe('turn.completed');
  });

  it('limits the rate of new turns per user, and recovers as time passes', async () => {
    t = await startTestApp({ vars: { TURN_RATE_PER_MINUTE: '1', TURN_RATE_BURST: '2' } });
    const alice = t.client();
    const bob = t.client();
    const id = await alice.newConversation();
    const bobs = await bob.newConversation();
    expect((await alice.turn(id, 'One', 'k1')).status).toBe(200);
    expect((await alice.turn(id, 'Two', 'k2')).status).toBe(200);

    const refused = await alice.request('POST', `/api/conversations/${id}/turns`, {
      text: 'Three',
      idempotencyKey: 'k3',
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'turn_rate_limited',
    );
    expect(count(t.app.db, 'turns')).toBe(2);

    expect((await bob.turn(bobs, 'Bob', 'kb')).status).toBe(200);

    t.clock.advance(59_000);
    expect((await alice.turn(id, 'Three', 'k3')).status).toBe(429);
    t.clock.advance(1_000);
    expect((await alice.turn(id, 'Three', 'k3')).status).toBe(200);
  });

  it('limits new anonymous sessions per client address, not conversations of a known user', async () => {
    t = await startTestApp({ vars: { NEW_SESSIONS_PER_HOUR: '2' } });
    const first = t.client();
    await first.newConversation();
    await t.client().newConversation();

    const refused = await fetch(`${t.base}/api/conversations`, { method: 'POST' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1800');
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'too_many_sessions',
    );
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(count(t.app.db, 'users')).toBe(2);

    // a user who already has a session is not limited by it
    await first.newConversation();

    t.clock.advance(30 * 60_000);
    expect((await fetch(`${t.base}/api/conversations`, { method: 'POST' })).status).toBe(201);
    expect(count(t.app.db, 'users')).toBe(3);
  });

  it('configures the node:http limits', async () => {
    t = await startTestApp({
      vars: {
        SERVER_MAX_CONNECTIONS: '64',
        SERVER_HEADERS_TIMEOUT_MS: '10000',
        SERVER_REQUEST_TIMEOUT_MS: '15000',
      },
    });
    const server = t.app.server;
    expect([server.maxConnections, server.headersTimeout, server.requestTimeout]).toEqual([
      64, 10_000, 15_000,
    ]);
  });
});
