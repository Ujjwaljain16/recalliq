import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConversationRepository,
  initializeDatabase,
  MessageRepository,
  openDatabase,
  SqliteTurnRepository,
  UserRepository,
  type BeliefRebuilder,
  type Db,
} from '../db/index.js';
import { DefaultTurnOrchestrator, type OrchestratorDeps } from '../orchestration/index.js';
import { createAppServer, type AppServer } from '../server/app.js';
import type { Clock, Logger } from '../shared/infrastructure.js';
import { SystemClock } from '../temporal/clock.js';
import { DefaultTemporalResolver } from '../temporal/resolver.js';
import { SCRIPTED_BANNER, type ComponentFactory, type Components } from './components.js';
import { SqliteConversationView } from './conversation-view.js';
import type { AppEnv } from './env.js';
import { silentLogger } from './logger.js';

/**
 * INTEGRATION POINT: belief recomputation after a privacy deletion.
 *
 * Deleting a conversation must rebuild the beliefs of the keys whose evidence it supplied (contracts 1.1,
 * step 7). The belief resolver does not exist yet, and with it no belief rows are ever written, so there is
 * nothing to rebuild. Replace this with the real resolver when it lands; until then a deletion that touched
 * belief keys would leave derived data stale, which cannot happen while no beliefs exist.
 */
const NO_BELIEFS_YET: BeliefRebuilder = {
  rebuild() {
    /* no beliefs are written yet, so there is nothing to recompute */
  },
};

export interface ApplicationOptions {
  env: AppEnv;
  factory: ComponentFactory;
  clock?: Clock;
  logger?: Logger;
  /** Overrides the listening port (tests pass 0 for an ephemeral one). */
  port?: number;
  webRoot?: string;
  heartbeatMs?: number;
  orchestrator?: Partial<Pick<OrchestratorDeps, 'budgetConfig'>>;
  /** Lets a test wrap the composed components (for example to hold a turn open). */
  decorate?: (components: Components) => Components;
}

export interface Application {
  readonly port: number;
  readonly db: Db;
  readonly components: Components;
  readonly turns: SqliteTurnRepository;
  /**
   * Graceful shutdown: aborts the shutdown signal, stops accepting connections, gives running turns up to
   * the grace period to persist, then closes the database. Safe to call more than once.
   */
  stop(): Promise<{ drained: boolean }>;
}

const DEFAULT_WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/**
 * The composition root's work, separate from process concerns (signals, exit codes) so tests can start and
 * stop a real application: open and migrate the database for APP_MODE, recover interrupted turns, build the
 * components and the orchestrator, listen.
 */
export async function startApplication(options: ApplicationOptions): Promise<Application> {
  const { env } = options;
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? silentLogger;

  const db = openDatabase(env.config.dbPath);
  let server: AppServer | undefined;
  const shutdown = new AbortController();
  try {
    initializeDatabase(db, { mode: env.config.mode, clock });
    const users = new UserRepository(db, clock);
    const conversations = new ConversationRepository(db, clock);
    const messages = new MessageRepository(db, clock);
    const turns = new SqliteTurnRepository(db, clock, { beliefs: NO_BELIEFS_YET });

    // A turn left running by a crash or restart can never finish; mark it so its conversation is not blocked.
    const recovered = turns.recoverRunning(clock.now());
    if (recovered > 0)
      logger.warn({ recovered }, 'marked running turns from a previous run as interrupted');

    const built = options.factory({ db, clock, logger, config: env.config });
    const components = options.decorate ? options.decorate(built) : built;
    const orchestrator = new DefaultTurnOrchestrator({
      turns,
      analyzer: components.analyzer,
      research: components.research,
      answer: components.answer,
      memory: components.memory,
      resolver: new DefaultTemporalResolver(),
      baselines: components.baselines,
      window: components.window,
      clock,
      logger,
      shutdown: shutdown.signal,
      ...options.orchestrator,
    });

    server = createAppServer({
      users,
      conversations,
      turns,
      view: new SqliteConversationView(db, conversations, messages),
      orchestrator,
      clock,
      logger,
      sessionSecret: env.sessionSecret,
      allowedOrigin: env.config.allowedOrigin,
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      info: {
        mode: env.config.mode,
        components: components.kind,
        banner: components.kind === 'scripted' ? SCRIPTED_BANNER : null,
      },
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    });
    const port = await server.listen(options.port ?? env.config.port, env.host);

    let stopping: Promise<{ drained: boolean }> | undefined;
    const running = server;
    return {
      port,
      db,
      components,
      turns,
      stop() {
        stopping ??= (async () => {
          shutdown.abort();
          const drained = await running.stop(env.shutdownGraceMs);
          if (!drained) logger.warn({}, 'shutdown grace period ended with turns still running');
          db.close();
          return { drained };
        })();
        return stopping;
      },
    };
  } catch (error) {
    shutdown.abort();
    if (server?.server.listening) await server.stop(0);
    if (db.open) db.close();
    throw error;
  }
}
