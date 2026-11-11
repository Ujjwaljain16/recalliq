import { startApplication } from './app/application.js';
import { loadAppEnv } from './app/env.js';
import { liveFactory } from './app/live.js';
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

  // `live` throws here, before the database is touched, when its components are missing.
  const factory =
    env.components === 'live' ? liveFactory() : scriptedFactory({ paceMs: env.scriptedPaceMs });
  const app = await startApplication({ env, factory, logger });
  logger.info(
    { port: app.port, host: env.host, mode: env.config.mode, components: env.components },
    `listening on http://${env.host}:${app.port}`,
  );
  if (env.components === 'scripted') {
    logger.warn({}, 'scripted components are active: demo responses only, no real search or model');
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
  // ConfigError and the live-components error carry messages that name variables and components, never values.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
