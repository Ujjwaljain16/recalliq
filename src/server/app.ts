import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConversationRepository, UserRepository } from '../db/index.js';
import type { AckRequest } from '../shared/delivery.js';
import type { ConversationId, Ms, TurnId, UserId } from '../shared/ids.js';
import type { Clock, Logger } from '../shared/infrastructure.js';
import type { SseEvent } from '../shared/sse.js';
import type { TurnOrchestrator, TurnResult } from '../shared/turn.js';
import {
  clearSessionCookieHeader,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  signSession,
  verifySession,
} from './cookie.js';
import { toHttpError } from './errors.js';
import { HttpError, parseBody, readJsonBody, securityHeaders, sendJson } from './http.js';
import { ackBodySchema, pathId, turnBodySchema } from './schemas.js';
import { SseWriter } from './sse.js';
import { serveStatic } from './static.js';
import type { ConversationView } from './types.js';

/** The slice of the turn repository the HTTP layer uses. `SqliteTurnRepository` satisfies it. */
export interface TurnApi {
  ack(
    userId: UserId,
    turnId: TurnId,
    req: AckRequest,
    now: Ms,
  ): { renderedThrough: number; newlyPresented: number };
  get(userId: UserId, turnId: TurnId): { status: string } | null;
  deleteConversation(userId: UserId, conversationId: ConversationId): void;
}

export interface ServerOptions {
  users: UserRepository;
  conversations: ConversationRepository;
  turns: TurnApi;
  view: ConversationView;
  orchestrator: TurnOrchestrator;
  clock: Clock;
  logger: Logger;
  /** Signs the session cookie (at least 32 characters). */
  sessionSecret: string;
  /** The one cross-origin origin allowed to call the API (ALLOWED_ORIGIN). */
  allowedOrigin: string;
  /** Absolute path of the browser client directory. */
  webRoot: string;
  /** What `GET /api/health` reports about the running configuration. */
  info: { mode: string; components: 'scripted' | 'replay' | 'live'; banner: string | null };
  heartbeatMs?: number;
}

export interface AppServer {
  readonly server: http.Server;
  listen(port: number, host: string): Promise<number>;
  /**
   * Stops accepting connections and lets turns that are already running finish and persist, for at most
   * `graceMs`. Returns true when every in-flight turn finished inside the grace period.
   */
  stop(graceMs: number): Promise<boolean>;
}

const PATTERNS = {
  health: /^\/api\/health$/,
  conversations: /^\/api\/conversations$/,
  conversation: /^\/api\/conversations\/([^/]+)$/,
  messages: /^\/api\/conversations\/([^/]+)\/messages$/,
  turns: /^\/api\/conversations\/([^/]+)\/turns$/,
  ack: /^\/api\/turns\/([^/]+)\/ack$/,
};

type Session = { kind: 'none' } | { kind: 'invalid' } | { kind: 'user'; userId: UserId };

