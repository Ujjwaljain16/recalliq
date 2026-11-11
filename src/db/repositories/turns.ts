import { z } from 'zod';
import type { AckRequest } from '../../shared/delivery.js';
import type { Clock } from '../../shared/infrastructure.js';
import {
  newId,
  parseId,
  type ConversationId,
  type MessageId,
  type Ms,
  type TurnId,
  type UserId,
} from '../../shared/ids.js';
import type { TurnRepository, TurnCompletion } from '../../shared/repositories.js';
import { canTransition, isFinalState } from '../../shared/turn-state-machine.js';
import type { Lane } from '../../shared/understanding.js';
import type { TurnRequest, TurnState, TurnStatus } from '../../shared/turn.js';
import type { Db } from '../connection.js';
import {
  IdempotencyConflictError,
  InvalidAckError,
  InvalidTransitionError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
} from '../errors.js';
import { deleteConversation, type BeliefRebuilder } from '../privacy-deletion.js';
import { ackRequestSchema, turnRequestSchema, turnStateSchema } from '../schemas.js';
import { queryAll, queryOne } from '../sql.js';
import { completeTurn } from './turn-completion.js';
import { MessageRepository } from './messages.js';

export interface StoredTurn {
  id: TurnId;
  conversationId: ConversationId;
  userId: UserId;
  userMessageId: MessageId;
  assistantMessageId: MessageId | null;
  idempotencyKey: string;
  retryOfTurnId: TurnId | null;
  lane: Lane | null;
  state: TurnState;
  status: TurnStatus;
  deadlineAt: Ms;
  startedAt: Ms;
  finishedAt: Ms | null;
  errorCode: string | null;
}

const turnStatus = z.enum(['running', 'complete', 'partial', 'clarify', 'interrupted', 'failed']);

const turnRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  user_message_id: z.string(),
  assistant_message_id: z.string().nullable(),
  idempotency_key: z.string(),
  retry_of_turn_id: z.string().nullable(),
  lane: z.enum(['chat', 'recall', 'research', 'audit', 'clarify']).nullable(),
  state: turnStateSchema,
  status: turnStatus,
  deadline_at: z.number(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
  error_code: z.string().nullable(),
});

const TURN_COLUMNS =
  'id, conversation_id, user_id, user_message_id, assistant_message_id, idempotency_key, ' +
  'retry_of_turn_id, lane, state, status, deadline_at, started_at, finished_at, error_code';

function toTurn(row: z.output<typeof turnRow>): StoredTurn {
  return {
    id: parseId('trn', row.id),
    conversationId: parseId('cnv', row.conversation_id),
    userId: parseId('usr', row.user_id),
    userMessageId: parseId('msg', row.user_message_id),
    assistantMessageId:
      row.assistant_message_id === null ? null : parseId('msg', row.assistant_message_id),
    idempotencyKey: row.idempotency_key,
    retryOfTurnId: row.retry_of_turn_id === null ? null : parseId('trn', row.retry_of_turn_id),
    lane: row.lane,
    state: row.state,
    status: row.status,
    deadlineAt: row.deadline_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
  };
}

const idRow = z.object({ id: z.string() });
const oneRow = z.object({ one: z.literal(1) });
const existingRow = z.object({
  id: z.string(),
  status: turnStatus,
  conversation_id: z.string(),
  content: z.string(),
});
const ackMessageRow = z.object({
  rendered_through: z.number().int(),
  streamed_through: z.number().int().nullable(),
});

/**
 * True when `error` is the violation of the partial unique index `turns_one_running`.
 * SQLite reports a unique-index violation by its columns, not by the index name:
 * "UNIQUE constraint failed: turns.conversation_id". The idempotency constraint reports
 * "turns.user_id, turns.idempotency_key", so the two cannot be confused.
 */
export function violatesOneRunningTurn(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    /UNIQUE constraint failed: turns\.conversation_id$/.test(error.message)
  );
}

export interface TurnRepositoryDeps {
  /** Needed by privacy deletion (contracts §1.1 step 7). */
  beliefs: BeliefRebuilder;
}

/**
 * Turn lifecycle and delivery acknowledgement. Every multi-statement operation runs in one explicit
 * BEGIN IMMEDIATE transaction, which is what makes begin() and ack() safe across connections and processes:
 * the database serialises writers, and the checks below run inside that critical section.
 *
 * The state machine is validated here for good error messages and again by migration 004 in the database.
 */
