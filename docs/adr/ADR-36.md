# ADR-36: Stricter proof for a post-baseline change

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-11 (Q-001), the effective-date distinction, 2026-11-12, the definitions of source identity and comparability, approved 2026-11-12, and the observation definition, relaxed from a fresh-crawl requirement to a content as-of requirement on 2026-11-12
- **Recorded:** 2026-11-11, updated 2026-11-12
- **Related:** [ADR-22](ADR-22.md), [ADR-37](ADR-37.md), [Q-001](../questions.md)

## Context

A different current value does not prove it changed after the earlier answer. The earlier design allowed an observation up to 48 hours before the answer to count, or a stated effective date.

## Options considered

- The earlier same-source bracketing with a 48 hour tolerance, or a stated effective date.
- The stricter rule below.

## Decision

`changed` needs one of two proofs. A weaker comparison is not to be implemented.

1. **Re-observation bracketing.** All of:
   - an independent observation of the old value after the previous answer was presented (the baseline's own source fetch never counts);
   - a later observation of the new value;
   - matching source identity: the same `url_norm`, which keeps semantically meaningful query parameters and removes only tracking parameters;
   - comparable context: `comparableKeys === 'equal'` across every pricing dimension, including locale;
   - a known locale: an unknown locale (`und`) cannot independently establish `changed`.
2. **Explicit effective date.** An effective date that is explicitly associated with the new price, from a reliable source (tier A1 or A2), later than the previous answer, with a known locale (an unknown locale cannot independently establish `changed` by either route). A publication date or a fetch date alone never establishes timing; a fresh fetch never sets an effective date.

An **observation** is an immutable, timestamped source snapshot that (1) was successfully retrieved after the relevant event (the previous answer for the old value, the old-value observation for the new value), with its retrieval timestamp (`observed_at`) recorded independently of the source's publication or modification timestamps; (2) keeps any cache metadata and age the provider reports; and (3) has content sufficient to support the specific pricing claim (a validated `pass` statement). A provider-cached copy can be an observation. **A fresh retrieval is not necessarily fresh source content:** a cached result establishes what the provider returned at a particular time, not that the underlying source had that value at that time. So each observation also needs a **content as-of time**: `observed_at` when the provider reports a successful live crawl (`fresh_fetch` and `crawl_status = ok`); otherwise the provider's last-updated time when it gives one (the conservative choice: the earlier time); otherwise unknown. If the as-of time cannot be established, the observation cannot support a positive `changed` verdict. For the proof, the old-value observation's retrieval and as-of times must both be later than the previous answer, and the new-value observation's must be later than the old-value observation's. This introduces no crawler: it only reads what the search provider returned. Whether the contract can hold a provider-reported cache age or capture time is open: Q-019.

If neither proof can be established, the verdict is `differs_timing_unknown`. The 48 hour window is removed.

## Crawl basis: four recorded states (2026-11-12)

Each search result and each snapshot records a `crawl_basis` with exactly four distinct states:

| State | Meaning | Set from |
|---|---|---|
| `confirmed_live` | The provider reported, for this result, that a live crawl succeeded | A per-result provider marker only. A successful HTTP response or a `maxAgeHours: 0` request never sets it. Exa search returns no such marker, so the Exa adapter never produces it for real responses |
| `requested_live` | A live crawl was requested (`maxAgeHours: 0`) and the content is sufficient | The request plus the sufficiency rule below |
| `cached` | The request allowed cached content, or the provider marked the result cached | The request (no `maxAgeHours: 0`) or a per-result cached marker |
| `unknown` | Anything else, including a live request whose content is too short or too thin, and a failed crawl | Default |

`fresh_fetch` keeps its exact meaning and equals `crawl_basis = 'confirmed_live'`. **`requested_live` is recorded and reported, but it is not confirmation**: it changes no belief status, no `displayedAt` and no detector verdict, and it cannot independently establish confirmed current pricing, `changed` or `unchanged_confirmed`. The proof semantics above, the content as-of rule and the effective-date requirement are unchanged. The state is shown in a finding's `current.crawlBasis` so the wording can say a result rests on a requested but unconfirmed live crawl.

**Content sufficiency rule.** A text-mode result of a live request is sufficient when its trimmed length is at least 400 characters and at least `min(ceil(0.5 × requested budget), 1,500)` characters, and it is either structured (at least one heading or table found by `parseSourceStructure`) or at least 1,200 characters long. Highlights-mode results are never sufficient, because their length says nothing about whether a crawl finished. The rule exists because a live crawl that does not finish is not reported: the provider answers HTTP 200 with no error and no marker, and the text is silently short (observed: 87, 131 and 186 characters for a 1,500-character budget, all of which fail the rule). It can only make a result `unknown`; it never upgrades one. It lives in [src/search/crawl-basis.ts](../../src/search/crawl-basis.ts).

## Consequences and trade-offs

- The baseline's own observation precedes its presentation, so the first audit that sees a different price will usually be `differs_timing_unknown` unless an explicit effective date is stated. `changed` by bracketing needs a re-observation of the old value after the answer, so the demo recordings must include one.
- Cached results with no usable content as-of time never support `changed`, so a provider that mostly returns cached pages with no dates will mostly give `differs_timing_unknown`.
- Pages whose locale cannot be determined never yield `changed` by bracketing, which gives more `differs_timing_unknown` on vendors with a single global page.
- Added later: both proofs need the baseline evidence and the current evidence to be tier A1, A2 or B (the low-authority gate, architecture §8, reason `low_authority_source`). Without an owner registry, re-observation bracketing on unlisted pages therefore gives `differs_timing_unknown`, never `changed`. See [security.md](../security.md).
- Architecture §8, scenarios 2 and 3, the scenario matrix and open items U12 and U19 were corrected on 2026-11-12; the old text is kept there as history. The contract's reason values (`same_source_bracketing`, `stated_effective_date`) still fit and are unchanged.

## Evidence and implementation references

- [src/belief/detector.ts](../../src/belief/detector.ts) and [src/belief/as-of.ts](../../src/belief/as-of.ts), tested by [tests/unit/belief/detector.test.ts](../../tests/unit/belief/detector.test.ts) and [tests/unit/belief/as-of.test.ts](../../tests/unit/belief/as-of.test.ts): both proofs, the baseline's own fetch, a snapshot exactly at the answer time, a different `url_norm`, a different or unknown locale, cached copies with and without a last-updated time, a new-value as-of not later than the old one, weak statements, and the effective-date cases. Tested with synthetic evidence only; nothing here has seen a real provider response.

## Revisit when

- The change detector is written, Q-019 is settled, or real pages show that the as-of requirement or the `und` rule gives mostly `differs_timing_unknown`.
