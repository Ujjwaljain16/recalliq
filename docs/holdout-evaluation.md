# Holdout evaluation: temporal truth beyond the three original examples

An independent check of whether the final system understands temporal truth, using cases that were not used to build
or tune it. Everything runs offline: the real HTTP server, real SQLite and migrations, the real orchestrator,
research service, evidence verification, belief resolution and answer pipeline, with only the search provider and the
model replaced by replay fixtures (`src/app/live/fixture.ts`).

## How the cases were written and run

- The case definitions and their expected verdicts are in `tests/integration/holdout/cases.ts`. Each names the
  specification passage it comes from (ADR-22, ADR-36, ADR-38, ADR-40, ADR-41, `docs/architecture.md` R2, R3 and
  section 8, `docs/contracts.md`, `docs/turn-lifecycle.md`).
- **The expectations were committed first** (commit "record temporal-truth cases and expected verdicts before any
  run"), then the tests (commit "add the case tests and helpers ... not yet run"), and only then was anything run.
- The system was not tuned: no file under `src/`, no existing test, prompt, migration or document was changed.
- After the first run, 12 of 55 tests failed. All 12 were defects in the new test rig, not in the system, and were
  fixed in a separate, labelled commit that changed no case definition, expected verdict or assertion:
  1. A quote with an effective date makes the deterministic entailment check uncertain, so verification asks the
     judge; the replay fixture had no judge reply (`replay_miss`). A synthetic `supports` reply was added.
  2. The wording oracle read the system's own refusal sentence ("cannot establish whether anything changed since
     then") as a change claim. That phrase is now treated as the system's own wording.
- Provider markers are synthetic stand-ins: `{ source: 'live', status: 'ok' }` is a confirmed live crawl; `{ source:
  'cached', status: 'ok' }` is cached; no marker means freshness is unknown; `{ source: 'live', status: 'failed' }`
  is a failed crawl. Vendors are fictional, on `.example` domains. The owner registry is the example registry
  (`acme.example`) unless a case says otherwise (`none`, or two domains for one vendor).

Where this evaluation's brief and the written rule differ, the written rule was used and the difference recorded in
the case (HO-04c): an undated, unmarked or cached new value is never the current belief (R3, "current(s) needs a
displayedAt"), so the written verdict is `no_evidence_of_change`, not `differs_timing_unknown`. Either is safe; both
are never `changed`.

## Results

55 holdout tests: **55 passed, 0 failed**. No test needed `it.fails` or a `HOLDOUT-FAIL:` marker.

Each case below also asserts, through the shared helpers in `tests/integration/holdout/rig.ts`:
the streamed finding equals the stored finding row; the baseline assertion received exactly the event the contracts
mapping prescribes for the verdict (none for `no_evidence_of_change` or no verdict) and in particular no
`superseded_world_changed`, `reaffirmed` or `retracted_was_wrong` event without the matching verdict; and the visible
sentences contain no change or unchanged wording the verdict does not allow (the pipeline's own verdict phrase is
allowed).

| Case | Scenario | Specification source | Expected | Observed | Result |
|---|---|---|---|---|---|
| HO-01a | old value re-observed live on the registered official page after the answer | architecture section 8 row 4; ADR-36 crawl basis | unchanged_confirmed, reaffirmed event | unchanged_confirmed, "the official page still showed the same price when checked on ..." | PASS |
| HO-01b | same, domain not in the registry (tier C) | section 8 rows 4 and 5 | no_evidence_of_change | no_evidence_of_change | PASS |
| HO-01c | re-observation with no marker | R3, section 8 row 5, ADR-36 | no_evidence_of_change, never unchanged_confirmed | no_evidence_of_change, `freshOfficialFetched` false | PASS |
| HO-01d | re-observation from a cached result | same | no_evidence_of_change | no_evidence_of_change | PASS |
| HO-02a | page says the other price was effective before the answer | section 8 row 6a | baseline_incorrect (other_value_in_effect_at_T0), retracted_was_wrong | as expected, "my earlier answer was already out of date" | PASS |
| HO-02b | different price, no date | section 8 row 6d | differs_timing_unknown | differs_timing_unknown | PASS |
| HO-02c | prior-effect proof at tier C with a tier C baseline | section 8 prior-effect proof | baseline_incorrect | baseline_incorrect | PASS |
| HO-03a | old value re-observed live, then new value, same url, en-GB | ADR-36 proof 1 | changed, same_source_bracketing, window {2026-11-12 10:00, 2026-11-22 12:00 UTC} exactly the two observation times, direction up, middle audit unchanged_confirmed | as expected (window matched to the millisecond) | PASS |
| HO-03b | explicit effective date 5 November after the answer, A1, known locale | ADR-36 proof 2 | changed, stated_effective_date, effectiveFrom 2026-11-05 | as expected, "changed from 5 Nov 2026" | PASS |
| HO-03c | same effective date on an unregistered domain | ADR-36 proof 2 (A1 or A2) | differs_timing_unknown | differs_timing_unknown | PASS |
| HO-03d | bracketing with no registry | ADR-36 proof 1 | changed | changed (middle audit no_evidence_of_change) | PASS |
| HO-04a | one live observation, lower price | section 8 row 6d | differs_timing_unknown, no cut or drop wording | as expected | PASS |
| HO-04b | cached result with a provider last-updated time | R3 displayedAt rules, ADR-36 | differs_timing_unknown | differs_timing_unknown, snapshot crawl_basis cached | PASS |
| HO-04c | unmarked, undated new value | R3, section 8 row 5 | no_evidence_of_change | no_evidence_of_change, snapshot crawl_basis unknown | PASS |
| HO-04d | cached, undated new value | R3, section 8 row 5 | no_evidence_of_change | no_evidence_of_change | PASS |
| HO-05a | search service fails on every attempt | section 8 row 1 | unable_to_verify, unverifiable_now | as expected, "couldn't be checked this time" | PASS |
| HO-05b | old page returns a "not found" page with no price | section 8 rows 1 and 5 | unable_to_verify or no_evidence_of_change | no_evidence_of_change | PASS |
| HO-05c | empty result set | same | same | no_evidence_of_change | PASS |
| HO-05d | old url gone, another url shows a different price | ADR-36 same url_norm | differs_timing_unknown | differs_timing_unknown | PASS |
| HO-06a | later observation of the same price is cached | section 8 row 4, ADR-36 | no_evidence_of_change, crawl_basis cached, no live-check wording | as expected | PASS |
| HO-06b | later observation has no marker | same | no_evidence_of_change, crawl_basis unknown | as expected | PASS |
| HO-06c | first-time answer from a cached, unmarked or failed-crawl result (3 variants) | R3, contracts section 3 | finding stale, "last seen", no confirmed_live snapshot, no confirmed belief | as expected in all three | PASS |
| HO-06e | live old value, then new value only from a cached result | R3, section 8 row 4 | unchanged_confirmed, never changed | unchanged_confirmed (the cached new value changes nothing) | PASS |
| HO-07a | only the vendor's second registered domain shows a new value | ADR-36 same url_norm | differs_timing_unknown | differs_timing_unknown | PASS |
| HO-07b | old value on domain 1, new value only on domain 2 | ADR-36 | first audit unchanged_confirmed, second differs_timing_unknown | as expected | PASS |
| HO-07c | both registered domains show conflicting values in the window | R3 contest window, section 8 row 2 | contested, contested event, "official sources disagree" | as expected | PASS |
| HO-07d | second domain not in the registry shows another value | R3 (highest tier decides) | unchanged_confirmed | unchanged_confirmed | PASS |
| HO-08a | add-on price on the vendor page, quote says "add-on from" another company | ADR-41 blockers | not a pass statement, no belief, no assertion | verification `weak`; vendor price stays 90 | PASS |
| HO-08b | partner price, no vendor name, no cue in its own line, under a marketplace heading | ADR-41 (1,500 characters above) | same | `weak`; nothing stored for 15 | PASS |
| HO-08c | page holds only the partner price | ADR-41, R2 | "no verified price was found", no belief | as expected | PASS |
| HO-08d | control: vendor-less own price on a registered page | ADR-41 decision 2 | passes, bound by registered ownership | as expected | PASS |
| HO-08e | control: same on an unregistered domain | ADR-41 decision 1 | weak, no belief | as expected | PASS |
| HO-09a | en-GB 90 and en-US 100 for the same plan | R3 key, ADR-37 | two confirmed beliefs, nothing contested | as expected | PASS |
| HO-09b | audit of the en-GB answer, en-US page shows another price | R3, row 4 | unchanged_confirmed | unchanged_confirmed | PASS |
| HO-09c | unknown locale, bracketing | ADR-36 | second audit differs_timing_unknown | as expected (first audit unchanged_confirmed) | PASS |
| HO-09d | unknown locale, explicit effective date | ADR-36 proof 2 | differs_timing_unknown | differs_timing_unknown | PASS |
| HO-09e | only the other locale observed after the answer | R3, row 5 | no_evidence_of_change | no_evidence_of_change | PASS |
| HO-10a | answer streamed, never acknowledged | ADR-38, turn-lifecycle | no verdict, no baseline, no verdict event | as expected; the answer says it has no earlier answer on record | PASS |
| HO-10b | price claim in sentence 2, only sentence 1 acknowledged | turn-lifecycle, ADR-38 rule 1 | same | as expected | PASS |
| HO-10c | control: acknowledged late | turn-lifecycle | baseline, unchanged_confirmed | as expected | PASS |
| HO-11a | earlier answer about a contested finding | ADR-38 rule 6 | no verdict, loader returns 0 baselines, reason finding_not_confirmed | as expected | PASS |
| HO-11b | earlier answer about a stale finding | ADR-38 rule 6 | same | as expected | PASS |
| HO-11c | earlier answer said the price could not be checked | ADR-38 rule 6 | no verdict later | as expected | PASS |
| HO-12 | 10 hostile model sentences (raised, cut, used to, unchanged ...) beside a verdict placeholder that does not allow them | ADR-40 change language, contracts section 3 | sentence withheld, forbidden word absent, no contradicting event | as expected in all 10 | PASS |

## Observations that are not failures

- **A vanished source still reads as a confirmed current price (HO-05b, HO-05c).** When the old page stops returning
  a price, the finding stays `confirmed` with the value from the baseline's own earlier fetch (it is inside the 30
  day freshness window in R3), and the verdict is `no_evidence_of_change`. The rule is followed, and the verdict
  wording ("no sign of a change in what I could check") is honest, but a model that writes "now the page shows
  [[F1]]" will be allowed to render a price that no longer appears anywhere. The pipeline cannot know the model's
  free-text "now the page shows". Whether `current` should say it rests on an earlier fetch is a design question,
  not a violation of any written rule.
- **HO-04c differs from the evaluation brief** (see above). The written rule was followed.
- One full-suite run out of seven had a single failure in a file other than the holdout files; it did not recur in
  six reruns and the failing name was not captured. It is not attributed to any component here.

## Commands and counts

```
npm run typecheck      # clean
npm run lint           # clean
npm run format:check   # clean
npx vitest run tests/integration/holdout   # 5 files, 55 tests passed
npx vitest run         # 118 files passed, 2 skipped; 2189 tests passed, 4 skipped, 1 todo
```

The full suite without the holdout files is 2134 passed.

## What the replay fixtures cannot prove

- The pages, vendors and prices are synthetic, written to match the verifier's patterns. Real pages are messier;
  the calibration documents measure that separately.
- The provider markers are stand-ins. Exa search returns no per-result crawl marker, so against the real provider
  `confirmed_live` is unreachable today, and `unchanged_confirmed` and `changed` by re-observation never occur; the
  marker cases here show what the logic does if a provider ever reports one.
- The model is replayed: the "extraction" returns exactly the statement written for it and the "synthesis" returns
  exactly the sentences written for it. This shows the structural checks (verification, resolution, verdicts,
  withholding of unauthorised wording); it does not show what a real model would extract or write, nor how often.
- The entailment judge is a synthetic `supports` reply where it was needed.
- Time is a fixed clock advanced by hand; real clock skew, retries or concurrent turns are not exercised.
- Wording is checked with word lists. A paraphrase outside the lists would not be noticed by this oracle, the same
  limitation ADR-40 states for the system's own check.
- 55 tests are a small holdout. Passing them is evidence for the rules they exercise, not proof of correctness.
