import { z } from 'zod';
import {
  newId,
  type ConversationId,
  type MessageId,
  type Ms,
  type UserId,
} from '../../shared/ids.js';
import type { DecisionPayload, EntityMention, UserFact } from '../../shared/understanding.js';
import type { Db } from '../connection.js';
import { InvalidCompletionError } from '../errors.js';
import { queryOne } from '../sql.js';

/**
 * Write-time enrichment (architecture section 7): what a committed turn adds to memory. It is LLM output, so
 * it is untrusted and validated here, strictly, before anything is written. The contract's enrichment type
 * supports exactly three things, and this file persists exactly those:
 *
 *   tags       -> `message_search.tags` of the turn's user message and assistant message
 *   entities   -> their normalised names, appended to the same tags (the privacy-deletion garbage collector
 *                 reads an entity's norm as a whole space-delimited run of `tags`); no entity rows are created
 *   decisions  -> `decisions` rows, each with a verified verbatim quote of the user message, plus
 *                 `decision_entities` links to entities the user already has
 *
 * Both messages of the turn are always indexed in `message_search` (body = the stored message content), even
 * when the enrichment is empty, so that memory retrieval finds every committed message.
 */

const MAX_TAGS = 50;
const MAX_ENTITIES = 20;
const MAX_DECISIONS = 20;
const MAX_TAG_LENGTH = 80;
const MAX_QUOTE_LENGTH = 2000;

/** Lower-case, whitespace collapsed: the form tags and entity norms are stored and compared in. */
export function normalizeTerm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const term = z
  .string()
  .max(MAX_TAG_LENGTH)
  .transform(normalizeTerm)
  // eslint-disable-next-line no-control-regex
  .refine((s) => s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s), 'term must be printable text');

const decisionKind = z.enum(['shortlist', 'constraint', 'preference', 'choice']);

const decisionPayloadSchema = z.strictObject({
  kind: decisionKind,
  entities: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_ENTITIES).optional(),
  label: z.string().min(1).max(MAX_QUOTE_LENGTH).optional(),
  constraint: z
    .strictObject({
      key: z.string().min(1).max(MAX_TAG_LENGTH),
      value: z.union([z.string().max(MAX_TAG_LENGTH), z.number().finite()]),
      unit: z.string().max(MAX_TAG_LENGTH).optional(),
    })
    .optional(),
}) satisfies z.ZodType<DecisionPayload>;

const userFactSchema = z
  .strictObject({
    kind: z.enum(['shortlist', 'constraint', 'preference', 'choice', 'correction']),
    quote: z.string().min(1).max(MAX_QUOTE_LENGTH),
    data: decisionPayloadSchema,
    correctsDecisionKind: decisionKind.optional(),
  })
  .superRefine((fact, ctx) => {
    if (fact.kind === 'correction') {
      if (fact.correctsDecisionKind === undefined) {
        ctx.addIssue({ code: 'custom', message: 'a correction must name correctsDecisionKind' });
      } else if (fact.data.kind !== fact.correctsDecisionKind) {
        ctx.addIssue({
          code: 'custom',
          message: 'a correction data.kind must be the kind it corrects',
        });
      }
    } else {
      if (fact.correctsDecisionKind !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'only a correction may set correctsDecisionKind',
        });
      }
      if (fact.data.kind !== fact.kind) {
        ctx.addIssue({ code: 'custom', message: 'data.kind must equal kind' });
      }
    }
  }) satisfies z.ZodType<UserFact>;

const entityMentionSchema = z.strictObject({
  text: z.string().min(1).max(MAX_TAG_LENGTH),
  normalized: term,
  officialDomainGuess: z.string().min(1).max(253).optional(),
}) satisfies z.ZodType<EntityMention>;

const enrichmentSchema = z.strictObject({
  tags: z.array(term).max(MAX_TAGS),
  entities: z.array(entityMentionSchema).max(MAX_ENTITIES),
  decisions: z.array(userFactSchema).max(MAX_DECISIONS),
});

export interface ValidEnrichment {
  /** Normalised, de-duplicated tags followed by the entities' normalised names. */
  tags: string[];
  decisions: Array<z.output<typeof userFactSchema>>;
}

