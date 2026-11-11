import type { NormalizedValue } from '../../../src/shared/evidence.js';
import type { Coverage, Finding, FindingSet } from '../../../src/shared/findings.js';
import type { MessageId, SnapshotId, TurnId } from '../../../src/shared/ids.js';
import type { ResolvedContext } from '../../../src/shared/memory.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { buildRecords, type RecordsInput } from '../../../src/answer/records.js';

export const USD: NormalizedValue = {
  amount: 90,
  currency: 'USD',
  currencySymbol: 'US$',
  unit: 'per_seat',
  usageUnit: null,
  billingPeriod: 'monthly',
  valueKind: 'exact',
};

const COVERAGE: Coverage = {
  searchesOk: 1,
  searchesFailed: 0,
  extractionFailed: false,
  sourcesChecked: 3,
  newestDatedSource: Date.UTC(2026, 10, 3),
  freshOfficialFetched: true,
  failure: null,
};

export const SRC_1 = 'src_one' as SnapshotId;
export const SRC_2 = 'src_two' as SnapshotId;
export const MSG_1 = 'msg_alpha' as MessageId;
export const T_NOV_3 = Date.UTC(2026, 10, 3, 12);

/** A synthetic price finding. [SYNTHETIC] names and values. */
export function finding(ord: number, over: Partial<Finding> = {}): Finding {
  return {
    id: `fnd_${ord}`,
    ord,
    entityId: `ent_${ord}`,
    entityName: `ExampleCo${ord}`,
    intent: 'pricing',
    beliefKey: `price:v1|e=ent_${ord}|p=pro|a=list|c=-|u=per_seat|uu=-|b=monthly|cur=USD|loc=en-US|vk=exact`,
    currentStatus: 'confirmed',
    verdict: null,
    verdictReason: null,
    current: {
      value: USD,
      displayedAt: T_NOV_3,
      verifiedAt: T_NOV_3,
      citations: [SRC_1],
      pendingSignals: [],
    },
    coverage: COVERAGE,
    evidenceIds: [],
    ...over,
  };
}

export function findingSet(findings: Finding[]): FindingSet {
  return {
    turnId: 'trn_1' as TurnId,
    createdAt: T_NOV_3,
    findings,
    sources: {
      [SRC_1]: {
        url: 'https://a.example/p',
        title: 'A',
        domain: 'a.example',
        tier: 'A1',
        observedAt: T_NOV_3,
      },
      [SRC_2]: {
        url: 'https://b.example/p',
        title: 'B',
        domain: 'b.example',
        tier: 'B',
        observedAt: T_NOV_3,
      },
    },
  };
}

export function context(over: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    lane: 'research',
    temporal: [],
    memoryHits: [],
    decisions: [],
    entities: [],
    baselines: [],
    ...over,
  };
}

export function recordsFor(findings: Finding[], over: Partial<RecordsInput> = {}) {
  return buildRecords({
    findings: findingSet(findings),
    recall: new Map(),
    ctx: context(),
    tz: 'Europe/London',
    ...over,
  });
}

/** Collects emitted events. */
export function sink(): { events: SseEvent[]; emit: (e: SseEvent) => void } {
  const events: SseEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}
