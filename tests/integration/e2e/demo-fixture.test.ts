import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startApplication } from '../../../src/app/application.js';
import { loadAppEnv } from '../../../src/app/env.js';
import { replayFactory } from '../../../src/app/live.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { ask, Client, TUE } from './harness.js';
import { SECRET } from '../server/harness.js';

const FIXTURE = path.resolve('tests/fixtures/e2e/demo.json');

let stop: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('the shipped replay fixture (the one `npm run dev:replay` uses)', () => {
  it('is read from REPLAY_FIXTURE and answers its recorded questions through the real pipeline', async () => {
    const base = loadAppEnv({
      APP_MODE: 'demo',
      APP_COMPONENTS: 'replay',
      SESSION_SECRET: SECRET,
      REPLAY_FIXTURE: FIXTURE,
    });
    const env = { ...base, config: { ...base.config, dbPath: ':memory:' } };
    const app = await startApplication({
      env,
      factory: replayFactory(env),
      clock: new FixedClock(TUE),
      port: 0,
    });
    stop = () => app.stop();
    const user = new Client(`http://127.0.0.1:${app.port}`);
    const conv = await user.newConversation();

    const first = await ask(user, conv, 'What does Acme CRM cost?');
    expect(first.status).toBe('complete');
    expect(first.sentences.join(' ')).toContain('US$90');
    expect(first.read.raw).toContain('[SYNTHETIC]');
    // the rows the fixture produced are labelled as fixture data in the database
    const origins = app.db.prepare('SELECT DISTINCT origin FROM source_snapshots').pluck().all();
    expect(origins).toEqual(['synthetic']);
  });
});
