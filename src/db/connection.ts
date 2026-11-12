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
  // A new data directory is private to the owner (POSIX; ignored on Windows). An existing one is left alone.
  if (!inMemory) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const db = new Database(filePath);
  if (!inMemory) restrictToOwner(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Deleted rows (privacy deletion) are overwritten with zeros rather than left in free pages.
  db.pragma('secure_delete = ON');
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

/**
 * Makes the database file readable and writable by its owner only (0600). SQLite gives the -wal and -shm files
 * the permissions of the database file. POSIX only: Windows has no such mode bits, and its ACLs are left as
 * the user profile sets them.
 */
export function restrictToOwner(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  fs.chmodSync(filePath, 0o600);
}
