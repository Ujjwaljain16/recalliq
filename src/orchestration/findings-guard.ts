import type { PersistedSentence, SentenceIssue } from '../shared/answer.js';
import type { Finding, FindingSet } from '../shared/findings.js';
import type { TurnId } from '../shared/ids.js';
import { ContractViolationError } from './errors.js';

/** Verdicts under which "nothing changed" may be said at all (contracts section 3). */
const GLOBAL_NEGATIVE_VERDICTS: ReadonlySet<string> = new Set([
  'unchanged_confirmed',
  'no_evidence_of_change',
  'none_found',
]);

/** Verdicts that only support the "no sign / no evidence" family of phrasing. */
const EVIDENCE_FAMILY_VERDICTS: ReadonlySet<string> = new Set([
  'no_evidence_of_change',
  'none_found',
]);

/** True when the finding could not be checked: a failure of search, extraction or the deadline. */
export function isUnableToVerify(f: Finding): boolean {
  return (
    f.currentStatus === 'unable_to_verify' ||
    f.verdict === 'unable_to_verify' ||
    f.coverage.failure !== null
  );
}

export function hasUnableToVerify(set: FindingSet | null): boolean {
  return set !== null && set.findings.some(isUnableToVerify);
}

/**
 * The global-negative rule (contracts section 3): a sentence such as "nothing changed" is allowed only when
 * every finding's verdict is unchanged_confirmed, no_evidence_of_change or none_found. A single
 * unable_to_verify (or any other verdict, or no finding at all) forbids it.
 */
export function globalNegativeAllowed(set: FindingSet | null): boolean {
  if (set === null || set.findings.length === 0) return false;
  return set.findings.every(
    (f) => !isUnableToVerify(f) && f.verdict !== null && GLOBAL_NEGATIVE_VERDICTS.has(f.verdict),
  );
}

/** With no_evidence_of_change or none_found anywhere, only the "no sign / no evidence" phrasing is allowed. */
export function requiresEvidenceFamilyPhrase(set: FindingSet | null): boolean {
  return (
    set !== null &&
    set.findings.some((f) => f.verdict !== null && EVIDENCE_FAMILY_VERDICTS.has(f.verdict))
  );
}

const GLOBAL_NEGATIVE =
  /\b(nothing (has |have )?(changed|differs?)|no changes?|none of (them|these|those|the \w+)\b[^.]*\b(changed|differ)|(all|everything)( of them| is| are| remains?| stays?)? (the same|unchanged)|unchanged across)/i;
const EVIDENCE_FAMILY =
  /\b(no (sign|signs|evidence|indication)|found no|could not find|couldn't find|not found)\b/i;

export function containsGlobalNegative(text: string): boolean {
  return GLOBAL_NEGATIVE.test(text);
}

/**
 * Defence in depth behind AnswerPipeline's own T3a check: if the findings forbid a global negative and a
 * sentence still says one, the sentence is downgraded to `unverified` and flagged. It only downgrades,
 * never upgrades or rewrites (ADR-16: late verification only downgrades). Returns the new sentences and
 * the indexes that changed so the caller can send `verification` events.
 */
export function guardGlobalNegatives(
  sentences: PersistedSentence[],
  set: FindingSet | null,
): { sentences: PersistedSentence[]; changed: number[] } {
  if (set === null) return { sentences, changed: [] };
  const allowed = globalNegativeAllowed(set);
  const familyOnly = allowed && requiresEvidenceFamilyPhrase(set);
  const changed: number[] = [];
  const guarded = sentences.map((s) => {
    if (!containsGlobalNegative(s.text)) return s;
    const violates = !allowed || (familyOnly && !EVIDENCE_FAMILY.test(s.text));
    if (!violates) return s;
    const issues: SentenceIssue[] = s.issues.includes('unsupported_global_negative')
      ? s.issues
      : [...s.issues, 'unsupported_global_negative'];
    if (issues === s.issues && s.status === 'unverified') return s;
    changed.push(s.index);
    return { ...s, status: 'unverified' as const, issues };
  });
  return { sentences: guarded, changed };
}

/**
 * A FindingSet that contradicts itself is a defect of the research service, not a research result: the
 * coordinator refuses to build an answer on it (it throws, and the turn is not turned into a normal answer).
 * The two rules are the ones in contracts section 2 (allowed currentStatus / verdict combinations).
 */
export function assertFindingSetConsistent(set: FindingSet, turnId: TurnId): void {
  if (set.turnId !== turnId) {
    throw new ContractViolationError(
      `finding set belongs to turn ${set.turnId}, expected ${turnId}`,
    );
  }
  for (const f of set.findings) {
    if (f.coverage.failure !== null && f.currentStatus !== 'unable_to_verify') {
      throw new ContractViolationError(
        `finding ${f.id} has coverage failure "${f.coverage.failure}" but currentStatus "${f.currentStatus}"`,
      );
    }
    if (f.verdict === 'unable_to_verify' && f.currentStatus !== 'unable_to_verify') {
      throw new ContractViolationError(
        `finding ${f.id} has verdict unable_to_verify but currentStatus "${f.currentStatus}"`,
      );
    }
    if (
      f.currentStatus === 'unable_to_verify' &&
      f.verdict !== null &&
      f.verdict !== 'unable_to_verify'
    ) {
      throw new ContractViolationError(
        `finding ${f.id} is unable_to_verify but carries verdict "${f.verdict}"`,
      );
    }
  }
}
