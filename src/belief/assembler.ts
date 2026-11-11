import type {
  AuthorityTier,
  Belief,
  ChangeDetector,
  Coverage,
  EvidenceId,
  Finding,
  FindingCurrentStatus,
  FindingId,
  FindingSet,
  Intent,
  Ms,
  PriceVerdict,
  PriceVerdictReason,
  ResolvedContext,
  SnapshotId,
  SourceSnapshot,
  TurnId,
  VerifiedEvidence,
  Baseline,
} from '../shared/index.js';
import { newId } from '../shared/ids.js';
import { comparableKeys, decodePriceKey } from './belief-key.js';
import { tierRank } from './resolver.js';

export interface EntityAssemblyInput {
  entity: ResolvedContext['entities'][number];
  intents: readonly Intent[];
  coverage: Coverage;
  /** Price beliefs for the entity, any arrangement. */
  beliefs: readonly Belief[];
  /** `pass` evidence per belief key (history included), for the detector. */
  evidenceByKey: ReadonlyMap<string, VerifiedEvidence[]>;
  releaseEvidence: readonly VerifiedEvidence[];
  /** Baselines of this entity, already re-verified under current rules. */
  baselines: readonly Baseline[];
  /** Start of the release interval (T0). */
  releaseSince: Ms;
}

export interface AssembleInput {
  turnId: TurnId;
  createdAt: Ms;
  entities: readonly EntityAssemblyInput[];
  snapshots: ReadonlyMap<SnapshotId, SourceSnapshot>;
}

const ALLOWED_PRICE: Record<FindingCurrentStatus, readonly (PriceVerdict | null)[]> = {
  confirmed: [
    'changed',
    'baseline_incorrect',
    'differs_timing_unknown',
    'unchanged_confirmed',
    'no_evidence_of_change',
    'contested',
    null,
  ],
  contested: ['contested', null],
  stale: ['no_evidence_of_change', 'baseline_incorrect', null],
  unknown: ['no_evidence_of_change', 'baseline_incorrect', null],
  unable_to_verify: ['unable_to_verify', null],
};

