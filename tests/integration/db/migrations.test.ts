import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DbModeMismatchError,
  getMeta,
  IN_MEMORY,
  initializeDatabase,
  loadMigrations,
  MigrationError,
  openDatabase,
  type Migration,
} from '../../../src/db/index.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { T0 } from '../../helpers/db.js';

const clock = new FixedClock(T0);

const EXPECTED_TRIGGERS = [
  'assertion_events_immutable',
  'assertions_presented_once',
  'belief_history_immutable',
  'conversations_no_fixture_in_real',
  'evidence_immutable',
  'message_search_ad',
  'message_search_ai',
  'message_search_au',
  'messages_ack_monotonic',
  'messages_content_immutable',
  'messages_owner',
  'snapshots_immutable',
  'snapshots_no_fixture_in_real',
  'turns_owner',
  'users_no_fixture_in_real',
];

describe('migrations: fresh database', () => {
  it('creates the schema, stamps db_mode, and reports creation', () => {
    const db = openDatabase(IN_MEMORY);
    const result = initializeDatabase(db, { mode: 'real', clock });
    expect(result).toEqual({ schemaVersion: 1, created: true });
    expect(getMeta(db, 'db_mode')).toBe('real');
    expect(getMeta(db, 'schema_version')).toBe('1');
    expect(getMeta(db, 'created_at')).toBe(String(T0));
  });

  it('installs every integrity trigger from the contract', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toEqual(EXPECTED_TRIGGERS);
  });

  it('creates the FTS5 index and enforces foreign keys on the connection', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.prepare("SELECT count(*) FROM message_fts WHERE message_fts MATCH 'x'").get(),
    ).not.toThrow();
  });

  it('is idempotent: a second run changes nothing and reports not created', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    expect(initializeDatabase(db, { mode: 'real', clock })).toEqual({
      schemaVersion: 1,
      created: false,
    });
  });
});

describe('migrations: guards', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-mig-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T-DB-10: reopening a database in a different APP_MODE is refused', () => {
    const file = path.join(dir, 'a.db');
    const first = openDatabase(file);
    initializeDatabase(first, { mode: 'demo', clock });
    first.close();

    const second = openDatabase(file);
    expect(() => initializeDatabase(second, { mode: 'real', clock })).toThrow(DbModeMismatchError);
    second.close();
  });

  it('uses WAL for file databases', () => {
    const db = openDatabase(path.join(dir, 'wal.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  // Q-003 (approved): connection-level PRAGMAs live in openDatabase(), outside migration transactions.
  it('Q-003: openDatabase configures the connection before any migration runs', () => {
    const memory = openDatabase(IN_MEMORY);
    expect(memory.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(memory.pragma('busy_timeout', { simple: true })).toBe(5000);

    const file = openDatabase(path.join(dir, 'conn.db'));
    expect(file.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(file.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(file.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(file.prepare('SELECT count(*) AS n FROM sqlite_master').get()).toEqual({ n: 0 });
    file.close();
  });

  it('Q-003: no shipped migration contains a PRAGMA statement', () => {
    for (const migration of loadMigrations()) {
      expect(migration.sql, `migration ${migration.version}_${migration.name}`).not.toMatch(
        /^\s*PRAGMA\b/im,
      );
    }
  });

  it('Q-003: each migration runs in its own transaction, together with its version stamp', () => {
    const v1 = loadMigrations()[0] as Migration;
    const probe: Migration = {
      version: 2,
      name: 'probe',
      sql: "CREATE TABLE probe (x TEXT); INSERT INTO probe VALUES ('ran');",
    };
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock, migrations: [v1] });
    // an SQL function that records whether a transaction was open while the migration ran
    let openDuring: boolean | undefined;
    db.function('in_tx', () => {
      openDuring = db.inTransaction;
      return 1;
    });
    const watched: Migration = { ...probe, sql: `${probe.sql} SELECT in_tx();` };
    initializeDatabase(db, { mode: 'real', clock, migrations: [v1, watched] });
    expect(openDuring).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(getMeta(db, 'schema_version')).toBe('2');
  });

  it('refuses a non-empty database that this application did not create', () => {
    const db = openDatabase(IN_MEMORY);
    db.exec('CREATE TABLE stranger (x TEXT)');
    expect(() => initializeDatabase(db, { mode: 'real', clock })).toThrow(MigrationError);
  });

  it('refuses a database newer than this build', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => initializeDatabase(db, { mode: 'real', clock })).toThrow(/newer than this build/);
  });

  it('applies only pending migrations when upgrading', () => {
    const v1 = loadMigrations()[0] as Migration;
    const v2: Migration = { version: 2, name: 'extra', sql: 'CREATE TABLE extra (x TEXT);' };
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock, migrations: [v1] });
    expect(initializeDatabase(db, { mode: 'real', clock, migrations: [v1, v2] })).toEqual({
      schemaVersion: 2,
      created: false,
    });
    expect(getMeta(db, 'schema_version')).toBe('2');
    expect(() => db.prepare('SELECT * FROM extra').all()).not.toThrow();
  });

  it('rolls a failing migration back completely', () => {
    const v1 = loadMigrations()[0] as Migration;
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE half_done (x TEXT); THIS IS NOT SQL;',
    };
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock, migrations: [v1] });
    expect(() =>
      initializeDatabase(db, { mode: 'real', clock, migrations: [v1, broken] }),
    ).toThrow();
    expect(getMeta(db, 'schema_version')).toBe('1');
    expect(() => db.prepare('SELECT * FROM half_done').all()).toThrow(/no such table/);
  });

  it('loadMigrations rejects gaps and badly named files', () => {
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/contiguously/);

    fs.rmSync(path.join(dir, '003_c.sql'));
    fs.writeFileSync(path.join(dir, 'oops.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/does not match/);
  });

  it('the shipped migrations load and start at version 1', () => {
    const all = loadMigrations();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0]?.version).toBe(1);
  });
});
