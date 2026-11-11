import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';

/** A failure that maps straight to an HTTP response. The message is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
    /** Close the connection after replying (an unread request body is left on the socket). */
    public readonly closeConnection = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const MAX_BODY_BYTES = 32 * 1024;

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Reads and parses a JSON request body. The size limit is enforced twice: on the declared length (so an
 * oversized upload is refused before any of it is read) and on the bytes actually received.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  const declared = req.headers['content-length'];
  const hasBody =
    declared !== undefined ? Number(declared) > 0 : req.headers['transfer-encoding'] !== undefined;
  if (!hasBody && options.allowEmpty) return undefined;
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  if (declared !== undefined && Number(declared) > limit) {
    throw new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`, {}, true);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) {
      throw new HttpError(
        413,
        'payload_too_large',
        `Request body exceeds ${limit} bytes`,
        {},
        true,
      );
    }
    chunks.push(buf);
  }
  if (total === 0) {
    if (options.allowEmpty) return undefined;
    throw new HttpError(400, 'invalid_json', 'Request body is empty');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

/** Validates with zod. The issues name fields and rules, never the submitted values. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_request', 'The request body is not valid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
