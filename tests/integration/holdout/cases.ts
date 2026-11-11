/**
 * Holdout case definitions: temporal-truth scenarios that are NOT the three original examples.
 *
 * Every expected verdict below was derived from the written specification BEFORE the system was run against these
 * cases, and is committed ahead of the first run so it cannot be adjusted to the result. `source` names the
 * specification passage the expectation comes from (ADR numbers, architecture sections, contracts sections).
 * All vendors, pages and prices are synthetic: fictional names on `.example` domains, with a synthetic stand-in
 * for the provider's per-result crawl marker.
 */

export type Verdict =
  | 'changed'
  | 'baseline_incorrect'
  | 'differs_timing_unknown'
  | 'unchanged_confirmed'
  | 'no_evidence_of_change'
  | 'contested'
  | 'unable_to_verify';

export interface HoldoutCase {
  id: string;
  title: string;
  /** The specification passage the expectation is derived from. */
  source: string;
  /** What must happen, in words. */
  expectation: string;
  /**
   * The acceptable verdicts of the LAST audit turn of the case: one entry when the specification fixes it; several
   * only where the specification allows more than one. `null` means: no verdict at all (no eligible baseline, or a
   * case about a first-time answer).
   */
  verdicts: ReadonlyArray<Verdict | null>;
  /** Verdicts that would be a safety violation whatever else happens. */
  forbidden: ReadonlyArray<Verdict>;
}

const ARCH8 = 'docs/architecture.md section 8 (price verdicts)';
const R3 = 'docs/architecture.md R3 (time fields, belief resolution)';
const ADR36 = 'ADR-36';
const ADR38 = 'ADR-38';
const ADR40 = 'ADR-40';
const ADR41 = 'ADR-41';

