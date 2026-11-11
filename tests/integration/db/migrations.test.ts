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
import { openTestDb, T0 } from '../../helpers/db.js';
import { advance, startTurn } from '../../helpers/turns.js';

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

const LATEST = loadMigrations().length;

function installedTriggers(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/**
 * The triggers the migrations leave installed, in order: a CREATE adds a name, a DROP removes it. A name that is
 * created twice without a DROP in between is a duplicate.
 */
function declaredTriggers(migrations: Migration[]): { installed: string[]; duplicates: string[] } {
  const installed = new Set<string>();
  const duplicates: string[] = [];
  for (const m of migrations) {
    for (const match of m.sql.matchAll(/(CREATE|DROP) TRIGGER (?:IF EXISTS )?(\w+)/g)) {
      const name = match[2] as string;
      if (match[1] === 'DROP') installed.delete(name);
      else if (installed.has(name)) duplicates.push(name);
      else installed.add(name);
    }
  }
  return { installed: [...installed].sort(), duplicates };
}

describe('migrations: fresh database', () => {
  it('creates the schema, stamps db_mode, and reports creation', () => {
    const db = openDatabase(IN_MEMORY);
    const result = initializeDatabase(db, { mode: 'real', clock });
    expect(result).toEqual({ schemaVersion: LATEST, created: true });
    expect(getMeta(db, 'db_mode')).toBe('real');
    expect(getMeta(db, 'schema_version')).toBe(String(LATEST));
    expect(getMeta(db, 'created_at')).toBe(String(T0));
  });

  it('ships migrations 001 to 008 and 010, numbered contiguously', () => {
    const shipped = loadMigrations();
    expect(shipped.map((m) => m.version)).toEqual(shipped.map((_, i) => i + 1));
    expect(
      shipped
        .filter((m) => m.version <= 8 || m.version === 10)
        .map((m) => `${m.version}_${m.name}`),
    ).toEqual([
      '1_init',
      '2_demo_isolation',
      '3_ownership_consistency',
      '4_turn_lifecycle',
      '5_delivery_acknowledgement',
      '6_decision_ownership',
      '7_search_ownership',
      '8_belief_ownership',
      '10_turn_failure_edges',
    ]);
  });

  it('installs every integrity trigger from the contract (migration 001)', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    expect(installedTriggers(db)).toEqual(expect.arrayContaining(EXPECTED_TRIGGERS));
  });

  it('installs exactly the triggers the shipped migrations declare', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    const { installed, duplicates } = declaredTriggers(loadMigrations());
    expect(duplicates).toEqual([]); // a trigger is only re-created after an explicit DROP
    expect(installedTriggers(db)).toEqual(installed);
  });

  it('migration 010 replaces only the transition trigger of migration 004', () => {
    const all = loadMigrations();
    const ten = all.find((m) => m.version === 10) as Migration;
    expect([...ten.sql.matchAll(/DROP TRIGGER (\w+)/g)].map((m) => m[1])).toEqual([
      'turns_state_transition',
    ]);
    expect([...ten.sql.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1])).toEqual([
      'turns_state_transition',
    ]);
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock });
    const fourDeclared = [...(all[3] as Migration).sql.matchAll(/CREATE TRIGGER (\w+)/g)].map(
      (m) => m[1] as string,
    );
    expect(installedTriggers(db)).toEqual(expect.arrayContaining(fourDeclared));
  });

  it('upgrades a populated version-8 database: rows kept, the new failure edges apply to a turn already in flight', () => {
    const t = openTestDb('real', 8);
    const { db } = t;
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    const { turnId } = startTurn(t, user, conversation.id);
    advance(t, user, turnId, ['ANALYZING', 'RESOLVING_CONTEXT', 'PLANNING', 'SEARCHING']);
    // before the upgrade a mid-pipeline turn has no way to PERSISTING
    expect(() => t.turns.setState(user, turnId, 'PERSISTING')).toThrow(/invalid turn state/i);
    expect(getMeta(db, 'schema_version')).toBe('8');

    expect(initializeDatabase(db, { mode: 'real', clock })).toEqual({
      schemaVersion: LATEST,
      created: false,
    });
    expect(db.prepare('SELECT state, status FROM turns WHERE id = ?').get(turnId)).toEqual({
      state: 'SEARCHING',
      status: 'running',
    });
    t.turns.setState(user, turnId, 'PERSISTING');
    expect(db.prepare('SELECT state FROM turns WHERE id = ?').get(turnId)).toEqual({
      state: 'PERSISTING',
    });
    // finality and identity triggers of migration 004 survive the replacement
    expect(() =>
      db.prepare("UPDATE turns SET state = 'COMPLETED' WHERE id = ?").run(turnId),
    ).toThrow(/running turn cannot be in a final state|already finished|invalid turn state/i);
  });

  it('upgrades a version-1 database to the latest schema without losing its data', () => {
    const [v1] = loadMigrations() as [Migration, ...Migration[]];
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock, migrations: [v1] });
    db.prepare("INSERT INTO users (id, kind, created_at) VALUES ('usr_old', 'real', 1)").run();
    expect(installedTriggers(db)).toHaveLength(EXPECTED_TRIGGERS.length);

    expect(initializeDatabase(db, { mode: 'real', clock })).toEqual({
      schemaVersion: LATEST,
      created: false,
    });
    expect(getMeta(db, 'schema_version')).toBe(String(LATEST));
    expect(db.prepare("SELECT count(*) AS n FROM users WHERE id = 'usr_old'").get()).toEqual({
      n: 1,
    });
    expect(installedTriggers(db).length).toBeGreaterThan(EXPECTED_TRIGGERS.length);
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
      schemaVersion: LATEST,
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

  // Connection-level PRAGMAs live in openDatabase(), outside migration transactions.
  it('pragmas: openDatabase configures the connection before any migration runs', () => {
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

  it('pragmas: no shipped migration contains a PRAGMA statement', () => {
    for (const migration of loadMigrations()) {
      expect(migration.sql, `migration ${migration.version}_${migration.name}`).not.toMatch(
        /^\s*PRAGMA\b/im,
      );
    }
  });

  it('pragmas: each migration runs in its own transaction, together with its version stamp', () => {
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