/** Validates untrusted enrichment. Throws InvalidCompletionError (never ZodError) so callers reject the turn. */
export function parseEnrichment(enrichment: unknown): ValidEnrichment {
  const parsed = enrichmentSchema.safeParse(enrichment);
  if (!parsed.success) {
    throw new InvalidCompletionError(`invalid enrichment: ${parsed.error.message}`);
  }
  const tags = [
    ...new Set([...parsed.data.tags, ...parsed.data.entities.map((e) => e.normalized)]),
  ];
  return { tags, decisions: parsed.data.decisions };
}

const messageRow = z.object({
  id: z.string(),
  content: z.string(),
  origin: z.enum(['live', 'recorded', 'synthetic']),
});
const previousRow = z.object({ id: z.string(), version: z.number().int() });
const entityRow = z.object({ id: z.string() });

export interface EnrichmentTarget {
  userId: UserId;
  conversationId: ConversationId;
  userMessageId: MessageId;
  assistantMessageId: MessageId | null;
  now: Ms;
}

/**
 * Persists validated enrichment. Must run inside the transaction that completes the turn: any throw rolls the
 * whole completion back.
 */
export function writeEnrichment(
  db: Db,
  target: EnrichmentTarget,
  enrichment: ValidEnrichment,
): void {
  const tags = enrichment.tags.join(' ');

  // message_search takes its user and time from the message row itself, restricted to this user, so a
  // search row can never disagree with its message. The FTS table follows through the message_search triggers.
  const index = db.prepare(
    `INSERT INTO message_search (message_id, user_id, created_at, body, tags)
     SELECT id, user_id, created_at, content, ? FROM messages WHERE id = ? AND user_id = ?`,
  );
  for (const messageId of [target.userMessageId, target.assistantMessageId]) {
    if (messageId === null) continue;
    if (index.run(tags, messageId, target.userId).changes !== 1) {
      throw new InvalidCompletionError(`message ${messageId} cannot be indexed for this user`);
    }
  }

  if (enrichment.decisions.length === 0) return;

  const user = queryOne(
    db,
    'SELECT id, content, origin FROM messages WHERE id = ? AND user_id = ?',
    messageRow,
    [target.userMessageId, target.userId],
  );
  if (!user) throw new InvalidCompletionError('the turn user message was not found');

  const findActive = db.prepare(
    `SELECT d.id, d.version FROM decisions d
     WHERE d.user_id = ? AND d.kind = ?
       AND NOT EXISTS (SELECT 1 FROM decisions s WHERE s.supersedes_id = d.id)
     ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  );
  const insertDecision = db.prepare(
    `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote,
       version, supersedes_id, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findEntity = db.prepare('SELECT id FROM entities WHERE user_id = ? AND norm = ?');
  const linkEntity = db.prepare(
    'INSERT OR IGNORE INTO decision_entities (decision_id, entity_id) VALUES (?, ?)',
  );

  for (const fact of enrichment.decisions) {
    // Decisions come only from what the user said: the quote must be a verbatim substring of their message.
    if (!user.content.includes(fact.quote)) {
      throw new InvalidCompletionError(
        `decision quote is not a verbatim substring of the user message: "${fact.quote.slice(0, 60)}"`,
      );
    }
    const kind = fact.data.kind;
    let version = 1;
    let supersedesId: string | null = null;
    if (fact.kind === 'correction') {
      const previous = previousRow.safeParse(findActive.get(target.userId, kind));
      if (previous.success) {
        supersedesId = previous.data.id;
        version = previous.data.version + 1;
      }
    }
    const id = newId('dec');
    insertDecision.run(
      id,
      target.userId,
      target.conversationId,
      target.userMessageId,
      kind,
      JSON.stringify(fact.data),
      fact.quote,
      version,
      supersedesId,
      user.origin,
      target.now,
    );
    for (const name of fact.data.entities ?? []) {
      const entity = entityRow.safeParse(findEntity.get(target.userId, normalizeTerm(name)));
      if (entity.success) linkEntity.run(id, entity.data.id);
    }
  }
}
