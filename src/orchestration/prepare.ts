import { escapeRegExp } from '../shared/regexp.js';
import type { PersistedSentence, SentenceStatus } from '../shared/answer.js';
import type { NormalizedValue } from '../shared/evidence.js';
import type { Finding, FindingSet } from '../shared/findings.js';
import type { SnapshotId } from '../shared/ids.js';
import type { TurnCompletion } from '../shared/repositories.js';
import type { TerminalTurnStatus } from '../shared/turn.js';
import type { TurnAnalysis, UserFact } from '../shared/understanding.js';
import { hasUnableToVerify } from './findings-guard.js';

/**
 * Response preparation: pure functions that turn what the lanes and the answer pipeline produced into the
 * typed pieces of a TurnCompletion. No I/O, no clock, no model.
 */

export interface DeterministicAnswer {
  sentences: PersistedSentence[];
  template: string;
  rendered: string;
  streamedThrough: number;
}

/** A fixed reply written in code. Its sentences make no claim: status `no_claims`, no placeholders. */
export function deterministicAnswer(texts: string[]): DeterministicAnswer {
  const sentences: PersistedSentence[] = texts.map((text, index) => ({
    index,
    text,
    template: text,
    status: 'no_claims',
    issues: [],
    placeholders: [],
  }));
  return {
    sentences,
    template: texts.join(' '),
    rendered: texts.join(' '),
    streamedThrough: texts.length - 1,
  };
}

/** `partial` when any finding could not be checked, otherwise `complete`. (`interrupted` is decided by the caller.) */
export function statusForFindings(findings: FindingSet | null): TerminalTurnStatus {
  return hasUnableToVerify(findings) ? 'partial' : 'complete';
}

const PLACEHOLDER = /^\[\[(F[1-9]\d{0,2}(?::(?:baseline|verdict|derived:\d+))?)\]\]$/;

function valueOf(finding: Finding, placeholder: string): NormalizedValue | null {
  if (/^F\d+$/.test(placeholder)) return finding.current?.value ?? null;
  if (placeholder.endsWith(':baseline')) return finding.baseline?.value ?? null;
  return null;
}

/**
 * One assertion per rendered finding placeholder (ADR-38: an assertion exists only for an `[[F<n>...]]`
 * placeholder; message and source placeholders create none). It records exactly what was rendered.
 */
