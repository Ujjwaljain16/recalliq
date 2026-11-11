import { startApplication } from './app/application.js';
import { loadAppEnv } from './app/env.js';
import { liveFactory, replayFactory } from './app/live.js';
import { createLogger } from './app/logger.js';
import { scriptedFactory } from './app/scripted/index.js';

/**
 * Process entry point: validate the environment, choose the component set, start, and shut down cleanly on
 * SIGINT or SIGTERM. Anything that goes wrong before the server listens prints one clear message and exits 1.
 */
async function main(): Promise<void> {
  const logger = createLogger();
  const env = loadAppEnv(process.env);
  if (env.sessionSecretEphemeral) {
    logger.warn(
      {},
      'SESSION_SECRET is not set: using a random secret for this process. Sessions will not survive a restart.',
    );
  }

  // The set is chosen once, explicitly, and fixed for the life of the process. `live` and `replay` check their
  // settings here, before the database is touched, and throw with a message naming what is missing.
  const factory =
    env.components === 'live'
      ? liveFactory(env)
      : env.components === 'replay'
        ? replayFactory(env)
        : scriptedFactory({ paceMs: env.scriptedPaceMs });
  const app = await startApplication({ env, factory, logger });
  logger.info(
    { port: app.port, host: env.host, mode: env.config.mode, components: env.components },
    `listening on http://${env.host}:${app.port}`,
  );
  if (env.components === 'scripted') {
    logger.warn({}, 'scripted components are active: demo responses only, no real search or model');
  }
  if (env.components === 'replay') {
    logger.warn(
      {},
      'replay components are active: recorded fixtures stand in for search and the model',
    );
  }

  let stopping = false;
  const onSignal = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down: finishing running turns');
    void app.stop().then(
      ({ drained }) => {
        logger.info({ drained }, 'stopped');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ error: String(error) }, 'error while stopping');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((error: unknown) => {
  // ConfigError and the live and replay configuration errors carry messages that name variables and components, never values.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
