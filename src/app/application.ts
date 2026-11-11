import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConversationRepository,
  initializeDatabase,
  MessageRepository,
  openDatabase,
  SqliteTurnRepository,
  UserRepository,
  type Db,
} from '../db/index.js';
import { BeliefRepository } from '../belief/repository.js';
import { DEFAULT_BELIEF_POLICY, RuleBeliefResolver } from '../belief/resolver.js';
import { DefaultTurnOrchestrator, type OrchestratorDeps } from '../orchestration/index.js';
import { createAppServer, type AppServer } from '../server/app.js';
import type { Clock, Logger } from '../shared/infrastructure.js';
import { SystemClock } from '../temporal/clock.js';
import { DefaultTemporalResolver } from '../temporal/resolver.js';
import {
  REPLAY_BANNER,
  SCRIPTED_BANNER,
  type ComponentFactory,
  type Components,
} from './components.js';
import { SqliteConversationView } from './conversation-view.js';
import type { AppEnv } from './env.js';
import { silentLogger } from './logger.js';

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
  /** The node:http server, for inspection; the application owns its lifecycle. */
  readonly server: AppServer['server'];
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
    const turns = new SqliteTurnRepository(db, clock, {
      // Privacy deletion rebuilds the beliefs of the keys it touched from the evidence that survives.
      beliefs: new BeliefRepository({
        db,
        resolver: new RuleBeliefResolver(),
        policy: DEFAULT_BELIEF_POLICY,
        clock,
      }),
    });

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
      bindHost: env.host,
      production: env.production,
      limits: env.limits,
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      info: {
        mode: env.config.mode,
        components: components.kind,
        banner:
          components.kind === 'scripted'
            ? SCRIPTED_BANNER
            : components.kind === 'replay'
              ? REPLAY_BANNER
              : null,
      },
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    });
    const port = await server.listen(options.port ?? env.config.port, env.host);

    let stopping: Promise<{ drained: boolean }> | undefined;
    const running = server;
    return {
      port,
      server: running.server,
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
