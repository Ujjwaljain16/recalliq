import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The migration must be the contract's schema, not a paraphrase of it. This compares the SQL block
 * in docs/contracts.md §1 with src/db/migrations/001_init.sql after removing what is
 * allowed to differ: comments, whitespace, and the two PRAGMA lines that moved to openDatabase().
 */
function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .split('\n')
    .filter((line) => !/^\s*PRAGMA\b/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function contractSql(): string {
  const doc = fs.readFileSync('docs/contracts.md', 'utf8');
  const start = doc.indexOf('## 1. SQL schema');
  const open = doc.indexOf('```sql', start);
  const close = doc.indexOf('```', open + 6);
  if (start < 0 || open < 0 || close < 0)
    throw new Error('could not find the SQL block in the contract');
  return doc.slice(open + 6, close);
}

describe('001_init.sql vs docs/contracts.md §1', () => {
  it('is identical apart from comments, whitespace and the moved PRAGMAs', () => {
    const migration = fs.readFileSync('src/db/migrations/001_init.sql', 'utf8');
    expect(normalise(migration)).toBe(normalise(contractSql()));
  });
});
