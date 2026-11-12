// Thin wrappers over the HTTP API (docs/api.md). Cookies are same-origin and httpOnly, so nothing here touches
// credentials: the browser attaches the session cookie by itself.

import { createSseParser } from './sse-parser.js';

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function failure(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const error = body && typeof body === 'object' && body.error ? body.error : {};
  return new ApiError(
    res.status,
    error.code ?? 'http_error',
    error.message ?? `Request failed (${res.status})`,
    error,
  );
}

async function json(method, path, body, init = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  });
  if (!res.ok) throw await failure(res);
  return res.status === 204 ? null : res.json();
}

export const api = {
  health: () => json('GET', '/api/health'),
  conversations: () => json('GET', '/api/conversations'),
  createConversation: () => json('POST', '/api/conversations'),
  messages: (conversationId) => json('GET', `/api/conversations/${conversationId}/messages`),
  deleteConversation: (conversationId) => json('DELETE', `/api/conversations/${conversationId}`),
  ack: (turnId, body) => json('POST', `/api/turns/${turnId}/ack`, body, { keepalive: true }),

  /** The page is going away: hand the acknowledgement to the browser to deliver. Returns false if refused. */
  beaconAck(turnId, body) {
    if (typeof navigator.sendBeacon !== 'function') return false;
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
    return navigator.sendBeacon(`/api/turns/${turnId}/ack`, blob);
  },

  /**
   * Sends a message and reads the event stream, calling `onEvent({ id, event, data })` for each event.
   * Resolves to true when `turn.completed` was received and false when the stream ended without it.
   */
  async streamTurn(conversationId, payload, onEvent) {
    const res = await fetch(`/api/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await failure(res);
    if (!res.body) throw new ApiError(0, 'no_stream', 'The browser could not read the stream');
    let completed = false;
    const parser = createSseParser((e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (e.event === 'turn.completed') completed = true;
      onEvent({ id: e.id, event: e.event, data });
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
    return completed;
  },
};
