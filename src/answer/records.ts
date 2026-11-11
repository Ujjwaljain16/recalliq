import type { PlaceholderRef } from '../shared/answer.js';
import type { Finding, FindingSet } from '../shared/findings.js';
import type { IanaTz, MessageId, SnapshotId } from '../shared/ids.js';
import type { ResolvedContext } from '../shared/memory.js';

/** The data a placeholder renders from, after it has been authorised. */
export type PlaceholderRecord =
  | { kind: 'finding'; variant: 'current' | 'baseline' | 'verdict'; finding: Finding }
  | {
      kind: 'derived';
      finding: Finding;
      index: number;
      derived: NonNullable<Finding['derived']>[number];
    }
  | { kind: 'message'; messageId: MessageId; text: string; localTime: string }
  | { kind: 'source'; snapshotId: SnapshotId };

export type Resolution =
  | { ok: true; record: PlaceholderRecord }
  | { ok: false; issue: 'unknown_ref' | 'inapplicable_variant' };

/** Everything the answer pipeline may refer to: the authorised set of contracts §3, plus rendering context. */
export interface AnswerRecords {
  findings: ReadonlyMap<number, Finding>;
  sources: FindingSet['sources'];
  /** Message ids that are in ResolvedContext.memoryHits AND have a record to quote. */
  messages: ReadonlyMap<MessageId, { text: string; localTime: string }>;
  tz: IanaTz;
  /** `[n]` numbers: the 1-based position of a snapshot among the keys of FindingSet.sources. */
  citationNumber(id: SnapshotId): number | null;
}

export interface RecordsInput {
  findings: FindingSet | null;
  recall: ReadonlyMap<MessageId, { text: string; localTime: string }>;
  ctx: ResolvedContext;
  /** Used when the context carries no timezone (it only exposes one through resolved dates). */
  tz?: IanaTz;
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The user's timezone: an explicit one, else the one the resolved dates were computed in, else UTC. */
export function pickTz(input: RecordsInput): IanaTz {
  const fromCtx = input.ctx.temporal.find((t) => t.candidates[0])?.candidates[0]?.tz;
  for (const tz of [input.tz, fromCtx]) if (tz && validTz(tz)) return tz;
  return 'UTC';
}

export function buildRecords(input: RecordsInput): AnswerRecords {
  const set = input.findings;
  const findings = new Map<number, Finding>((set?.findings ?? []).map((f) => [f.ord, f]));
  const sources = set?.sources ?? ({} as FindingSet['sources']);
  const order = Object.keys(sources);
  const hitIds = new Set(input.ctx.memoryHits.map((h) => h.messageId));
  const messages = new Map<MessageId, { text: string; localTime: string }>();
  for (const [id, rec] of input.recall) if (hitIds.has(id)) messages.set(id, rec);
  return {
    findings,
    sources,
    messages,
    tz: pickTz(input),
    citationNumber: (id) => {
      const i = order.indexOf(id);
      return i === -1 ? null : i + 1;
    },
  };
}

/** Authorises a parsed reference and returns the record to render, or why it is refused. */
export function resolveRef(ref: PlaceholderRef, records: AnswerRecords): Resolution {
  switch (ref.kind) {
    case 'finding': {
      const finding = records.findings.get(ref.ord);
      if (!finding) return { ok: false, issue: 'unknown_ref' };
      if (ref.variant === 'baseline' && !finding.baseline) {
        return { ok: false, issue: 'inapplicable_variant' };
      }
      if (ref.variant === 'verdict' && finding.verdict === null) {
        return { ok: false, issue: 'inapplicable_variant' };
      }
      return { ok: true, record: { kind: 'finding', variant: ref.variant, finding } };
    }
    case 'finding_derived': {
      const finding = records.findings.get(ref.ord);
      if (!finding) return { ok: false, issue: 'unknown_ref' };
      const derived = finding.derived?.[ref.index];
      if (!derived) return { ok: false, issue: 'inapplicable_variant' };
      return { ok: true, record: { kind: 'derived', finding, index: ref.index, derived } };
    }
    case 'message': {
      const m = records.messages.get(ref.messageId);
      if (!m) return { ok: false, issue: 'unknown_ref' };
      return { ok: true, record: { kind: 'message', messageId: ref.messageId, ...m } };
    }
    case 'source':
      return Object.hasOwn(records.sources, ref.snapshotId)
        ? { ok: true, record: { kind: 'source', snapshotId: ref.snapshotId } }
        : { ok: false, issue: 'unknown_ref' };
  }
}
