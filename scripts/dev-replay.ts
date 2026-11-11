import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs the server with the replay components: the real application with recorded fixtures standing in for the
 * search provider and the model. It starts from an empty demo database every time, because the fixture's
 * recorded searches are consumed in order and a database left over from an earlier run would not match them.
 * Anything already set in the environment wins, except that a real database is never used.
 */
const root = path.resolve(import.meta.dirname, '..');
process.env['APP_COMPONENTS'] = 'replay';
process.env['APP_MODE'] = 'demo';
process.env['REPLAY_FIXTURE'] ??= path.join(root, 'tests', 'fixtures', 'e2e', 'demo.json');
process.env['OFFICIAL_DOMAINS_FILE'] ??= path.join(
  root,
  'tests',
  'fixtures',
  'e2e',
  'official-domains.example.json',
);
process.env['DB_PATH'] ??= path.join(root, 'data', 'replay-demo.db');

const db = process.env['DB_PATH'];
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${db}${suffix}`, { force: true });
fs.mkdirSync(path.dirname(db), { recursive: true });

await import('../src/main.js');
