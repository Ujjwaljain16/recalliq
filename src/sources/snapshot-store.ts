import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { queryAll } from '../db/sql.js';
import type { SourceSnapshot } from '../shared/evidence.js';
import {
  newId,
  parseId,
  type Ms,
  type Origin,
  type SnapshotId,
  type UserId,
} from '../shared/ids.js';
import type { SnapshotReader } from '../shared/pipeline.js';
import type { SearchHit } from '../shared/search.js';
import { InvalidUrlError, normalizeUrl } from './url.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const rowSchema = z.object({
  id: z.string(),
  url: z.string(),
  url_norm: z.string(),
  domain: z.string(),
  title: z.string().nullable(),
  content_text: z.string(),
  content_mode: z.enum(['text', 'highlights']),
  content_sha256: z.string(),
  provider: z.string(),
  provider_published_at: z.number().nullable(),
  provider_last_updated_at: z.number().nullable(),
  observed_at: z.number(),
  fresh_fetch: z.number(),
  crawl_status: z.enum(['ok', 'failed', 'unknown']),
  origin: z.enum(['live', 'recorded', 'synthetic']),
});

const idRow = z.object({ id: z.string() });

export interface SnapshotInput {
  userId: UserId;
  hit: SearchHit;
  contentMode: 'text' | 'highlights';
  provider: string;
  observedAt: Ms;
  origin: Origin;
}

/**
 * Persists and reads `source_snapshots`. Snapshots are immutable (migration 001). Text is stored exactly as
 * received; its hash is over that exact text.
 */
export class SnapshotStore implements SnapshotReader {
  constructor(private readonly db: Db) {}

  /**
   * Stores a snapshot, or returns the existing one for the same (user, url_norm, content hash, observed_at).
   * Returns null when the hit's URL cannot be normalised (such a hit is not a usable source).
   * Database errors, including ownership and isolation triggers, propagate.
   */
  insert(input: SnapshotInput): SnapshotId | null {
    let n;
    try {
      n = normalizeUrl(input.hit.url);
    } catch (e) {
      if (e instanceof InvalidUrlError) return null;
      throw e;
    }
    const sha = sha256Hex(input.hit.text);
    const id = newId('src');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO source_snapshots (id, user_id, url, url_norm, domain, title, content_text,
           content_mode, content_sha256, provider, provider_published_at, provider_last_updated_at,
           observed_at, fresh_fetch, crawl_status, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        n.url,
        n.urlNorm,
        n.domain,
        input.hit.title,
        input.hit.text,
        input.contentMode,
        sha,
        input.provider,
        input.hit.publishedAt,
        input.hit.lastUpdatedAt,
        input.observedAt,
        input.hit.freshFetch ? 1 : 0,
        input.hit.crawlStatus,
        input.origin,
      );
    const row = queryAll(
      this.db,
      `SELECT id FROM source_snapshots
       WHERE user_id = ? AND url_norm = ? AND content_sha256 = ? AND observed_at = ?`,
      idRow,
      [input.userId, n.urlNorm, sha, input.observedAt],
    )[0];
    if (!row) throw new Error('Snapshot insert did not produce a row');
    return parseId('src', row.id);
  }

  /** User-scoped. Unknown ids and other users' ids are omitted. Order follows `ids`; duplicates collapse. */
  getMany(userId: UserId, ids: SnapshotId[]): SourceSnapshot[] {
    const unique = [...new Set(ids)];
    const found = new Map<string, SourceSnapshot>();
    // Chunked to stay below SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = queryAll(
        this.db,
        `SELECT id, url, url_norm, domain, title, content_text, content_mode, content_sha256, provider,
           provider_published_at, provider_last_updated_at, observed_at, fresh_fetch, crawl_status, origin
         FROM source_snapshots WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
        rowSchema,
        [userId, ...chunk],
      );
      for (const r of rows) {
        found.set(r.id, {
          id: parseId('src', r.id),
          url: r.url,
          urlNorm: r.url_norm,
          domain: r.domain,
          title: r.title,
          text: r.content_text,
          contentMode: r.content_mode,
          sha256: r.content_sha256,
          provider: r.provider,
          providerPublishedAt: r.provider_published_at,
          providerLastUpdatedAt: r.provider_last_updated_at,
          observedAt: r.observed_at,
          freshFetch: r.fresh_fetch === 1,
          crawlStatus: r.crawl_status,
          origin: r.origin,
        });
      }
    }
    return unique.flatMap((id) => {
      const s = found.get(id);
      return s ? [s] : [];
    });
  }
}
