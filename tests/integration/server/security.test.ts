import { afterEach, describe, expect, it } from 'vitest';
import { signSession } from '../../../src/server/cookie.js';
import { newId } from '../../../src/shared/ids.js';
import { count } from '../../helpers/db.js';
import { SECRET, startTestApp, type TestApp } from './harness.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

interface Err {
  error: { code: string };
}

describe('user scoping', () => {
  it('a second cookie cannot read, acknowledge, write to or delete the first user conversation', async () => {
    t = await startTestApp();
    const alice = t.client();
    const bob = t.client();
    const conversationId = await alice.newConversation();
    const run = await alice.turn(conversationId, 'Hello', 'k-1');
    const turnId = (run.events[0]?.data as { turnId: string }).turnId;
    await bob.newConversation(); // bob is a real, different user

    const read = await bob.json<Err>('GET', `/api/conversations/${conversationId}/messages`);
    expect([read.status, read.body.error.code]).toEqual([404, 'not_found']);

    const ack = await bob.json<Err>('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough: 0,
      complete: false,
    });
    expect(ack.status).toBe(404);

    const write = await bob.turn(conversationId, 'Intruder', 'k-2');
    expect(write.status).toBe(404);

    const del = await bob.json<Err>('DELETE', `/api/conversations/${conversationId}`);
    expect(del.status).toBe(404);

    // nothing of alice's changed
    const messages = await alice.json<{ messages: unknown[] }>(
      'GET',
      `/api/conversations/${conversationId}/messages`,
    );
    expect(messages.body.messages).toHaveLength(2);
    const stored = t.app.db
      .prepare('SELECT rendered_through FROM messages WHERE role = ?')
      .get('assistant') as { rendered_through: number };
    expect(stored.rendered_through).toBe(-1);

    // and bob's own list does not contain it
    const list = await bob.json<{ conversations: Array<{ id: string }> }>(
      'GET',
      '/api/conversations',
    );
    expect(list.body.conversations.map((c) => c.id)).not.toContain(conversationId);
  });

  it('returns 404 for a malformed or unknown id rather than an error that distinguishes it', async () => {
    t = await startTestApp();
    const u = t.client();
    await u.newConversation();
    for (const path of [
      '/api/conversations/nope/messages',
      `/api/conversations/${newId('cnv')}/messages`,
      `/api/turns/${newId('trn')}/ack`,
    ]) {
      const method = path.endsWith('ack') ? 'POST' : 'GET';
      const body = path.endsWith('ack') ? { renderedThrough: 0, complete: false } : undefined;
      expect((await u.json(method, path, body)).status).toBe(404);
    }
  });

  it('deletes a conversation with the privacy procedure, only for its owner', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    await u.turn(id, 'What does Acme cost?', 'k-1');
    expect(count(t.app.db, 'messages')).toBeGreaterThan(0);
    const del = await u.request('DELETE', `/api/conversations/${id}`);
    expect(del.status).toBe(204);
    expect(count(t.app.db, 'messages')).toBe(0);
    expect(count(t.app.db, 'turns')).toBe(0);
    expect((await u.json('GET', `/api/conversations/${id}/messages`)).status).toBe(404);
  });
});

