import { z } from 'zod';
import { parseId, type Ms, type UserId } from '../../shared/ids.js';
import type { MemoryCandidate, MemoryRetriever } from '../../shared/memory.js';
import type { DayInterval } from '../../shared/temporal.js';
import type { Db } from '../connection.js';
import { queryAll } from '../sql.js';

/** The message-memory half of MemoryRetriever; decisions and entities are a separate concern. */
export type MessageMemory = Pick<MemoryRetriever, 'messagesInIntervals' | 'searchAll'>;

export const MAX_CANDIDATES = 8;
export const MAX_EXCERPT_CHARS = 300;
const MAX_INTERVALS = 16;
const MAX_TERMS = 16;
const MAX_TOKENS = 24;
const MAX_TOKEN_CHARS = 64;

const intervalSchema = z
  .object({
    startMs: z.number().int().safe(),
    endMs: z.number().int().safe(),
    localDate: z.string().min(1),
    tz: z.string().min(1),
  })
  .refine((iv) => iv.startMs < iv.endMs, 'interval must be non-empty and half-open');
const intervalsSchema = z.array(intervalSchema).max(MAX_INTERVALS);
const termsSchema = z.array(z.string()).max(MAX_TERMS);

const candidateRow = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  turn_id: z.string().nullable(),
  created_at: z.number(),
  tz: z.string(),
  content: z.string(),
  body: z.string().nullable(),
  tags: z.string().nullable(),
  rank: z.number().nullable(),
});

/**
 * Turns untrusted topic terms into safe FTS5 tokens. Only letters and digits survive (the same
 * characters the unicode61 tokenizer indexes), so no FTS5 operator, column filter, prefix star,
 * quote or parenthesis can reach MATCH. Duplicates are removed; the result is bounded.
 */
export function sanitizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const term of termsSchema.parse([...terms])) {
    for (const token of term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (token.length <= MAX_TOKEN_CHARS) seen.add(token);
      if (seen.size >= MAX_TOKENS) return [...seen];
    }
  }
  return [...seen];
}

