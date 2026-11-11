export { IN_MEMORY, openDatabase, type Db } from './connection.js';
export {
  DbModeMismatchError,
  IdempotencyConflictError,
  InvalidAckError,
  InvalidCompletionError,
  InvalidTransitionError,
  MigrationError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
} from './errors.js';
export {
  assertDbMode,
  getMeta,
  initializeDatabase,
  loadMigrations,
  type InitializeOptions,
  type InitializeResult,
  type Migration,
} from './migrate.js';
export {
  deleteConversation,
  type BeliefRebuilder,
  type DeletionResult,
} from './privacy-deletion.js';
export {
  AssertionRepository,
  type StoredAssertion,
  type StoredAssertionEvent,
} from './repositories/assertions.js';
export { ConversationRepository, type Conversation } from './repositories/conversations.js';
export { MessageRepository, type NewMessage, type StoredMessage } from './repositories/messages.js';
export { validateCompletion } from './repositories/turn-completion.js';
export {
  SqliteTurnRepository,
  type StoredTurn,
  type TurnRepositoryDeps,
} from './repositories/turns.js';
export { UserRepository, type UserKind } from './repositories/users.js';
