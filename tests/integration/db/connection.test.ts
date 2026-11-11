import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type Db } from '../../../src/db/index.js';
import { restrictToOwner } from '../../../src/db/connection.js';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-conn-'));
  dirs.push(dir);
  return path.join(dir, 'data', 'app.db');
}

describe('data at rest', () => {
  it('turns on secure_delete for file and in-memory databases', () => {
    for (const target of [tempFile(), IN_MEMORY]) {
      const db = openDatabase(target);
      dbs.push(db);
      expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'makes the database file readable by its owner only',
    () => {
      const file = tempFile();
      dbs.push(openDatabase(file));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('leaves file modes alone on Windows', () => {
    const file = tempFile();
    dbs.push(openDatabase(file));
    const before = fs.statSync(file).mode;
    restrictToOwner(file, 'win32');
    expect(fs.statSync(file).mode).toBe(before);
  });
});
