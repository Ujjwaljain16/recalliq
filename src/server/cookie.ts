import { createHmac, timingSafeEqual } from 'node:crypto';
import { isId, type UserId } from '../shared/ids.js';

/**
 * Anonymous session cookie (ADR-20). The value is `<userId>.<signature>` where the signature is the
 * base64url HMAC-SHA256 of the user id under SESSION_SECRET. The cookie names a user row and nothing else;
 * it grants nothing beyond that user's own data.
 */

export const SESSION_COOKIE = 'recalliq_session';
const MAX_VALUE_LENGTH = 256;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function sign(userId: string, secret: string): string {
  return createHmac('sha256', secret).update(userId).digest('base64url');
}

export function signSession(userId: UserId, secret: string): string {
  return `${userId}.${sign(userId, secret)}`;
}

/** Returns the user id of a correctly signed value, or null for anything forged, tampered or malformed. */
export function verifySession(value: string, secret: string): UserId | null {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(userId, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return isId('usr', userId) ? userId : null;
}

/** Reads one cookie from a Cookie header. Returns null when absent. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface CookieOptions {
  secure: boolean;
}

export function sessionCookieHeader(value: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ONE_YEAR_SECONDS}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(options: CookieOptions): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
