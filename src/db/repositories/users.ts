import { z } from 'zod';
import type { Clock } from '../../shared/infrastructure.js';
import { newId, type UserId } from '../../shared/ids.js';
import type { Db } from '../connection.js';
import { queryOne } from '../sql.js';

export type UserKind = 'real' | 'fixture';

export class UserRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Fixture users are rejected by a trigger when the database is in `real` mode, so passing
   * `fixture` here against a real database fails at the database, not just by convention.
   */
  create(kind: UserKind = 'real'): UserId {
    const id = newId('usr');
    this.db
      .prepare('INSERT INTO users (id, kind, created_at) VALUES (?, ?, ?)')
      .run(id, kind, this.clock.now());
    return id;
  }

  exists(userId: UserId): boolean {
    return (
      queryOne(
        this.db,
        'SELECT 1 AS one FROM users WHERE id = ?',
        z.object({ one: z.literal(1) }),
        [userId],
      ) !== null
    );
  }
}
