import type { Db } from '../../db/index.js';
import { queryOne } from '../../db/sql.js';
import { z } from 'zod';
import type { Finding, FindingSet } from '../../shared/findings.js';
import { newId, parseId, type EntityId, type SnapshotId, type UserId } from '../../shared/ids.js';
import type { Clock } from '../../shared/infrastructure.js';
import type { ResearchService } from '../../shared/pipeline.js';
import { normalizeMention, OUTAGE_MARKER } from './analyzer.js';

/**
 * DEVELOPMENT / SCRIPTED. There is no search and no extraction here. For each company the analysis named it
 * returns a canned finding, with a source whose title says so (`[SCRIPTED]`, an `.example` domain), so the
 * streaming, citation and acknowledgement path can be exercised.
 *
 * A message containing "offline" or "unavailable" (the analyzer marks the analysis) makes every finding `unable_to_verify` with a search
 * failure, the way a real research service reports a provider outage.
 *
 * The price is derived from the company name alone. It is not a real price.
 */

export const SCRIPTED_DOMAIN = 'scripted.example';

const idRow = z.object({ id: z.string() });

export function scriptedAmount(name: string): number {
  let sum = 0;
  for (const ch of normalizeMention(name)) sum += ch.codePointAt(0) ?? 0;
  return 20 + (sum % 9) * 5;
}

export class ScriptedResearch implements ResearchService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  run(req: Parameters<ResearchService['run']>[0]): Promise<FindingSet> {
    const now = this.clock.now();
    const outage = req.analysis.alternateQueries.includes(OUTAGE_MARKER);
    const named = new Map<string, string>();
    for (const e of req.ctx.entities) named.set(normalizeMention(e.name), e.name);
    for (const m of req.analysis.entities) {
      if (!named.has(m.normalized)) named.set(m.normalized, m.text);
    }

    const sources: FindingSet['sources'] = {};
    const findings: Finding[] = [];
    let ord = 0;
    for (const [norm, name] of [...named].slice(0, 3)) {
      ord += 1;
      const entityId = this.entityFor(req.userId, norm, name);
      const coverage = {
        searchesOk: outage ? 0 : 1,
        searchesFailed: outage ? 1 : 0,
        extractionFailed: false,
        sourcesChecked: outage ? 0 : 1,
        newestDatedSource: outage ? null : now,
        freshOfficialFetched: !outage,
        failure: outage ? ('search_unavailable' as const) : null,
      };
      const base = {
        id: newId('fnd'),
        ord,
        entityId,
        entityName: name,
        intent: 'pricing' as const,
        beliefKey: null,
        coverage,
        evidenceIds: [],
      };
      if (outage) {
        findings.push({
          ...base,
          currentStatus: 'unable_to_verify',
          verdict: 'unable_to_verify',
          verdictReason: 'search_unavailable',
        });
        continue;
      }
      const snapshotId: SnapshotId = newId('src');
      const url = `https://${SCRIPTED_DOMAIN}/pricing/${encodeURIComponent(norm)}`;
      sources[snapshotId] = {
        url,
        title: `[SCRIPTED] ${name} pricing (not a real page)`,
        domain: SCRIPTED_DOMAIN,
        tier: 'A1',
        observedAt: now,
      };
      const finding: Finding = {
        ...base,
        currentStatus: 'confirmed',
        verdict: null,
        verdictReason: null,
        current: {
          value: {
            amount: scriptedAmount(name),
            currency: 'USD',
            currencySymbol: 'US$',
            unit: 'per_seat',
            usageUnit: null,
            billingPeriod: 'monthly',
            valueKind: 'exact',
          },
          displayedAt: now,
          verifiedAt: now,
          citations: [snapshotId],
          pendingSignals: [],
        },
      };
      findings.push(finding);
      req.emit({
        event: 'source',
        data: {
          sourceId: snapshotId,
          url,
          domain: SCRIPTED_DOMAIN,
          title: sources[snapshotId]?.title ?? null,
          tier: 'A1',
          freshFetch: true,
          observedAt: now,
          providerPublishedAt: null,
        },
      });
    }
    for (const f of findings) req.emit({ event: 'finding', data: f });
    return Promise.resolve({ turnId: req.turnId, createdAt: now, findings, sources });
  }

  /** The user's stored entity of that name, created if this is the first time they asked about it. */
  private entityFor(userId: UserId, norm: string, name: string): EntityId {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entities (id, user_id, canonical, norm, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId('ent'), userId, name, norm, this.clock.now());
    const row = queryOne(this.db, 'SELECT id FROM entities WHERE user_id = ? AND norm = ?', idRow, [
      userId,
      norm,
    ]);
    if (!row) throw new Error('scripted entity vanished after insert');
    return parseId('ent', row.id);
  }
}
