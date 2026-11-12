import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  InvalidAckError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
} from '../../../src/db/errors.js';
import { TurnStillRunningError } from '../../../src/orchestration/errors.js';
import { toHttpError } from '../../../src/server/errors.js';
import { HttpError, parseBody, readJsonBody } from '../../../src/server/http.js';
import { ackBodySchema, pathId, turnBodySchema } from '../../../src/server/schemas.js';
import { resolveStaticPath } from '../../../src/server/static.js';
import { newId } from '../../../src/shared/ids.js';

function fakeReq(body: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  };
  return stream;
}

async function failureOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected a failure');
}

describe('request body reading', () => {
  it('parses valid JSON', async () => {
    expect(await readJsonBody(fakeReq('{"a":1}'))).toEqual({ a: 1 });
  });

  it('rejects invalid JSON with 400', async () => {
    const e = await failureOf(readJsonBody(fakeReq('{nope')));
    expect([e.status, e.code]).toEqual([400, 'invalid_json']);
  });

  it('rejects an empty body unless one is optional', async () => {
    const e = await failureOf(readJsonBody(fakeReq('', { 'content-length': '1' })));
    expect(e.status).toBe(400);
    expect(
      await readJsonBody(fakeReq('', { 'content-length': '0' }), 100, { allowEmpty: true }),
    ).toBe(undefined);
  });

  it('rejects the wrong content type with 415', async () => {
    const e = await failureOf(readJsonBody(fakeReq('{}', { 'content-type': 'text/plain' })));
    expect(e.status).toBe(415);
  });

  it('rejects a declared size over the limit with 413, before reading', async () => {
    const e = await failureOf(readJsonBody(fakeReq('{}', { 'content-length': '999999' }), 1000));
    expect([e.status, e.closeConnection]).toEqual([413, true]);
  });

  it('rejects a streamed body over the limit even when the declared length lies', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(5000) });
    const e = await failureOf(readJsonBody(fakeReq(big, { 'content-length': '10' }), 1000));
    expect(e.status).toBe(413);
  });
});

describe('request validation', () => {
  it('accepts a turn request and rejects bad ones with field-level issues only', () => {
    expect(parseBody(turnBodySchema, { text: 'hi', idempotencyKey: 'k' })).toMatchObject({
      text: 'hi',
    });
    const bad: unknown[] = [
      {},
      { text: '', idempotencyKey: 'k' },
      { text: '   ', idempotencyKey: 'k' },
      { text: 'x'.repeat(4001), idempotencyKey: 'k' },
      { text: 'hi', idempotencyKey: '' },
      { text: 'hi', idempotencyKey: 'k', extra: true },
      { text: 5, idempotencyKey: 'k' },
      { text: 'hi', idempotencyKey: 'k', retryOfTurnId: 'nope' },
    ];
    for (const body of bad) {
      let caught: HttpError | null = null;
      try {
        parseBody(turnBodySchema, body);
      } catch (e) {
        caught = e as HttpError;
      }
      expect(caught?.status).toBe(400);
      expect(caught?.code).toBe('invalid_request');
    }
  });

  it('does not echo a submitted value in the error', () => {
    try {
      parseBody(turnBodySchema, { text: 'hi', idempotencyKey: 'k', secretField: 'hunter2-value' });
    } catch (e) {
      expect(JSON.stringify((e as HttpError).extra)).not.toContain('hunter2-value');
    }
  });

  it('validates acknowledgements', () => {
    expect(parseBody(ackBodySchema, { renderedThrough: -1, complete: false })).toBeTruthy();
    for (const body of [
      { renderedThrough: -2, complete: false },
      { renderedThrough: 1.5, complete: false },
      { renderedThrough: 1 },
      { renderedThrough: '1', complete: true },
      { renderedThrough: 1, complete: true, more: 1 },
    ]) {
      expect(() => parseBody(ackBodySchema, body)).toThrow(HttpError);
    }
  });

  it('accepts only well-formed path ids with the right prefix', () => {
    const id = newId('cnv');
    expect(pathId('cnv', id)).toBe(id);
    expect(pathId('trn', id)).toBeNull();
    expect(pathId('cnv', "cnv_x' OR 1=1")).toBeNull();
    expect(pathId('cnv', 'cnv_' + 'a'.repeat(100))).toBeNull();
    expect(pathId('cnv', '')).toBeNull();
  });
});

describe('error mapping', () => {
  it('maps repository and orchestrator errors to the documented statuses', () => {
    const cases: Array<[unknown, number, string]> = [
      [new NotFoundError('turn'), 404, 'not_found'],
      [new InvalidAckError('beyond_streamed_extent', 'x'), 400, 'invalid_ack'],
      [new InvalidAckError('complete_flag_mismatch', 'x'), 400, 'invalid_ack'],
      [new TurnNotFinishedError('trn_1', 'running'), 409, 'turn_not_finished'],
      [new TurnInProgressError('trn_1'), 409, 'turn_in_progress'],
      [new TurnStillRunningError(newId('trn')), 409, 'turn_in_progress'],
      [new IdempotencyConflictError('trn_1'), 409, 'idempotency_conflict'],
      [new Error('boom with secret'), 500, 'internal_error'],
    ];
    for (const [error, status, code] of cases) {
      const mapped = toHttpError(error);
      expect([mapped.status, mapped.code]).toEqual([status, code]);
    }
    expect(toHttpError(new Error('boom with secret')).message).not.toContain('secret');
  });
});

describe('static path resolution', () => {
  const root = path.resolve('/srv/web');
  it('resolves files inside the root and the index', () => {
    expect(resolveStaticPath(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticPath(root, '/js/main.js')).toBe(path.join(root, 'js', 'main.js'));
  });
  it('refuses traversal, encoded traversal, backslashes and NUL', () => {
    for (const p of [
      '/../secret',
      '/%2e%2e/secret',
      '/js/../../x',
      '/a%00b',
      '/..%5csecret',
      '/%zz',
    ]) {
      expect(resolveStaticPath(root, p)).toBeNull();
    }
  });
});
