import type {
  AuthorityTier,
  ExtractionBatch,
  ExtractionBatcher,
  SourceSnapshot,
} from '../shared/evidence.js';
import type { EntityId, SnapshotId } from '../shared/ids.js';

/** Architecture R1. */
export const MAX_SNAPSHOT_CHARS = 6000;
export const BATCH_EVIDENCE_TOKENS = 9000;
export const MAX_ENTITIES_PER_BATCH = 3;

const TIER_RANK: Record<AuthorityTier, number> = { A1: 4, A2: 3, B: 2, C: 1 };

export interface BatcherOptions {
  /** Authority tier of a snapshot for its entity; the default ranks everything equally. */
  tierOf?: (s: SourceSnapshot, entityId: EntityId) => AuthorityTier;
  maxSnapshotChars?: number;
  batchTokens?: number;
  maxEntitiesPerBatch?: number;
}

/** `ceil(chars / 4)` on the text the extractor will actually see. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

interface Group {
  entityId: EntityId;
  snapshots: SourceSnapshot[];
  tokens: number;
}

/**
 * Deterministic adaptive packing: group by entity, truncate each snapshot to the cap, drop the
 * lowest-ranked snapshots of an oversized group (authority tier, then fresh fetch, then provider rank, which
 * is input order), then first-fit-decreasing into batches of at most N tokens and M entities. A snapshot
 * shared by two entities is counted once per batch. `trimmed` lists the batch snapshots whose text is cut to the
 * cap, so the extractor and T1 know they only saw a prefix.
 */
export class AdaptiveBatcher implements ExtractionBatcher {
  private readonly tierOf: NonNullable<BatcherOptions['tierOf']>;
  private readonly maxChars: number;
  private readonly maxTokens: number;
  private readonly maxEntities: number;

  constructor(opts: BatcherOptions = {}) {
    this.tierOf = opts.tierOf ?? (() => 'C');
    this.maxChars = opts.maxSnapshotChars ?? MAX_SNAPSHOT_CHARS;
    this.maxTokens = opts.batchTokens ?? BATCH_EVIDENCE_TOKENS;
    this.maxEntities = opts.maxEntitiesPerBatch ?? MAX_ENTITIES_PER_BATCH;
  }

  private tokensOf(s: SourceSnapshot): number {
    return estimateTokens(Math.min(s.text.length, this.maxChars));
  }

  pack(byEntity: Map<EntityId, SourceSnapshot[]>): ExtractionBatch[] {
    const groups: Group[] = [];
    for (const [entityId, list] of [...byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const unique = [...new Map(list.map((s, i) => [s.id, { s, i }])).values()];
      const ranked = unique
        .map(({ s, i }) => ({ s, i, tier: TIER_RANK[this.tierOf(s, entityId)] }))
        .sort(
          (x, y) =>
            y.tier - x.tier ||
            Number(y.s.freshFetch && y.s.crawlStatus === 'ok') -
              Number(x.s.freshFetch && x.s.crawlStatus === 'ok') ||
            x.i - y.i,
        )
        .map((r) => r.s);
      let tokens = ranked.reduce((n, s) => n + this.tokensOf(s), 0);
      const kept = [...ranked];
      while (tokens > this.maxTokens && kept.length > 1) {
        const drop = kept.pop() as SourceSnapshot;
        tokens -= this.tokensOf(drop);
      }
      if (kept.length > 0) groups.push({ entityId, snapshots: kept, tokens });
    }
    groups.sort((a, b) => b.tokens - a.tokens || a.entityId.localeCompare(b.entityId));

    interface Open {
      entities: EntityId[];
      snapshots: Map<SnapshotId, SourceSnapshot>;
      tokens: number;
    }
    const open: Open[] = [];
    for (const g of groups) {
      let placed = false;
      for (const b of open) {
        if (b.entities.length >= this.maxEntities) continue;
        const add = g.snapshots.filter((s) => !b.snapshots.has(s.id));
        const extra = add.reduce((n, s) => n + this.tokensOf(s), 0);
        if (b.tokens + extra > this.maxTokens) continue;
        b.entities.push(g.entityId);
        for (const s of add) b.snapshots.set(s.id, s);
        b.tokens += extra;
        placed = true;
        break;
      }
      if (!placed) {
        open.push({
          entities: [g.entityId],
          snapshots: new Map(g.snapshots.map((s) => [s.id, s])),
          tokens: g.tokens,
        });
      }
    }
    return open.map((b, i) => ({
      id: `batch_${i + 1}`,
      entityIds: [...b.entities].sort(),
      snapshotIds: [...b.snapshots.keys()],
      estTokens: b.tokens,
      trimmed: [...b.snapshots.values()]
        .filter((s) => s.text.length > this.maxChars)
        .map((s) => s.id),
    }));
  }
}
