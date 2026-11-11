import type { z } from 'zod';
import type { Db } from './connection.js';

type Params = readonly (string | number | bigint | Buffer | null)[];

/**
 * Typed query helpers. Rows come out of SQLite as `unknown`, so every read is validated by a
 * zod schema at this boundary instead of being cast. SQL is always parameterised.
 */
export function queryAll<S extends z.ZodType>(
  db: Db,
  sql: string,
  schema: S,
  params: Params = [],
): Array<z.output<S>> {
  const rows: unknown[] = db.prepare(sql).all(...params);
  return rows.map((row) => schema.parse(row));
}

export function queryOne<S extends z.ZodType>(
  db: Db,
  sql: string,
  schema: S,
  params: Params = [],
): z.output<S> | null {
  const row: unknown = db.prepare(sql).get(...params);
  return row === undefined ? null : schema.parse(row);
}
