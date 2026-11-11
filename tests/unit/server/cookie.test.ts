import { describe, expect, it } from 'vitest';
import {
  clearSessionCookieHeader,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  signSession,
  verifySession,
} from '../../../src/server/cookie.js';
import { newId } from '../../../src/shared/ids.js';

const SECRET = 'a-secret-that-is-at-least-thirty-two-chars';

describe('session cookie signing', () => {
  it('round-trips a user id', () => {
    const user = newId('usr');
    expect(verifySession(signSession(user, SECRET), SECRET)).toBe(user);
  });

  it('rejects a value signed with another secret', () => {
    const value = signSession(newId('usr'), SECRET);
    expect(verifySession(value, `${SECRET}-other`)).toBeNull();
  });

  it('rejects a tampered user id (the signature no longer matches)', () => {
    const value = signSession(newId('usr'), SECRET);
    const signature = value.slice(value.lastIndexOf('.'));
    expect(verifySession(`${newId('usr')}${signature}`, SECRET)).toBeNull();
  });

  it('rejects a tampered or truncated signature', () => {
    const user = newId('usr');
    const value = signSession(user, SECRET);
    expect(verifySession(`${value}x`, SECRET)).toBeNull();
    expect(verifySession(value.slice(0, -1), SECRET)).toBeNull();
    const flipped = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
    expect(verifySession(flipped, SECRET)).toBeNull();
  });

  it('rejects malformed values without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'usr_x.', '.sig', 'x'.repeat(1000), 'a.b.c']) {
      expect(verifySession(bad, SECRET)).toBeNull();
    }
  });

  it('rejects a correctly signed value that is not a user id', () => {
    // Signed by us but with a non-user prefix: it must not be accepted as a user.
    const forged = signSession('cnv_123' as never, SECRET);
    expect(verifySession(forged, SECRET)).toBeNull();
  });
});

describe('cookie header handling', () => {
  it('reads one cookie among several', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`, SESSION_COOKIE)).toBe('abc.def');
    expect(readCookie('a=1', SESSION_COOKIE)).toBeNull();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
  });

  it('sets httpOnly and SameSite=Lax, and Secure only when asked', () => {
    const plain = sessionCookieHeader('v', { secure: false });
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).toContain('Path=/');
    expect(plain).not.toContain('Secure');
    expect(sessionCookieHeader('v', { secure: true })).toContain('Secure');
  });

  it('expires the cookie when clearing it', () => {
    expect(clearSessionCookieHeader({ secure: false })).toContain('Max-Age=0');
  });
});
