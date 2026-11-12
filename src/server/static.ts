import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolves a request path to a file under `root`, or null. The decoded path must stay inside the root: a
 * traversal attempt, an encoded separator trick or a NUL byte all yield null.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const absolute = path.resolve(root, `.${relative}`);
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) return null;
  return absolute;
}

/** Serves the browser client. Read-only: GET and HEAD, no directory listings, no caching surprises. */
export async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  headers: Record<string, string>,
): Promise<void> {
  const notFound = (): void => {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  const file = resolveStaticPath(root, urlPath);
  const type = file ? TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !type) return notFound();
  let body: Buffer;
  try {
    body = await fs.readFile(file);
  } catch {
    return notFound();
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
