import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { queryOne } from '../../db/sql.js';
import { registrableDomain } from '../../evidence/authority.js';
import { newId, parseId, type Origin, type UserId } from '../../shared/ids.js';
import type { Clock } from '../../shared/infrastructure.js';
import type { ResolvedContext } from '../../shared/memory.js';
import type { EntityMention } from '../../shared/understanding.js';

export type EntityRow = ResolvedContext['entities'][number];

const idRow = z.object({ id: z.string() });

/**
 * Whether a domain's name part is evidently the entity's name: "acme.example" for "Acme CRM". Deterministic,
 * at least three letters, and the only way a domain becomes official here: a model's guess alone never does.
 */
export function nameMatchesDomain(name: string, domain: string): boolean {
  const label = registrableDomain(domain).split('.')[0] ?? '';
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label.length < 3 || squashed.length < 3) return false;
  return squashed.startsWith(label) || label.startsWith(squashed);
}

/** The user's entities: find or create the row for a mention, and record official domains with their basis. */
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
    const guess = mention.officialDomainGuess;
    if (guess !== undefined && nameMatchesDomain(mention.text, guess)) {
      this.addDomain(entity, registrableDomain(guess), 'analysis_confirmed');
    }
    return entity;
  }

  addDomain(entity: EntityRow, domain: string, basis: 'name_match' | 'analysis_confirmed'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO entity_domains (entity_id, domain, basis) VALUES (?, ?, ?)')
      .run(entity.id, domain, basis);
    if (!entity.officialDomains.includes(domain)) entity.officialDomains.push(domain);
  }
}
