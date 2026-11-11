import { loadConfig } from '../src/config/env.js';
import { initializeDatabase, openDatabase } from '../src/db/index.js';
import { SystemClock } from '../src/temporal/clock.js';

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
try {
  const result = initializeDatabase(db, { mode: config.mode, clock: new SystemClock() });
  console.log(
    `${result.created ? 'Created' : 'Opened'} ${config.mode} database at ${config.dbPath} ` +
      `(schema version ${result.schemaVersion})`,
  );
} finally {
  db.close();
}
