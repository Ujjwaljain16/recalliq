import { z } from 'zod';
import type { Db } from '../db/index.js';
import { SqliteMessageMemory } from '../db/repositories/memory-retriever.js';
import { queryAll } from '../db/sql.js';
import { parseId, type UserId } from '../shared/ids.js';
import type { DecisionRecord, MemoryRetriever, ResolvedContext } from '../shared/memory.js';
import type { DayInterval } from '../shared/temporal.js';
import type { DecisionPayload } from '../shared/understanding.js';

const MAX_DECISIONS = 50;
const MAX_ALIASES = 16;
const MAX_INTERVALS = 16;

const decisionRow = z.object({
  id: z.string(),
  message_id: z.string(),
  kind: z.enum(['shortlist', 'constraint', 'preference', 'choice']),
  payload_json: z.string(),
  version: z.number().int(),
  created_at: z.number(),
});
const linkRow = z.object({ decision_id: z.string(), entity_id: z.string() });
const entityRow = z.object({ id: z.string(), canonical: z.string() });
const aliasRow = z.object({ entity_id: z.string(), alias_norm: z.string() });
const planRow = z.object({ entity_id: z.string(), plan_norm: z.string() });
const domainRow = z.object({ entity_id: z.string(), domain: z.string() });

const payloadSchema = z.object({
  kind: z.enum(['shortlist', 'constraint', 'preference', 'choice']),
  entities: z.array(z.string()).optional(),
  label: z.string().optional(),
  constraint: z
    .object({
      key: z.string(),
      value: z.union([z.string(), z.number()]),
      unit: z.string().optional(),
    })
    .optional(),
});

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * The full MemoryRetriever: the message reads come from SqliteMessageMemory (src/db), and the two reads no
 * one else implements, `decisions` and `entitiesByAlias`, are small parameterised queries here. Every query
 * is filtered by `user_id` on the table it reads, and every joined table is reached through a row of that
 * user, so another user's decisions or entities can never come back.
 */
export class SqliteMemoryRetriever implements MemoryRetriever {
  private readonly messages: SqliteMessageMemory;

  constructor(private readonly db: Db) {
    this.messages = new SqliteMessageMemory(db);
  }

  messagesInIntervals: MemoryRetriever['messagesInIntervals'] = (u, iv, terms) =>
    this.messages.messagesInIntervals(u, iv, terms);

  searchAll: MemoryRetriever['searchAll'] = (u, terms, limit) =>
    this.messages.searchAll(u, terms, limit);

  topicalRecall: MemoryRetriever['topicalRecall'] = (u, terms, opts) =>
    this.messages.topicalRecall(u, terms, opts);

  conversationOverview: MemoryRetriever['conversationOverview'] = (...a) =>
    this.messages.conversationOverview(...a);

  /**
   * The user's current decisions: a decision that a later one supersedes is left out. Optionally only one
   * kind, and only those recorded inside the given half-open day intervals. Newest first, at most 50.
   */
  decisions(
    u: UserId,
    kind: DecisionPayload['kind'] | null,
    iv: DayInterval[] | null,
  ): DecisionRecord[] {
    const where = [
      'd.user_id = ?',
      'NOT EXISTS (SELECT 1 FROM decisions s WHERE s.supersedes_id = d.id AND s.user_id = d.user_id)',
    ];
    const params: Array<string | number> = [u];
    if (kind !== null) {
      where.push('d.kind = ?');
      params.push(kind);
    }
    if (iv !== null) {
      const intervals = iv.slice(0, MAX_INTERVALS);
      if (intervals.length === 0) return [];
      where.push(
        `(${intervals.map(() => '(d.created_at >= ? AND d.created_at < ?)').join(' OR ')})`,
      );
      for (const i of intervals) params.push(i.startMs, i.endMs);
    }
    const rows = queryAll(
      this.db,
      `SELECT d.id, d.message_id, d.kind, d.payload_json, d.version, d.created_at
         FROM decisions d WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC, d.id LIMIT ${MAX_DECISIONS}`,
      decisionRow,
      params,
    );
    if (rows.length === 0) return [];
    const links = queryAll(
      this.db,
      `SELECT de.decision_id, de.entity_id FROM decision_entities de
         JOIN decisions d ON d.id = de.decision_id
        WHERE d.user_id = ? AND de.decision_id IN (${placeholders(rows.length)})
        ORDER BY de.entity_id`,
      linkRow,
      [u, ...rows.map((r) => r.id)],
    );
    return rows.map((row) => {
      const parsed = payloadSchema.safeParse(JSON.parse(row.payload_json));
      const payload: DecisionPayload = parsed.success ? parsed.data : { kind: row.kind };
      return {
        id: parseId('dec', row.id),
        payload,
        entityIds: links
          .filter((l) => l.decision_id === row.id)
          .map((l) => parseId('ent', l.entity_id)),
        createdAt: row.created_at,
        messageId: parseId('msg', row.message_id),
        version: row.version,
      };
    });
  }

  /**
   * The user's stored entities whose normalised name or alias equals one of `normalized`, with their aliases,
   * known plan names and official domains.
   */
  entitiesByAlias(u: UserId, normalized: string[]): ResolvedContext['entities'] {
    const wanted = [...new Set(normalized.map((n) => n.trim()).filter((n) => n.length > 0))].slice(
      0,
      MAX_ALIASES,
    );
    if (wanted.length === 0) return [];
    const marks = placeholders(wanted.length);
    const entities = queryAll(
      this.db,
      `SELECT e.id, e.canonical FROM entities e
        WHERE e.user_id = ?
          AND (e.norm IN (${marks})
               OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id = e.id AND a.alias_norm IN (${marks})))
        ORDER BY e.canonical, e.id`,
      entityRow,
      [u, ...wanted, ...wanted],
    );
    if (entities.length === 0) return [];
    const ids = entities.map((e) => e.id);
    const inIds = `IN (${placeholders(ids.length)})`;
    const aliases = queryAll(
      this.db,
      `SELECT a.entity_id, a.alias_norm FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
        WHERE e.user_id = ? AND a.entity_id ${inIds} ORDER BY a.alias_norm`,
      aliasRow,
      [u, ...ids],
    );
    const plans = queryAll(
      this.db,
      `SELECT p.entity_id, p.plan_norm FROM entity_plans p JOIN entities e ON e.id = p.entity_id
        WHERE e.user_id = ? AND p.entity_id ${inIds} ORDER BY p.plan_norm`,
      planRow,
      [u, ...ids],
    );
    const domains = queryAll(
      this.db,
      `SELECT d.entity_id, d.domain FROM entity_domains d JOIN entities e ON e.id = d.entity_id
        WHERE e.user_id = ? AND d.entity_id ${inIds} ORDER BY d.domain`,
      domainRow,
      [u, ...ids],
    );
    return entities.map((e) => ({
      id: parseId('ent', e.id),
      name: e.canonical,
      aliases: aliases.filter((a) => a.entity_id === e.id).map((a) => a.alias_norm),
      plans: plans.filter((p) => p.entity_id === e.id).map((p) => p.plan_norm),
      officialDomains: domains.filter((d) => d.entity_id === e.id).map((d) => d.domain),
    }));
  }
}