const LIST: HoldoutCase[] = [
  // 1. The old answer was correct and the world did not change.
  {
    id: 'HO-01a',
    title: 'old value re-observed live on the official page after the answer',
    source: `${ARCH8} row 4 (A1 fresh_fetch observation with displayedAt after T0); ${ADR36} crawl basis`,
    expectation:
      'unchanged_confirmed, reaffirmed event on the baseline, wording says the official page still showed the same price',
    verdicts: ['unchanged_confirmed'],
    forbidden: ['changed', 'baseline_incorrect', 'differs_timing_unknown'],
  },
  {
    id: 'HO-01b',
    title: 'same re-observation on an unregistered domain (tier C)',
    source: `${ARCH8} row 4 needs an A1 observation, row 5 otherwise`,
    expectation: 'no_evidence_of_change, never unchanged_confirmed',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },
  {
    id: 'HO-01c',
    title: 'old value re-observed with no provider marker',
    source: `${R3} (current(s) needs a displayedAt); ${ARCH8} row 5; ${ADR36} (unmarked freshness is unknown)`,
    expectation:
      'no_evidence_of_change: an unmarked result is not a confirmed live observation, so it can never be unchanged_confirmed',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },
  {
    id: 'HO-01d',
    title: 'old value re-observed from a cached result',
    source: `${R3}; ${ARCH8} row 5; ${ADR36} (cached is not confirmed_live)`,
    expectation: 'no_evidence_of_change, never unchanged_confirmed',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },

  // 2. The old answer was wrong when it was given.
  {
    id: 'HO-02a',
    title: 'the official page states the other price was effective before the answer',
    source: `${ARCH8} row 6a (prior-effect proof: effectiveFrom <= T0, tier at least the baseline's)`,
    expectation:
      'baseline_incorrect (other_value_in_effect_at_T0), retracted_was_wrong event, wording says the earlier answer was already out of date',
    verdicts: ['baseline_incorrect'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },
  {
    id: 'HO-02b',
    title: 'a different price now, nothing that says when it started',
    source: `${ARCH8} row 6d (neither proof)`,
    expectation: 'differs_timing_unknown: the verdict cannot tell wrong-then from changed-since',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'baseline_incorrect'],
  },
  {
    id: 'HO-02c',
    title: 'prior-effect proof on an unregistered domain (tier C baseline and tier C evidence)',
    source: `${ARCH8} low-authority gate (docs/security.md, baseline poisoning)`,
    expectation:
      'differs_timing_unknown (low_authority_source): a tier C page can neither retract nor change a tier C baseline',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'unchanged_confirmed', 'baseline_incorrect'],
  },

  // 3. The world changed, with proof.
  {
    id: 'HO-03a',
    title: 'old value re-observed live after the answer, then the new value on the same url',
    source: `${ADR36} proof 1; ${ARCH8} post-baseline proof, re-observation bracketing`,
    expectation:
      'changed (same_source_bracketing) with changeWindow {after: the old-value re-observation, notAfter: the new-value observation}, direction up, superseded_world_changed event; the intermediate audit is unchanged_confirmed',
    verdicts: ['changed'],
    forbidden: ['unchanged_confirmed', 'no_evidence_of_change'],
  },
  {
    id: 'HO-03b',
    title: 'explicit effective date after the answer on the official page, known locale',
    source: `${ADR36} proof 2; ${ARCH8} post-baseline proof, explicit effective date (A1 or A2, effectiveFrom > T0)`,
    expectation:
      'changed (stated_effective_date) with effectiveFrom 5 November 2026 and wording "changed from <date>"',
    verdicts: ['changed'],
    forbidden: ['unchanged_confirmed', 'differs_timing_unknown'],
  },
  {
    id: 'HO-03c',
    title: 'explicit effective date but the page is on an unregistered domain (tier C)',
    source: `${ADR36} proof 2 ("from a reliable source (tier A1 or A2)")`,
    expectation: 'differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed'],
  },
  {
    id: 'HO-03d',
    title: 're-observation bracketing on tier C pages only (no registry)',
    source: `${ADR36} proof 1; ${ARCH8} low-authority gate (docs/security.md, baseline poisoning)`,
    expectation:
      'differs_timing_unknown (low_authority_source): bracketing on tier C pages alone never proves a change',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'unchanged_confirmed', 'baseline_incorrect'],
  },

  // 4. The price changed, the timing is unknown.
  {
    id: 'HO-04a',
    title: 'a single live observation after the answer shows a lower price',
    source: `${ARCH8} row 6d; ${ADR36} ("the first audit that sees a different price will usually be differs_timing_unknown")`,
    expectation:
      'differs_timing_unknown, no superseded_world_changed event, wording must not say cut, dropped, lowered or reduced',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed'],
  },
  {
    id: 'HO-04b',
    title: 'new value on a cached result that carries a provider last-updated time',
    source: `${R3} displayedAt rules (provider_last_updated); ${ADR36} (cached copies establish no live observation)`,
    expectation: 'differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },
  {
    id: 'HO-04c',
    title: 'new value on an unmarked result with no dates at all',
    source: `${R3} (current(s) needs displayedAt, so the statement is not current); ${ARCH8} row 5. The brief for this evaluation expected differs_timing_unknown; the written rule gives no_evidence_of_change because the undated statement never becomes the current belief`,
    expectation:
      'no_evidence_of_change; a changed or unchanged_confirmed verdict would be a safety violation',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },
  {
    id: 'HO-04d',
    title: 'new value on a cached result with no dates at all',
    source: `${R3}; ${ARCH8} row 5`,
    expectation: 'no_evidence_of_change; never changed',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },

  // 5. The original source disappeared.
  {
    id: 'HO-05a',
    title: 'the search service fails on every attempt',
    source: `${ARCH8} row 1 (coverage failure); contracts section 2 verdict to event mapping (unverifiable_now)`,
    expectation:
      'unable_to_verify, unverifiable_now event, wording "couldn\'t be checked this time"',
    verdicts: ['unable_to_verify'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },
  {
    id: 'HO-05b',
    title: 'the old page now answers with a "not found" page that carries no price',
    source: `${ARCH8} rows 1 and 5 (coverage failure, or no current confirmation)`,
    expectation:
      'unable_to_verify or no_evidence_of_change (the specification allows either); never unchanged_confirmed or changed',
    verdicts: ['unable_to_verify', 'no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed', 'differs_timing_unknown'],
  },
  {
    id: 'HO-05c',
    title: 'the old page is no longer returned at all (empty result set)',
    source: `${ARCH8} rows 1 and 5`,
    expectation: 'unable_to_verify or no_evidence_of_change; never unchanged_confirmed or changed',
    verdicts: ['unable_to_verify', 'no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed', 'differs_timing_unknown'],
  },
  {
    id: 'HO-05d',
    title: 'the old url is gone; another url on the official domain shows a different price',
    source: `${ADR36} proof 1 (matching source identity: the same url_norm); ${ARCH8} row 6d`,
    expectation: 'differs_timing_unknown, never changed (no re-observation of the old url)',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },

  // 6. The current source is cached.
  {
    id: 'HO-06a',
    title: 'the later observation of the same price is a cached result',
    source: `${ARCH8} row 4 needs a fresh_fetch observation; ${ADR36} crawl basis (cached)`,
    expectation:
      'no_evidence_of_change; coverage.freshOfficialFetched false; the stored snapshot has crawl_basis cached; wording makes no live-check claim',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },
  {
    id: 'HO-06b',
    title: 'the later observation of the same price carries no marker',
    source: `${ARCH8} row 4; ${ADR36} crawl basis (unknown)`,
    expectation:
      'no_evidence_of_change; the stored snapshot has crawl_basis unknown; wording makes no live-check claim',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['unchanged_confirmed', 'changed'],
  },
  {
    id: 'HO-06c',
    title: 'a first-time answer resting on a cached, unmarked or failed-crawl result',
    source: `${R3} (no displayedAt gives a stale belief); contracts section 3 (stale renders "last seen"); ${ADR36} crawl basis`,
    expectation:
      'finding is stale, never confirmed; no snapshot is stored as confirmed_live; the answer says "last seen" and does not claim a check',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-06e',
    title: 'a live re-observation of the old value, then the new value only from a cached result',
    source: `${R3} (an undated cached statement is not current, so the latest live observation still wins); ${ARCH8} row 4; ${ADR36}`,
    expectation:
      'unchanged_confirmed on the live observation (the cached new value neither confirms nor changes anything); never changed',
    verdicts: ['unchanged_confirmed'],
    forbidden: ['changed'],
  },

  // 7. The vendor has several domains.
  {
    id: 'HO-07a',
    title: 'the only post-answer observation is of another registered domain of the vendor',
    source: `${ADR36} proof 1 (the same url_norm, not the same vendor); ${ARCH8} row 6d`,
    expectation: 'differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed', 'unchanged_confirmed'],
  },
  {
    id: 'HO-07b',
    title: 'old value re-observed on the first domain, new value only on the second domain',
    source: `${ADR36} proof 1 (a different url_norm cannot satisfy the bracketing)`,
    expectation:
      'first audit unchanged_confirmed; second audit differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed'],
  },
  {
    id: 'HO-07c',
    title: 'two registered domains show conflicting values in the same window',
    source: `${R3} belief resolution (same highest tier within the 7 day contest window with distinct values is contested); ${ARCH8} row 2`,
    expectation:
      'contested, contested event, finding currentStatus contested, wording "official sources disagree", no change wording',
    verdicts: ['contested'],
    forbidden: ['changed', 'unchanged_confirmed', 'differs_timing_unknown'],
  },
  {
    id: 'HO-07d',
    title: 'a second domain that is not in the registry shows another value at the same time',
    source: `${R3} (only the highest tier present decides; a lower tier is at most a pending signal); ${ARCH8} row 4`,
    expectation:
      'unchanged_confirmed from the registered domain; the other domain neither contests nor changes it',
    verdicts: ['unchanged_confirmed'],
    forbidden: ['changed', 'contested'],
  },

  // 8. A third-party product on an official vendor page.
  {
    id: 'HO-08a',
    title:
      'an add-on price on the vendor page, the quote itself says "add-on from" another company',
    source: `${ADR41} decision 3 (blockers: integration and third-party, add-on from)`,
    expectation:
      'the add-on price never passes verification, never becomes a belief or an assertion; the vendor price stays confirmed',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-08b',
    title:
      'a partner-listing price with no vendor name and no cue in its own line, under a marketplace heading',
    source: `${ADR41} decision 3 (blockers read up to 1,500 characters of the page above the quote: marketplace, partner listings)`,
    expectation: 'the partner price never passes, never becomes a belief or an assertion',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-08c',
    title: 'the page holds only the partner price',
    source: `${ADR41} decision 3; architecture R2 ("under-claiming is better than misattributing")`,
    expectation: 'no verified price is found; the answer says so and states no amount',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-08d',
    title:
      "control: the vendor's own plan-tied price on a registered pricing page binds by ownership",
    source: `${ADR41} decision 2 (page level ownership binds a plan-tied price when no blocker fires)`,
    expectation:
      'the price passes, the finding is confirmed, and the check detail says it was bound by registered domain ownership',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-08e',
    title: 'control: the same vendor-less price line on an unregistered domain stays weak',
    source: `${ADR41} decision 1 (ownership comes from the registry only); architecture R2 subject binding`,
    expectation: 'no pass statement, no belief, "no verified price was found"',
    verdicts: [null],
    forbidden: [],
  },

  // 9. Locale.
  {
    id: 'HO-09a',
    title: 'the same plan has different prices on the en-gb and en-us pages',
    source: `${R3} typed belief key (locale is part of the key); ADR-37`,
    expectation: 'two separate confirmed beliefs, one per locale; nothing is contested',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-09b',
    title: 'audit of the en-gb answer while the en-us page shows another price',
    source: `${R3} (the current state is the belief for exactly the baseline key); ${ARCH8} row 4`,
    expectation: 'unchanged_confirmed: the other locale never contests or changes it',
    verdicts: ['unchanged_confirmed'],
    forbidden: ['changed', 'contested', 'differs_timing_unknown'],
  },
  {
    id: 'HO-09c',
    title: 'unknown locale: re-observation bracketing on a page with no locale in its url',
    source: `${ADR36} proof 1 (a known locale; an unknown locale cannot independently establish changed)`,
    expectation:
      'first audit unchanged_confirmed; second audit differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed'],
  },
  {
    id: 'HO-09d',
    title: 'unknown locale with an explicit effective date',
    source: `${ADR36} proof 2 ("an unknown locale cannot independently establish changed by either route")`,
    expectation: 'differs_timing_unknown, never changed',
    verdicts: ['differs_timing_unknown'],
    forbidden: ['changed'],
  },
  {
    id: 'HO-09e',
    title: 'only the other locale is observed after the answer, with a different price',
    source: `${R3} (keys differ by locale); ${ARCH8} row 5 (no fresh observation of the baseline key)`,
    expectation: 'no_evidence_of_change, never changed',
    verdicts: ['no_evidence_of_change'],
    forbidden: ['changed', 'contested', 'differs_timing_unknown'],
  },

  // 10. The acknowledgement boundary.
  {
    id: 'HO-10a',
    title: 'an answer that was streamed and never acknowledged',
    source: `${ADR38} (streamed-but-unacknowledged is not told, never a baseline); docs/turn-lifecycle.md acknowledgement semantics`,
    expectation: 'no verdict about it, no verdict event, no baseline in the finding',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-10b',
    title: 'the price sentence is the second sentence and only the first was acknowledged',
    source: `docs/turn-lifecycle.md (an assertion beyond rendered_through is streamed_unacknowledged); ${ADR38} rule 1`,
    expectation: 'the claim is not presented; no verdict about it',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-10c',
    title: 'control: the same answer acknowledged late, before the audit',
    source: `docs/turn-lifecycle.md (acknowledgement presents exactly the newly covered claims); ${ADR38} rule 1`,
    expectation: 'it is a baseline: unchanged_confirmed on a live official re-observation',
    verdicts: ['unchanged_confirmed'],
    forbidden: ['changed'],
  },

  // 11. A claim about a contested or stale finding is not a baseline.
  {
    id: 'HO-11a',
    title: 'the earlier answer was about a contested finding',
    source: `${ADR38} rule 6 (finding not confirmed when stored); contracts table of allowed status and verdict`,
    expectation:
      'no verdict; the baseline loader returns no baseline and recalls the claim as unverified with reason finding_not_confirmed',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-11b',
    title: 'the earlier answer was about a stale finding',
    source: `${ADR38} rule 6`,
    expectation: 'no verdict; reason finding_not_confirmed',
    verdicts: [null],
    forbidden: [],
  },
  {
    id: 'HO-11c',
    title: 'the earlier answer said the price could not be checked',
    source: `${ADR38} rule 6 (unable_to_verify records a limitation, not a fact)`,
    expectation: 'no verdict about it later',
    verdicts: [null],
    forbidden: [],
  },

  // 12. Wording.
  {
    id: 'HO-12',
    title: 'a model that writes change wording the verdict does not allow',
    source: `${ADR40} change language rules 1 to 3; contracts section 3 compatible-verdict sets`,
    expectation:
      'the sentence is withheld (sentence_withheld warning), the forbidden word appears nowhere in the visible text',
    verdicts: [null],
    forbidden: [],
  },
];

export const CASES: Readonly<Record<string, HoldoutCase>> = Object.fromEntries(
  LIST.map((c) => [c.id, c]),
);

export function caseOf(id: string): HoldoutCase {
  const c = CASES[id];
  if (!c) throw new Error(`unknown holdout case ${id}`);
  return c;
}