export class SqliteTurnRepository implements TurnRepository {
  private readonly messages: MessageRepository;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly deps: TurnRepositoryDeps,
  ) {
    this.messages = new MessageRepository(db, clock);
  }

  get(userId: UserId, turnId: TurnId): StoredTurn | null {
    const row = queryOne(
      this.db,
      `SELECT ${TURN_COLUMNS} FROM turns WHERE id = ? AND user_id = ?`,
      turnRow,
      [turnId, userId],
    );
    return row ? toTurn(row) : null;
  }

  /**
   * Starts a turn, or recognises a retry of one.
   *
   * - Same idempotency key for the same user: returns the existing turn (any status). If the key is reused for a
   *   different conversation or different text, throws IdempotencyConflictError instead of silently answering
   *   the wrong request.
   * - Otherwise a new turn is created, with its user message, unless the conversation already has a running turn
   *   (TurnInProgressError).
   */
  begin(
    req: TurnRequest,
    now: Ms,
    deadline: Ms,
  ): { turnId: TurnId; userMessageId: MessageId } | { existing: TurnId; status: TurnStatus } {
    const request = turnRequestSchema.parse(req);
    return this.db
      .transaction(() => {
        const existing = queryOne(
          this.db,
          `SELECT t.id, t.status, t.conversation_id, m.content
           FROM turns t JOIN messages m ON m.id = t.user_message_id
           WHERE t.user_id = ? AND t.idempotency_key = ?`,
          existingRow,
          [request.userId, request.idempotencyKey],
        );
        if (existing) {
          if (
            existing.conversation_id !== request.conversationId ||
            existing.content !== request.text
          ) {
            throw new IdempotencyConflictError(existing.id);
          }
          return { existing: parseId('trn', existing.id), status: existing.status };
        }

        const owned = queryOne(
          this.db,
          'SELECT 1 AS one FROM conversations WHERE id = ? AND user_id = ?',
          oneRow,
          [request.conversationId, request.userId],
        );
        if (!owned) throw new NotFoundError('conversation');

        if (request.retryOfTurnId) {
          const original = queryOne(
            this.db,
            'SELECT 1 AS one FROM turns WHERE id = ? AND user_id = ? AND conversation_id = ?',
            oneRow,
            [request.retryOfTurnId, request.userId, request.conversationId],
          );
          if (!original) throw new NotFoundError('turn to retry');
        }

        const running = queryOne(
          this.db,
          "SELECT id FROM turns WHERE conversation_id = ? AND user_id = ? AND status = 'running'",
          idRow,
          [request.conversationId, request.userId],
        );
        if (running) throw new TurnInProgressError(running.id);

        const turnId = newId('trn');
        const message = this.messages.insert({
          userId: request.userId,
          conversationId: request.conversationId,
          role: 'user',
          content: request.text,
          tz: request.tz,
          turnId,
        });
        try {
          this.db
            .prepare(
              `INSERT INTO turns (id, conversation_id, user_id, user_message_id, idempotency_key,
                 retry_of_turn_id, state, status, deadline_at, started_at)
               VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', 'running', ?, ?)`,
            )
            .run(
              turnId,
              request.conversationId,
              request.userId,
              message.id,
              request.idempotencyKey,
              request.retryOfTurnId ?? null,
              deadline,
              now,
            );
        } catch (error) {
          // Backstop for the explicit check above: the contract's partial unique index is the real guarantee.
          if (violatesOneRunningTurn(error)) {
            const winner = queryOne(
              this.db,
              "SELECT id FROM turns WHERE conversation_id = ? AND status = 'running'",
              idRow,
              [request.conversationId],
            );
            if (winner) throw new TurnInProgressError(winner.id);
          }
          throw error;
        }
        return { turnId, userMessageId: message.id };
      })
      .immediate();
  }

  /**
   * Moves a running turn to its next state. Final states (COMPLETED, FAILED) are reached only through
   * complete() and fail(), which also record the outcome.
   */
  setState(userId: UserId, turnId: TurnId, next: TurnState): void {
    turnStateSchema.parse(next);
    this.db
      .transaction(() => {
        const turn = this.get(userId, turnId);
        if (!turn) throw new NotFoundError('turn');
        if (turn.status !== 'running') {
          throw new InvalidTransitionError(turn.state, next, `the turn is already ${turn.status}`);
        }
        if (isFinalState(next)) {
          throw new InvalidTransitionError(
            turn.state,
            next,
            'final states are set by complete() or fail()',
          );
        }
        if (!canTransition(turn.state, next)) {
          throw new InvalidTransitionError(turn.state, next, 'not an edge of the state machine');
        }
        const result = this.db
          .prepare(
            "UPDATE turns SET state = ? WHERE id = ? AND user_id = ? AND state = ? AND status = 'running'",
          )
          .run(next, turnId, userId, turn.state);
        if (result.changes !== 1) {
          throw new InvalidTransitionError(turn.state, next, 'the turn changed concurrently');
        }
      })
      .immediate();
  }

  /** Persists the outcome of a turn in one transaction. See completeTurn(). */
  complete(userId: UserId, turnId: TurnId, completion: TurnCompletion): void {
    completeTurn(this.db, this.clock, this.messages, userId, turnId, completion);
  }

  /**
   * PERSISTING -> FAILED: persistence itself failed (architecture §4). Distinct from a turn that persisted
   * successfully with status 'failed', which complete() records as COMPLETED.
   */
  fail(userId: UserId, turnId: TurnId, errorCode: string): void {
    this.db
      .transaction(() => {
        const turn = this.get(userId, turnId);
        if (!turn) throw new NotFoundError('turn');
        if (turn.status !== 'running' || turn.state !== 'PERSISTING') {
          throw new InvalidTransitionError(
            turn.state,
            'FAILED',
            'only a running turn in PERSISTING can fail',
          );
        }
        this.db
          .prepare(
            `UPDATE turns SET state = 'FAILED', status = 'failed', error_code = ?, finished_at = ?
             WHERE id = ? AND user_id = ? AND status = 'running' AND state = 'PERSISTING'`,
          )
          .run(errorCode, this.clock.now(), turnId, userId);
      })
      .immediate();
  }

  /**
   * Browser acknowledgement that sentences up to `renderedThrough` were rendered.
   *
   * - Monotonic and idempotent: the stored extent only ever moves forward. A repeated, lower or out-of-order
   *   acknowledgement changes nothing and reports the stored extent.
   * - Distinct from streaming: an extent beyond what the server streamed is rejected (InvalidAckError), never
   *   clamped, because it cannot be true.
   * - Advancing the extent marks each newly covered assertion presented, once, with exactly one `presented`
   *   event. Sentences beyond the extent stay unpresented.
   * - A turn with no stored answer yet (still running, or recovered after a crash before persisting) has nothing
   *   to acknowledge: TurnNotFinishedError. The browser re-acknowledges after it re-renders the stored answer.
   *
   * `complete: true` claims the browser rendered everything the server streamed, so it must equal the streamed
   * extent exactly.
   */
  ack(
    userId: UserId,
    turnId: TurnId,
    req: AckRequest,
    now: Ms,
  ): { renderedThrough: number; newlyPresented: number } {
    const request = ackRequestSchema.parse(req);
    return this.db
      .transaction(() => {
        const turn = this.get(userId, turnId);
        if (!turn) throw new NotFoundError('turn');
        if (turn.assistantMessageId === null) throw new TurnNotFinishedError(turnId, turn.status);

        const message = queryOne(
          this.db,
          'SELECT rendered_through, streamed_through FROM messages WHERE id = ? AND user_id = ?',
          ackMessageRow,
          [turn.assistantMessageId, userId],
        );
        if (!message) throw new NotFoundError('message');
        const streamed = message.streamed_through ?? -1;

        if (request.renderedThrough > streamed) {
          throw new InvalidAckError(
            'beyond_streamed_extent',
            `Cannot acknowledge sentence ${request.renderedThrough}: only sentences up to ${streamed} were streamed`,
          );
        }
        if (request.complete && request.renderedThrough !== streamed) {
          throw new InvalidAckError(
            'complete_flag_mismatch',
            `complete=true requires renderedThrough to equal the streamed extent (${streamed}), got ${request.renderedThrough}`,
          );
        }
        if (request.renderedThrough <= message.rendered_through) {
          return { renderedThrough: message.rendered_through, newlyPresented: 0 };
        }

        this.db
          .prepare(
            `UPDATE messages SET rendered_through = ?, last_ack_at = ?
             WHERE id = ? AND user_id = ? AND rendered_through < ?`,
          )
          .run(
            request.renderedThrough,
            now,
            turn.assistantMessageId,
            userId,
            request.renderedThrough,
          );

        const presented = queryAll(
          this.db,
          `UPDATE assertions SET presented_at = ?
           WHERE message_id = ? AND user_id = ? AND presented_at IS NULL AND sentence_index <= ?
           RETURNING id`,
          idRow,
          [now, turn.assistantMessageId, userId, request.renderedThrough],
        );
        const insertEvent = this.db.prepare(
          `INSERT INTO assertion_events (id, assertion_id, status, reason, turn_id, at)
           VALUES (?, ?, 'presented', 'acknowledged', ?, ?)`,
        );
        for (const assertion of presented) insertEvent.run(newId('aev'), assertion.id, turnId, now);

        return { renderedThrough: request.renderedThrough, newlyPresented: presented.length };
      })
      .immediate();
  }

  /**
   * Boot-time recovery: every turn still `running` was cut short by a crash or restart and becomes
   * `interrupted`, in whatever state it had reached. Nothing else is touched: no answer exists for such a turn
   * (answers are stored only by complete()), so there is nothing to acknowledge, present or baseline.
   *
   * Intentionally not scoped to a user: it runs once at startup, before requests are served. It assumes a
   * single application process per database file.
   */
  recoverRunning(now: Ms): number {
    return this.db
      .prepare(
        `UPDATE turns SET status = 'interrupted', error_code = 'recovered_after_restart', finished_at = ?
         WHERE status = 'running'`,
      )
      .run(now).changes;
  }

  deleteConversation(userId: UserId, conversationId: ConversationId): void {
    deleteConversation(this.db, this.deps, userId, conversationId);
  }
}
