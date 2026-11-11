export { IN_MEMORY, openDatabase, type Db } from './connection.js';
export { DbModeMismatchError, MigrationError, NotFoundError } from './errors.js';
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
export { ConversationRepository, type Conversation } from './repositories/conversations.js';
export { MessageRepository, type NewMessage, type StoredMessage } from './repositories/messages.js';
export { UserRepository, type UserKind } from './repositories/users.js';