export function createAppServer(options: ServerOptions): AppServer {
  const { users, conversations, turns, view, orchestrator, clock, logger } = options;
  const secure = options.allowedOrigin.startsWith('https:');
  const inflight = new Set<Promise<unknown>>();
  let draining = false;
  const baseHeaders = securityHeaders();

  function resolveSession(req: http.IncomingMessage): Session {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (raw === null) return { kind: 'none' };
    const userId = verifySession(raw, options.sessionSecret);
    if (userId === null || !users.exists(userId)) return { kind: 'invalid' };
    return { kind: 'user', userId };
  }

  function requireUser(session: Session): UserId {
    if (session.kind === 'user') return session.userId;
    throw new HttpError(401, 'no_session', 'No valid session. Start a conversation first.');
  }

  /** Cross-origin handling: CORS for the one allowed origin, and a forgery check on state changes. */
  function applyOrigin(req: http.IncomingMessage, headers: Record<string, string>): void {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    const host = req.headers.host;
    const sameOrigin =
      host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
    if (origin === options.allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    } else if (!sameOrigin && req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(403, 'forbidden_origin', 'Cross-origin request not allowed');
    }
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    applyOrigin(req, headers);

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    const match = (re: RegExp): RegExpExecArray | null => re.exec(pathname);
    const allow = (...methods: string[]): void => {
      if (!methods.includes(method)) {
        throw new HttpError(405, 'method_not_allowed', 'Method not allowed', {
          allow: methods,
        });
      }
    };

    if (match(PATTERNS.health)) {
      allow('GET');
      sendJson(res, 200, { status: 'ok', ...options.info }, headers);
      return;
    }

    if (match(PATTERNS.conversations)) {
      allow('GET', 'POST');
      const session = resolveSession(req);
      if (session.kind === 'invalid') return rejectSession(res, headers);
      if (method === 'GET') {
        const list = session.kind === 'user' ? view.list(session.userId, 50) : [];
        sendJson(res, 200, { conversations: list }, headers);
        return;
      }
      // POST: the first conversation of an anonymous visitor creates their user row and cookie.
      await readJsonBody(req, 1024, { allowEmpty: true });
      let userId: UserId;
      const out = { ...headers } as Record<string, string | string[]>;
      if (session.kind === 'user') {
        userId = session.userId;
      } else {
        userId = users.create('real');
        out['Set-Cookie'] = sessionCookieHeader(signSession(userId, options.sessionSecret), {
          secure,
        });
      }
      const created = conversations.create({ userId });
      sendJson(
        res,
        201,
        {
          conversation: {
            id: created.id,
            title: created.title,
            preview: null,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          },
        },
        out,
      );
      return;
    }

    let m = match(PATTERNS.messages);
    if (m) {
      allow('GET');
      const userId = requireSessionUser(req, res, headers);
      if (userId === null) return;
      const conversationId = pathId('cnv', m[1] ?? '');
      const messages = conversationId ? view.messages(userId, conversationId) : null;
      if (!messages) throw new HttpError(404, 'not_found', 'Not found');
      sendJson(res, 200, { conversationId, messages }, headers);
      return;
    }

    m = match(PATTERNS.turns);
    if (m) {
      allow('POST');
      const userId = requireSessionUser(req, res, headers);
      if (userId === null) return;
      const conversationId = pathId('cnv', m[1] ?? '');
      await handleTurn(req, res, headers, userId, conversationId);
      return;
    }

    m = match(PATTERNS.ack);
    if (m) {
      allow('POST');
      const userId = requireSessionUser(req, res, headers);
      if (userId === null) return;
      const turnId = pathId('trn', m[1] ?? '');
      const body = parseBody(ackBodySchema, await readJsonBody(req, 1024));
      if (!turnId) throw new HttpError(404, 'not_found', 'Not found');
      // The one acknowledgement mechanism: the repository's monotonic, idempotent ack (ADR-23).
      const result = turns.ack(userId, turnId, body, clock.now());
      sendJson(res, 200, result, headers);
      return;
    }

    m = match(PATTERNS.conversation);
    if (m) {
      allow('DELETE');
      const userId = requireSessionUser(req, res, headers);
      if (userId === null) return;
      const conversationId = pathId('cnv', m[1] ?? '');
      if (!conversationId || !conversations.getOwned(userId, conversationId)) {
        throw new HttpError(404, 'not_found', 'Not found');
      }
      if (view.hasRunningTurn(userId, conversationId)) {
        throw new HttpError(
          409,
          'turn_in_progress',
          'A turn is still running in this conversation',
        );
      }
      turns.deleteConversation(userId, conversationId);
      res.writeHead(204, { ...headers, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  function rejectSession(res: http.ServerResponse, headers: Record<string, string>): void {
    sendJson(
      res,
      401,
      { error: { code: 'invalid_session', message: 'The session cookie is not valid' } },
      { ...headers, 'Set-Cookie': clearSessionCookieHeader({ secure }) },
    );
  }

  /** Returns the user, or answers 401 itself and returns null. */
  function requireSessionUser(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string>,
  ): UserId | null {
    const session = resolveSession(req);
    if (session.kind === 'invalid') {
      rejectSession(res, headers);
      return null;
    }
    return requireUser(session);
  }

  async function handleTurn(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string>,
    userId: UserId,
    conversationId: ConversationId | null,
  ): Promise<void> {
    if (draining) throw new HttpError(503, 'shutting_down', 'The server is shutting down');
    const body = parseBody(turnBodySchema, await readJsonBody(req));
    if (!conversationId || !conversations.getOwned(userId, conversationId)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }

    const writer = new SseWriter(res, headers, options.heartbeatMs ?? 15_000);
    let errorSent = false;
    const sink = (e: SseEvent): void => {
      if (e.event === 'error') errorSent = true;
      writer.send(e);
    };

    // A client that disconnects does not abort the turn (ADR-17): nothing here listens for it. The sink just
    // goes quiet, and the orchestrator carries on to persist the answer.
    const run = orchestrator.run(
      {
        userId,
        conversationId,
        text: body.text,
        tz: body.tz ?? 'UTC',
        idempotencyKey: body.idempotencyKey,
        ...(body.retryOfTurnId ? { retryOfTurnId: body.retryOfTurnId } : {}),
      },
      sink,
    );
    inflight.add(run);
    let result: TurnResult;
    try {
      result = await run;
    } catch (error) {
      if (!writer.hasStarted) throw error; // refused before the turn began: a normal JSON error
      const mapped = toHttpError(error);
      if (mapped.status >= 500)
        logger.error({ error: String(error) }, 'turn failed after streaming began');
      if (!errorSent) {
        writer.send({
          event: 'error',
          data: { code: mapped.code, text: mapped.message, recoverable: false },
        });
      }
      writer.end();
      return;
    } finally {
      inflight.delete(run);
    }

    if (!writer.hasStarted) {
      // The same idempotency key finished earlier: replay what was stored instead of running it again.
      const stored = view.replay(userId, result.turnId);
      for (const event of stored ?? fallbackReplay(result)) writer.send(event);
    }
    writer.end();
  }

  function fallbackReplay(result: TurnResult): SseEvent[] {
    return [
      {
        event: 'turn.completed',
        data: {
          status: result.status,
          metrics: {
            ttfpMs: result.metrics.ttfpMs,
            ttftMs: result.metrics.ttftMs,
            ttcMs: result.metrics.ttcMs,
          },
        },
      },
    ];
  }

  const server = http.createServer((req, res) => {
    const work = handle(req, res).catch((error: unknown) => {
      logger.error({ error: String(error) }, 'unhandled request failure');
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong' } });
      } else res.end();
    });
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.on('error', () => undefined);
    req.on('error', () => undefined);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Bad request' } });
      return;
    }
    const headers: Record<string, string> = { ...baseHeaders };
    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(options.webRoot, req, res, url.pathname, headers);
      return;
    }
    try {
      await handleApi(req, res, url.pathname, headers);
    } catch (error) {
      const mapped = toHttpError(error);
      if (mapped.status >= 500) logger.error({ error: String(error) }, 'request failed');
      if (res.headersSent) {
        res.end();
        return;
      }
      const extra: Record<string, string> = { ...headers };
      if (mapped.closeConnection) extra['Connection'] = 'close';
      if (mapped.status === 405 && Array.isArray(mapped.extra['allow'])) {
        extra['Allow'] = (mapped.extra['allow'] as string[]).join(', ');
      }
      const details: Record<string, unknown> = { ...mapped.extra };
      delete details['allow'];
      sendJson(
        res,
        mapped.status,
        { error: { code: mapped.code, message: mapped.message, ...details } },
        extra,
      );
      if (mapped.closeConnection) res.once('finish', () => req.destroy());
    }
  }

  return {
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    async stop(graceMs) {
      draining = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), graceMs);
        timer.unref();
      });
      const finished = Promise.allSettled([...inflight]).then(() => 'done' as const);
      const outcome = await Promise.race([finished, timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        server.closeAllConnections();
      } else {
        server.closeIdleConnections();
        await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1_000).unref())]);
        server.closeAllConnections();
      }
      return outcome === 'done';
    },
  };
}
