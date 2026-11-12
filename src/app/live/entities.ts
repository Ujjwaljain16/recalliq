import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { queryOne } from '../../db/sql.js';
import { newId, parseId, type Origin, type UserId } from '../../shared/ids.js';
import type { Clock } from '../../shared/infrastructure.js';
import type { ResolvedContext } from '../../shared/memory.js';
import type { EntityMention } from '../../shared/understanding.js';

export type EntityRow = ResolvedContext['entities'][number];

const idRow = z.object({ id: z.string() });

/** The user's entities: find or create the row for a mention, and the domains it lists are only those the row already carries from an explicit earlier source.
 * Nothing here ever promotes a domain to official: not a model's guess, not a name that matches a domain. */
export class EntityDirectory {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly origin: Origin,
  ) {}

  ensure(userId: UserId, mention: EntityMention): EntityRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entities (id, user_id, canonical, norm, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId('ent'), userId, mention.text, mention.normalized, this.origin, this.clock.now());
    const row = queryOne(this.db, 'SELECT id FROM entities WHERE user_id = ? AND norm = ?', idRow, [
      userId,
      mention.normalized,
    ]);
    if (!row) throw new Error('entity vanished after insert');
    const id = parseId('ent', row.id);
    const entity: EntityRow = {
      id,
      name: mention.text,
      aliases: this.db
        .prepare('SELECT alias_norm FROM entity_aliases WHERE entity_id = ? ORDER BY alias_norm')
        .pluck()
        .all(id) as string[],
      plans: this.db
        .prepare('SELECT plan_norm FROM entity_plans WHERE entity_id = ? ORDER BY plan_norm')
        .pluck()
        .all(id) as string[],
      officialDomains: this.db
        .prepare('SELECT domain FROM entity_domains WHERE entity_id = ? ORDER BY domain')
        .pluck()
        .all(id) as string[],
    };
    const alias = mention.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (alias !== mention.normalized) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO entity_aliases (entity_id, alias_norm, source) VALUES (?, ?, 'analysis')`,
        )
        .run(id, alias);
      if (!entity.aliases.includes(alias)) entity.aliases.push(alias);
    }
    return entity;
  }
}