export function buildAssertions(
  sentences: PersistedSentence[],
  findings: FindingSet | null,
): TurnCompletion['assertions'] {
  if (findings === null) return [];
  const byId = new Map(findings.findings.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const out: TurnCompletion['assertions'] = [];
  for (const s of sentences) {
    for (const p of s.placeholders) {
      const match = PLACEHOLDER.exec(p.token);
      const finding = p.findingId === undefined ? undefined : byId.get(p.findingId);
      const placeholder = match?.[1];
      if (!finding || placeholder === undefined) continue;
      const key = `${s.index}:${placeholder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        findingId: finding.id,
        sentenceIndex: s.index,
        placeholder,
        beliefKey: finding.beliefKey,
        renderedText: p.rendered,
        value: valueOf(finding, placeholder),
        evidenceIds: finding.evidenceIds,
      });
    }
  }
  return out;
}

/** Contracts section 2: baseline verdict to assertion event. `no_evidence_of_change` writes none. */
const EVENT_FOR_VERDICT: Readonly<
  Record<string, TurnCompletion['baselineEvents'][number]['status'] | undefined>
> = {
  unchanged_confirmed: 'reaffirmed',
  changed: 'superseded_world_changed',
  baseline_incorrect: 'retracted_was_wrong',
  contested: 'contested',
  differs_timing_unknown: 'differs_timing_unknown',
  unable_to_verify: 'unverifiable_now',
};

export function buildBaselineEvents(findings: FindingSet | null): TurnCompletion['baselineEvents'] {
  if (findings === null) return [];
  const out: TurnCompletion['baselineEvents'] = [];
  for (const f of findings.findings) {
    if (!f.baseline || f.verdict === null) continue;
    const status = EVENT_FOR_VERDICT[f.verdict];
    if (status === undefined) continue;
    out.push({
      assertionId: f.baseline.assertionId,
      status,
      reason: f.verdictReason ?? f.verdict,
      evidenceIds: f.evidenceIds,
    });
  }
  return out;
}

/** The snapshots an answer cites: its source placeholders plus the citations of the findings it renders. */
export function citationsOf(
  sentences: PersistedSentence[],
  findings: FindingSet | null,
): SnapshotId[] {
  const cited = new Set<SnapshotId>();
  const byId = new Map((findings?.findings ?? []).map((f) => [f.id, f]));
  for (const s of sentences) {
    for (const p of s.placeholders) {
      if (p.snapshotId !== undefined) cited.add(p.snapshotId);
      const f = p.findingId === undefined ? undefined : byId.get(p.findingId);
      if (!f) continue;
      for (const id of f.current?.citations ?? []) cited.add(id);
      for (const id of f.baseline?.citations ?? []) cited.add(id);
      for (const r of f.releases ?? []) for (const id of r.citations) cited.add(id);
    }
  }
  return [...cited];
}

export function countSentences(sentences: PersistedSentence[]): Record<SentenceStatus, number> {
  const counts: Record<SentenceStatus, number> = {
    verified: 0,
    no_claims: 0,
    unverified: 0,
    unchecked: 0,
    truncated: 0,
  };
  for (const s of sentences) counts[s.status] += 1;
  return counts;
}

const MAX_TERM = 80;

function factIsWellFormed(fact: UserFact, userText: string): boolean {
  if (fact.quote.length === 0 || fact.quote.length > 2_000) return false;
  // Memory poisoning control: a decision must quote the user's own message verbatim.
  if (!userText.includes(fact.quote)) return false;
  if (fact.kind === 'correction') {
    return fact.correctsDecisionKind !== undefined && fact.data.kind === fact.correctsDecisionKind;
  }
  return fact.correctsDecisionKind === undefined && fact.data.kind === fact.kind;
}

/**
 * The write-time enrichment is model output, untrusted. A fact the model could not back with a verbatim quote
 * of the user's message, or whose shape contradicts itself, is dropped here instead of failing the turn's
 * transaction. Nothing the model invents reaches memory.
 */
export function buildEnrichment(
  analysis: TurnAnalysis | null,
  userText: string,
): TurnCompletion['enrichment'] {
  if (analysis === null || analysis.degraded) return { tags: [], entities: [], decisions: [] };
  const printable = (s: string) => s.length > 0 && s.length <= MAX_TERM && !/\p{C}/u.test(s);
  return {
    tags: analysis.topicTerms.filter(printable).slice(0, 50),
    entities: analysis.entities
      .filter((e) => printable(e.text) && printable(e.normalized))
      .slice(0, 20),
    decisions: analysis.userFacts.filter((f) => factIsWellFormed(f, userText)).slice(0, 20),
  };
}

/** At most this many plain price findings per company are written into the answer; the findings card lists all. */
export const MAX_PRICES_PER_ENTITY = 4;

/**
 * The findings the answer is written from. A pricing page can list a dozen plans and add-ons; written out, they
 * bury the answer. Per company, plain current prices (no baseline, no verdict) beyond the cap are left out of
 * the text, seat-priced plans first (the main plans of a team product), then the cheapest. Every finding with a
 * baseline or a verdict, every check that failed and every release finding stays: nothing that says something
 * changed, or could not be checked, is ever dropped. The full set is still sent, stored and shown in the card.
 */
export function findingsForAnswer(
  set: FindingSet | null,
  max = MAX_PRICES_PER_ENTITY,
  userMessage = '',
): FindingSet | null {
  if (set === null) return null;
  // A plan the user named ("the Pro plan") is kept first, whatever it costs.
  const asked = userMessage.normalize('NFKC').toLowerCase();
  const namesPlan = (f: Finding): boolean => {
    const plan = /\|p=([^|]+)/.exec(f.beliefKey ?? '')?.[1];
    return (
      plan !== undefined && plan !== '-' && new RegExp(`\\b${escapeRegExp(plan)}\\b`).test(asked)
    );
  };
  const plain = (f: Finding): boolean =>
    f.intent === 'pricing' &&
    f.baseline === undefined &&
    f.verdict === null &&
    f.current?.value != null &&
    !(f.current.contested && f.current.contested.length > 0);
  const dropped = new Set<string>();
  // One plan priced in several currencies (a page with regional prices) is one price: US dollars first, then a
  // bare symbol, then the first listed.
  const sameExceptCurrency = new Map<string, Finding[]>();
  for (const f of set.findings) {
    if (!plain(f) || f.beliefKey === null) continue;
    const key = f.beliefKey.replace(/\|cur=[^|]*/, '');
    sameExceptCurrency.set(key, [...(sameExceptCurrency.get(key) ?? []), f]);
  }
  const rank = (f: Finding): number =>
    f.current?.value?.currency === 'USD' ? 0 : f.current?.value?.currency === 'unknown' ? 1 : 2;
  for (const group of sameExceptCurrency.values()) {
    const keep = [...group].sort((a, b) => rank(a) - rank(b))[0];
    for (const f of group) if (f !== keep) dropped.add(f.id);
  }
  const byEntity = new Map<string, Finding[]>();
  for (const f of set.findings)
    if (plain(f) && !dropped.has(f.id))
      byEntity.set(f.entityId, [...(byEntity.get(f.entityId) ?? []), f]);
  for (const list of byEntity.values()) {
    if (list.length <= max) continue;
    const ranked = [...list].sort((a, b) => {
      const named = Number(namesPlan(b)) - Number(namesPlan(a));
      if (named !== 0) return named;
      const seat =
        Number(b.current?.value?.unit === 'per_seat') -
        Number(a.current?.value?.unit === 'per_seat');
      return seat !== 0 ? seat : (a.current?.value?.amount ?? 0) - (b.current?.value?.amount ?? 0);
    });
    for (const f of ranked.slice(max)) dropped.add(f.id);
  }
  if (dropped.size === 0) return set;
  return { ...set, findings: set.findings.filter((f) => !dropped.has(f.id)) };
}
