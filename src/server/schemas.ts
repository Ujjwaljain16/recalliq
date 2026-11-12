import { z } from 'zod';
import { isId, type TurnId } from '../shared/ids.js';

export const turnBodySchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((s) => s.trim().length > 0, 'text must not be blank'),
  idempotencyKey: z.string().min(1).max(128),
  /** The browser's IANA time zone. Optional: the orchestrator falls back to UTC for an unknown one. */
  tz: z.string().min(1).max(64).optional(),
  retryOfTurnId: z
    .string()
    .refine((s): s is TurnId => isId('trn', s), 'must be a turn id')
    .optional(),
});

export const ackBodySchema = z.strictObject({
  renderedThrough: z.number().int().min(-1),
  complete: z.boolean(),
});

/** Path ids: a known prefix and a conservative character set, so nothing odd reaches a query or a log line. */
export function pathId<P extends string>(prefix: P, raw: string): `${P}_${string}` | null {
  if (raw.length > 80 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return isId(prefix, raw) ? raw : null;
}

export const exampleHistoryBodySchema = z.strictObject({
  /** The browser's IANA time zone: the example days are dated in it. */
  tz: z.string().min(1).max(64),
});
