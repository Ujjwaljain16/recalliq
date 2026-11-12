import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './harness.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

describe('POST /api/example-history', () => {
  it('needs a session, checks the time zone, writes the examples once, and lists them', async () => {
    t = await startTestApp();
    const user = t.client();
    expect((await user.json('POST', '/api/example-history', { tz: 'UTC' })).status).toBe(401);
    await user.newConversation();
    expect((await user.json('POST', '/api/example-history', { tz: 'Not/AZone' })).status).toBe(400);
    const first = await user.json<{ created: number }>('POST', '/api/example-history', {
      tz: 'UTC',
    });
    expect(first).toEqual({ status: 200, body: { created: 3 } });
    const again = await user.json<{ created: number }>('POST', '/api/example-history', {
      tz: 'UTC',
    });
    expect(again.body.created).toBe(0);
    const list = await user.json<{ conversations: Array<{ title: string | null }> }>(
      'GET',
      '/api/conversations',
    );
    const titles = list.body.conversations.map((c) => c.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Example: CRM shortlist',
        'Example: Neon pricing',
        'Example: Postgres hosting',
      ]),
    );
  });

  it("writes only for the caller: another user's list is untouched", async () => {
    t = await startTestApp();
    const a = t.client();
    const b = t.client();
    await a.newConversation();
    await b.newConversation();
    await a.json('POST', '/api/example-history', { tz: 'UTC' });
    const other = await b.json<{ conversations: unknown[] }>('GET', '/api/conversations');
    expect(other.body.conversations).toHaveLength(1);
  });
});