/** T-FND-01: the allowed combinations of `currentStatus` and verdict (contracts §2). Throws on a violation. */
export function assertAllowedCombination(
  f: Pick<Finding, 'intent' | 'currentStatus' | 'verdict' | 'verdictReason'>,
): void {
  if (f.intent === 'releases') {
    const v = f.verdict;
    const unable = f.currentStatus === 'unable_to_verify';
    if ((v === 'unable_to_verify') !== unable)
      throw new Error('finding: unable_to_verify verdict and status must go together');
    if ((v === 'releases_found' || v === 'none_found') && unable)
      throw new Error('finding: a release verdict needs a checkable status');
    return;
  }
  const v = f.verdict as PriceVerdict | null;
  if (!ALLOWED_PRICE[f.currentStatus].includes(v))
    throw new Error(`finding: verdict ${String(v)} is not allowed with status ${f.currentStatus}`);
  if (f.currentStatus === 'confirmed' && v === 'contested' && f.verdictReason !== 'timing_conflict')
    throw new Error(
      'finding: a contested verdict on a confirmed belief must have reason timing_conflict',
    );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isFailure(c: Coverage): PriceVerdictReason | null {
  return c.failure ?? (c.extractionFailed ? 'extraction_failed' : null);
}

export interface AssemblerDeps {
  detector: ChangeDetector;
  newFindingId?: () => FindingId;
}

/** Builds Finding / FindingSet from beliefs, evidence, baselines and coverage. Contains no LLM output. */
export class FindingAssembler {
  private readonly newFindingId: () => FindingId;

  constructor(private readonly deps: AssemblerDeps) {
    this.newFindingId = deps.newFindingId ?? (() => newId('fnd'));
  }

  assemble(input: AssembleInput): FindingSet {
    const findings: Finding[] = [];
    const evidenceById = new Map<EvidenceId, VerifiedEvidence>();
    const add = (e: VerifiedEvidence) => evidenceById.set(e.id, e);
    for (const ent of input.entities) {
      for (const list of ent.evidenceByKey.values()) list.forEach(add);
      ent.releaseEvidence.forEach(add);
      for (const b of ent.baselines) b.evidence.forEach(add);
    }
    let ord = 0;
    const push = (f: Omit<Finding, 'id' | 'ord'>) => {
      ord++;
      const finding: Finding = { ...f, id: this.newFindingId(), ord };
      assertAllowedCombination(finding);
      findings.push(finding);
    };
    for (const ent of input.entities) {
      if (ent.intents.includes('pricing')) this.pricing(ent, evidenceById, push);
      if (ent.intents.includes('releases')) this.releases(ent, push);
    }
    return {
      turnId: input.turnId,
      createdAt: input.createdAt,
      findings,
      sources: this.sources(findings, evidenceById, input.snapshots),
    };
  }

  private citations(
    ids: readonly EvidenceId[],
    byId: ReadonlyMap<EvidenceId, VerifiedEvidence>,
  ): SnapshotId[] {
    const out: SnapshotId[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (e && !out.includes(e.snapshotId)) out.push(e.snapshotId);
    }
    return out;
  }

  private pricing(
    ent: EntityAssemblyInput,
    byId: ReadonlyMap<EvidenceId, VerifiedEvidence>,
    push: (f: Omit<Finding, 'id' | 'ord'>) => void,
  ): void {
    const failure = isFailure(ent.coverage);
    const base = {
      entityId: ent.entity.id,
      entityName: ent.entity.name,
      intent: 'pricing' as const,
    };

    if (ent.baselines.length > 0) {
      for (const b of ent.baselines) {
        const current = ent.beliefs.find((x) => x.key === b.beliefKey) ?? null;
        const det = this.deps.detector.price(
          b,
          current,
          ent.evidenceByKey.get(b.beliefKey) ?? [],
          ent.coverage,
        );
        const status: FindingCurrentStatus =
          det.verdict === 'unable_to_verify' ? 'unable_to_verify' : (current?.status ?? 'unknown');
        let reason: PriceVerdictReason | null = det.reason;
        if (
          det.verdict === 'no_evidence_of_change' &&
          (current === null || current.status === 'unknown') &&
          ent.beliefs.some(
            (x) =>
              x.status !== 'unknown' &&
              x.key !== b.beliefKey &&
              comparableKeys(b.key, decodePriceKey(x.key)) === 'comparable',
          )
        )
          reason = 'listed_differently';
        const f: Omit<Finding, 'id' | 'ord'> = {
          ...base,
          beliefKey: b.beliefKey,
          currentStatus: status,
          verdict: det.verdict,
          verdictReason: reason,
          coverage: ent.coverage,
          evidenceIds: [
            ...new Set([...(current?.winningEvidence ?? []), ...b.evidence.map((e) => e.id)]),
          ],
          baseline: {
            value: b.value,
            presentedAt: b.presentedAt,
            citations: this.citations(
              b.evidence.map((e) => e.id),
              byId,
            ),
            assertionId: b.assertionId,
          },
        };
        if (det.direction) f.direction = det.direction;
        if (det.window) f.changeWindow = det.window;
        if (det.effectiveFrom !== undefined) f.effectiveFrom = det.effectiveFrom;
        if (status !== 'unable_to_verify' && current) f.current = this.currentBlock(current, byId);
        const derived = derivedValues(current?.value ?? null, b.value);
        if (derived.length > 0) f.derived = derived;
        push(f);
      }
      return;
    }

    const shown = ent.beliefs
      .filter((x) => x.status !== 'unknown' && decodePriceKey(x.key).arrangement !== 'planned')
      .sort((a, b) => a.key.localeCompare(b.key));
    if (shown.length === 0 || failure !== null) {
      push({
        ...base,
        beliefKey: null,
        currentStatus: failure !== null ? 'unable_to_verify' : 'unknown',
        verdict: null,
        verdictReason: failure,
        coverage: ent.coverage,
        evidenceIds: [],
      });
      return;
    }
    for (const b of shown) {
      const derived = derivedValues(b.value, null);
      push({
        ...base,
        beliefKey: b.key,
        currentStatus: b.status,
        verdict: null,
        verdictReason: null,
        current: this.currentBlock(b, byId),
        ...(derived.length > 0 ? { derived } : {}),
        coverage: ent.coverage,
        evidenceIds: [...b.winningEvidence],
      });
    }
  }

  private currentBlock(
    b: Belief,
    byId: ReadonlyMap<EvidenceId, VerifiedEvidence>,
  ): NonNullable<Finding['current']> {
    const pendingIds = b.pendingSignals.flatMap((p) => p.evidenceIds);
    const cur: NonNullable<Finding['current']> = {
      value: b.value,
      displayedAt: b.displayedAt,
      verifiedAt: b.verifiedAt,
      citations: this.citations([...b.winningEvidence, ...pendingIds], byId),
      pendingSignals: b.pendingSignals,
    };
    if (b.contestedValues) cur.contested = b.contestedValues;
    return cur;
  }

  private releases(ent: EntityAssemblyInput, push: (f: Omit<Finding, 'id' | 'ord'>) => void): void {
    const t0 = ent.releaseSince;
    const r = this.deps.detector.releases([...ent.releaseEvidence], ent.coverage, t0);
    const status: FindingCurrentStatus =
      r.verdict === 'unable_to_verify'
        ? 'unable_to_verify'
        : r.verdict === 'releases_found'
          ? 'confirmed'
          : 'unknown';
    const f: Omit<Finding, 'id' | 'ord'> = {
      entityId: ent.entity.id,
      entityName: ent.entity.name,
      intent: 'releases',
      beliefKey: null,
      currentStatus: status,
      verdict: r.verdict,
      verdictReason: r.verdict === 'unable_to_verify' ? isFailure(ent.coverage) : null,
      coverage: ent.coverage,
      evidenceIds: r.items.map((e) => e.id),
    };
    if (r.items.length > 0)
      f.releases = r.items.map((e) => ({
        title: e.fields.releaseTitle ?? '(untitled)',
        kind: e.fields.releaseKind ?? 'change',
        eventDate: e.eventDate,
        providerPublishedAt: e.providerPublishedAt,
        significance: e.significance,
        announcedBeforeBaseline:
          e.providerPublishedAt !== null &&
          e.providerPublishedAt < t0 &&
          e.eventDate !== null &&
          e.eventDate >= t0,
        citations: [e.snapshotId],
      }));
    push(f);
  }

  private sources(
    findings: readonly Finding[],
    byId: ReadonlyMap<EvidenceId, VerifiedEvidence>,
    snapshots: ReadonlyMap<SnapshotId, SourceSnapshot>,
  ): FindingSet['sources'] {
    const cited = new Set<SnapshotId>();
    for (const f of findings) {
      f.current?.citations.forEach((c) => cited.add(c));
      f.baseline?.citations.forEach((c) => cited.add(c));
      f.releases?.forEach((r) => r.citations.forEach((c) => cited.add(c)));
    }
    const out: FindingSet['sources'] = {};
    for (const id of cited) {
      const s = snapshots.get(id);
      if (!s) continue;
      let tier: AuthorityTier = 'C';
      for (const e of byId.values())
        if (e.snapshotId === id && tierRank(e.authorityTier) > tierRank(tier))
          tier = e.authorityTier;
      out[id] = { url: s.url, title: s.title, domain: s.domain, tier, observedAt: s.observedAt };
    }
    return out;
  }
}

/** Arithmetic the answer may quote, computed here so no number is free text: index 0 first. */
function derivedValues(
  current: Belief['value'],
  baseline: Belief['value'],
): NonNullable<Finding['derived']> {
  const out: NonNullable<Finding['derived']> = [];
  if (
    current &&
    (current.billingPeriod === 'monthly' || current.billingPeriod === 'monthly_billed_annually') &&
    current.valueKind === 'exact'
  )
    out.push({
      label: 'annualised',
      amount: round2(current.amount * 12),
      currency: current.currency,
      currencySymbol: current.currencySymbol,
      formula: `${current.amount} x 12`,
    });
  if (
    current &&
    baseline &&
    current.currency === baseline.currency &&
    current.unit === baseline.unit &&
    current.billingPeriod === baseline.billingPeriod &&
    current.amount !== baseline.amount
  )
    out.push({
      label: 'difference',
      amount: round2(current.amount - baseline.amount),
      currency: current.currency,
      currencySymbol: current.currencySymbol,
      formula: `${current.amount} - ${baseline.amount}`,
    });
  return out;
}