/** Every token is a double-quoted phrase of letters and digits, OR-ed together. */
function toMatchExpression(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

function formatLocal(ms: Ms, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function excerptOf(content: string): string {
  const chars = Array.from(content.replace(/\s+/g, ' ').trim());
  if (chars.length <= MAX_EXCERPT_CHARS) return chars.join('');
  return chars.slice(0, MAX_EXCERPT_CHARS - 1).join('') + '…';
}

/** Approximate: FTS stems words (porter), so a token counts as matched on a shared stem-like prefix. */
function matchedTokens(tokens: readonly string[], text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((t) =>
    words.some((w) => {
      if (w === t) return true;
      const n = Math.min(w.length, t.length);
      return n >= 4 && w.slice(0, n) === t.slice(0, n) && Math.abs(w.length - t.length) <= 4;
    }),
  );
}

/**
 * SQLite implementation of the message-recall reads (architecture section 7, "plausible"). Every
 * query is parameterised and filtered by user_id on both messages and message_search. Only user-role
 * messages are candidates: recall is about what the user asked. Rows are not filtered by origin here;
 * a real database cannot hold non-live messages (migration 002), a fixture database may.
 */
export class SqliteMessageMemory implements MessageMemory {
  constructor(private readonly db: Db) {}

  /**
   * With topic terms: user messages inside the intervals whose indexed text matches (bm25 order, then
   * createdAt, then id). Without usable terms: every user message inside the intervals, oldest first.
   * Intervals are half-open [startMs, endMs). At most MAX_CANDIDATES.
   */
  messagesInIntervals(u: UserId, iv: DayInterval[], terms: string[]): MemoryCandidate[] {
    const intervals = intervalsSchema.parse(iv);
    if (intervals.length === 0) return [];
    const tokens = sanitizeTerms(terms);

    const range = intervals.map(() => '(m.created_at >= ? AND m.created_at < ?)').join(' OR ');
    const rangeParams = intervals.flatMap((i) => [i.startMs, i.endMs]);

    const rows =
      tokens.length === 0
        ? queryAll(
            this.db,
            `SELECT m.id AS message_id, m.conversation_id, m.turn_id, m.created_at, m.tz, m.content,
                    NULL AS body, NULL AS tags, NULL AS rank
               FROM messages m
              WHERE m.user_id = ? AND m.role = 'user' AND (${range})
              ORDER BY m.created_at ASC, m.id ASC
              LIMIT ${MAX_CANDIDATES}`,
            candidateRow,
            [u, ...rangeParams],
          )
        : queryAll(
            this.db,
            `SELECT m.id AS message_id, m.conversation_id, m.turn_id, m.created_at, m.tz, m.content,
                    ms.body AS body, ms.tags AS tags, bm25(message_fts) AS rank
               FROM message_fts
               JOIN message_search ms ON ms.rowid = message_fts.rowid
               JOIN messages m ON m.id = ms.message_id
              WHERE message_fts MATCH ?
                AND ms.user_id = ? AND m.user_id = ? AND m.role = 'user' AND (${range})
              ORDER BY rank ASC, m.created_at ASC, m.id ASC
              LIMIT ${MAX_CANDIDATES}`,
            candidateRow,
            [toMatchExpression(tokens), u, u, ...rangeParams],
          );

    return rows.map((row) => {
      const intervalIndex = intervals.findIndex(
        (i) => row.created_at >= i.startMs && row.created_at < i.endMs,
      );
      const interval = intervals[intervalIndex];
      return this.toCandidate(row, tokens, interval?.tz ?? row.tz, intervalIndex);
    });
  }

  /**
   * FTS-only search over all of the user's user-role messages. `intervalIndex` is -1 (no interval),
   * `localTime` is in the message's own recorded tz. Empty or unusable terms yield [].
   */
  searchAll(u: UserId, terms: string[], limit: number): MemoryCandidate[] {
    const n = z.number().int().min(0).parse(limit);
    const tokens = sanitizeTerms(terms);
    if (tokens.length === 0 || n === 0) return [];
    const cap = Math.min(n, MAX_CANDIDATES);
    const rows = queryAll(
      this.db,
      `SELECT m.id AS message_id, m.conversation_id, m.turn_id, m.created_at, m.tz, m.content,
              ms.body AS body, ms.tags AS tags, bm25(message_fts) AS rank
         FROM message_fts
         JOIN message_search ms ON ms.rowid = message_fts.rowid
         JOIN messages m ON m.id = ms.message_id
        WHERE message_fts MATCH ?
          AND ms.user_id = ? AND m.user_id = ? AND m.role = 'user'
        ORDER BY rank ASC, m.created_at ASC, m.id ASC
        LIMIT ${cap}`,
      candidateRow,
      [toMatchExpression(tokens), u, u],
    );
    return rows.map((row) => this.toCandidate(row, tokens, row.tz, -1));
  }

  private toCandidate(
    row: z.output<typeof candidateRow>,
    tokens: readonly string[],
    tz: string,
    intervalIndex: number,
  ): MemoryCandidate {
    return {
      conversationId: parseId('cnv', row.conversation_id),
      messageId: parseId('msg', row.message_id),
      turnId: row.turn_id === null ? null : parseId('trn', row.turn_id),
      createdAt: row.created_at,
      localTime: formatLocal(row.created_at, tz),
      excerpt: excerptOf(row.content),
      matchedTerms:
        row.rank === null ? [] : matchedTokens(tokens, `${row.body ?? ''} ${row.tags ?? ''}`),
      // bm25() is lower-is-better and negative; expose higher-is-better. Listing has no relevance.
      score: row.rank === null ? 0 : -row.rank,
      intervalIndex,
    };
  }
}
