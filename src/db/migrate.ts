import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AppMode } from '../config/env.js';
import type { Clock } from '../shared/infrastructure.js';
import type { Db } from './connection.js';
import { DbModeMismatchError, MigrationError } from './errors.js';
import { queryOne } from './sql.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const DEFAULT_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

/** Reads `NNN_name.sql` files. Versions must be contiguous from 1, so a gap is caught at startup. */
export function loadMigrations(dir: string = DEFAULT_DIR): Migration[] {
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file): Migration => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new MigrationError(`Migration file "${file}" does not match NNN_name.sql`);
      return {
        version: Number(match[1]),
        name: match[2] ?? file,
        sql: fs.readFileSync(`${dir}/${file}`, 'utf8'),
      };
    });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migrations must be numbered contiguously from 001; found ${m.version} at position ${i + 1}`,
      );
    }
  });
  return migrations;
}

const metaRow = z.object({ value: z.string() });

export function getMeta(db: Db, key: string): string | null {
  return queryOne(db, 'SELECT value FROM meta WHERE key = ?', metaRow, [key])?.value ?? null;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

const countRow = z.object({ n: z.number() });

function hasAnyTable(db: Db): boolean {
  const row = queryOne(
    db,
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    countRow,
  );
  return (row?.n ?? 0) > 0;
}

function hasMetaTable(db: Db): boolean {
  const row = queryOne(
    db,
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    countRow,
  );
  return (row?.n ?? 0) > 0;
}

const modeSchema = z.enum(['real', 'demo']);

/** Throws DbModeMismatchError unless the database was created in `expected` mode. */
export function assertDbMode(db: Db, expected: AppMode): void {
  const stored = hasMetaTable(db) ? getMeta(db, 'db_mode') : null;
  const parsed = modeSchema.safeParse(stored);
  if (!parsed.success) {
    throw new MigrationError(
      'Database has no valid db_mode; it was not created by this application',
    );
  }
  if (parsed.data !== expected) throw new DbModeMismatchError(expected, parsed.data);
}

export interface InitializeOptions {
  mode: AppMode;
  clock: Clock;
  migrations?: Migration[];
}

export interface InitializeResult {
  schemaVersion: number;
  /** True when this call created the database. */
  created: boolean;
}

/**
 * Brings a database to the latest schema.
 *
 * - A fresh database is migrated and stamped with `db_mode`. The stamp is written inside the same
 *   transaction as the first migration because the demo-isolation triggers read it.
 * - An existing database must already carry the same `db_mode` (contracts §1: startup refuses to
 *   run if APP_MODE differs), and must not be newer than this build.
 * - Each migration runs in its own transaction, so a failure leaves the previous version intact.
 */
export function initializeDatabase(db: Db, opts: InitializeOptions): InitializeResult {
  const migrations = opts.migrations ?? loadMigrations();
  const latest = migrations.length;

  if (!hasMetaTable(db)) {
    if (hasAnyTable(db)) {
      throw new MigrationError(
        'Database is not empty but has no meta table; refusing to migrate it',
      );
    }
    applyAll(db, migrations, 0, opts);
    return { schemaVersion: latest, created: true };
  }

  assertDbMode(db, opts.mode);
  const current = Number(getMeta(db, 'schema_version'));
  if (!Number.isInteger(current) || current < 1) {
    throw new MigrationError('Database has an invalid schema_version');
  }
  if (current > latest) {
    throw new MigrationError(
      `Database schema version ${current} is newer than this build supports (${latest})`,
    );
  }
  applyAll(db, migrations, current, opts);
  return { schemaVersion: latest, created: false };
}

function applyAll(db: Db, migrations: Migration[], from: number, opts: InitializeOptions): void {
  for (const m of migrations.filter((x) => x.version > from)) {
    db.transaction(() => {
      db.exec(m.sql);
      if (m.version === 1) {
        setMeta(db, 'db_mode', opts.mode);
        setMeta(db, 'created_at', String(opts.clock.now()));
      }
      setMeta(db, 'schema_version', String(m.version));
    }).immediate();
  }
}
