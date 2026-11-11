import type { Db } from '../db/connection.js';
import {
  newId,
  type EntityId,
  type Ms,
  type SnapshotId,
  type TurnId,
  type UserId,
} from '../shared/ids.js';
import type { SearchErrorCode, SearchRequest } from '../shared/search.js';

export interface SearchRequestRecord {
  turnId: TurnId;
  userId: UserId;
  entityId: EntityId | null;
  intent: string;
  round: 1 | 2;
  provider: string;
  request: SearchRequest;
  status: 'ok' | 'empty' | 'failed' | 'cached';
  errorCode?: SearchErrorCode | 'deadline';
  latencyMs: number | null;
  costUsd: number | null;
  startedAt: Ms;
}

export interface SearchResultLink {
  snapshotId: SnapshotId;
  rank: number;
  providerScore: number | null;
}

/** Writes `search_requests` and `search_results`. Ownership is enforced by migration 007; errors propagate. */
export class SearchLog {
  constructor(private readonly db: Db) {}

  /** Inserts the request and its result links atomically. Returns the request id. */
  record(rec: SearchRequestRecord, links: SearchResultLink[]): string {
    const id = newId('srq');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO search_requests (id, turn_id, user_id, entity_id, intent, round, provider, request_json,
             status, error_code, latency_ms, cost_usd, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          rec.turnId,
          rec.userId,
          rec.entityId,
          rec.intent,
          rec.round,
          rec.provider,
          JSON.stringify(rec.request),
          rec.status,
          rec.errorCode ?? null,
          rec.latencyMs,
          rec.costUsd,
          rec.startedAt,
        );
      const ins = this.db.prepare(
        'INSERT INTO search_results (search_request_id, snapshot_id, rank, provider_score) VALUES (?, ?, ?, ?)',
      );
      for (const l of links) ins.run(id, l.snapshotId, l.rank, l.providerScore);
    })();
    return id;
  }
}