describe('sessions', () => {
  it('rejects a forged cookie, a tampered cookie and an unknown user, and clears the cookie', async () => {
    t = await startTestApp();
    const owner = t.client();
    await owner.newConversation();
    const real = owner.cookie!;

    const forgeries = [
      `recalliq_session=${newId('usr')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      real.slice(0, -2) + 'xx',
      `recalliq_session=${signSession(newId('usr'), 'some-other-secret-some-other-secret-0000')}`,
      // correctly signed, but the user row does not exist
      `recalliq_session=${signSession(newId('usr'), SECRET)}`,
      'recalliq_session=garbage',
    ];
    for (const cookie of forgeries) {
      const res = await fetch(`${t.base}/api/conversations`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
      const post = await fetch(`${t.base}/api/conversations`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(post.status).toBe(401);
    }
    // no user was created for any forgery
    expect(count(t.app.db, 'users')).toBe(1);
  });

  it('sets an httpOnly SameSite cookie when the first conversation is created', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/conversations`, { method: 'POST' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('answers an anonymous list with nothing and creates no user', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/conversations`);
    expect(await res.json()).toEqual({ conversations: [] });
    expect(count(t.app.db, 'users')).toBe(0);
    const msg = await fetch(`${t.base}/api/conversations/${newId('cnv')}/messages`);
    expect(msg.status).toBe(401);
  });
});

describe('request hygiene', () => {
  it('rejects an oversized body with 413', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    const res = await u.request('POST', `/api/conversations/${id}/turns`, {
      text: 'x'.repeat(40_000),
      idempotencyKey: 'k',
    });
    expect(res.status).toBe(413);
    expect(count(t.app.db, 'messages')).toBe(0);
  });

  it('rejects invalid JSON, a wrong content type and an invalid body', async () => {
    t = await startTestApp();
    const u = t.client();
    const id = await u.newConversation();
    const path = `/api/conversations/${id}/turns`;
    const bad = await u.request('POST', path, '{not json');
    expect([bad.status, ((await bad.json()) as Err).error.code]).toEqual([400, 'invalid_json']);
    const type = await u.request('POST', path, '{}', { 'Content-Type': 'text/plain' });
    expect(type.status).toBe(415);
    const invalid = await u.request('POST', path, { text: '', idempotencyKey: 'k' });
    expect([invalid.status, ((await invalid.json()) as Err).error.code]).toEqual([
      400,
      'invalid_request',
    ]);
    expect(count(t.app.db, 'messages')).toBe(0);
  });

  it('answers 405 with an Allow header and 404 for unknown API paths', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await fetch(`${t.base}/api/nothing`)).status).toBe(404);
  });

  it('sends security headers on API and static responses', async () => {
    t = await startTestApp();
    for (const path of ['/api/health', '/']) {
      const res = await fetch(`${t.base}${path}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });
});

describe('cross-origin access', () => {
  it('allows CORS only for ALLOWED_ORIGIN and refuses a state change from another origin', async () => {
    t = await startTestApp({ allowedOrigin: 'http://app.example:5173' });
    const ok = await fetch(`${t.base}/api/health`, {
      headers: { Origin: 'http://app.example:5173' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://app.example:5173');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');

    const other = await fetch(`${t.base}/api/health`, {
      headers: { Origin: 'http://evil.example' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const blocked = await fetch(`${t.base}/api/conversations`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    expect(blocked.status).toBe(403);
    expect(count(t.app.db, 'users')).toBe(0);

    const pre = await fetch(`${t.base}/api/conversations`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://app.example:5173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');

    // the page's own origin always works
    const same = await fetch(`${t.base}/api/conversations`, {
      method: 'POST',
      headers: { Origin: t.base },
    });
    expect(same.status).toBe(201);
  });
});

describe('the browser client files', () => {
  it('serves the page and its modules, and refuses traversal', async () => {
    t = await startTestApp();
    const page = await fetch(`${t.base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('RecallIQ');
    const js = await fetch(`${t.base}/js/main.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    // declaration files and the server source are not served
    expect((await fetch(`${t.base}/js/ack-tracker.d.ts`)).status).toBe(404);
    expect((await fetch(`${t.base}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${t.base}/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${t.base}/nothing.js`)).status).toBe(404);
  });

  it('reports the scripted banner through the health endpoint', async () => {
    t = await startTestApp();
    const health = (await (await fetch(`${t.base}/api/health`)).json()) as {
      status: string;
      components: string;
      banner: string;
    };
    expect(health).toMatchObject({
      status: 'ok',
      components: 'scripted',
      banner: 'Scripted demo responses, no real search or model',
    });
  });
});
