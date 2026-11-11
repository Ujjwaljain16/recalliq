import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export const IN_MEMORY = ':memory:';

/**
 * Opens a SQLite database with the connection settings the schema depends on.
 * These are connection-level, not migration-level: SQLite cannot change journal_mode inside the
 * transaction a migration runs in, and foreign_keys is a per-connection setting.
 */
export function openDatabase(filePath: string): Db {
  const inMemory = filePath === IN_MEMORY;
  if (!inMemory) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!inMemory) {
    const [row] = db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
    if (row?.journal_mode !== 'wal') {
      db.close();
      throw new Error(
        `Could not enable WAL journaling for ${filePath} (got "${row?.journal_mode ?? 'unknown'}"). ` +
          'The data directory must be on a local filesystem.',
      );
    }
  }
  return db;
}
