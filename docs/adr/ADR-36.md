# ADR-36: Stricter proof for a post-baseline change

- **Status:** Accepted
- **Implementation:** not implemented
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
2. **Explicit effective date.** An effective date that is explicitly associated with the new price, from a reliable source (tier A1 or A2), later than the previous answer. A publication date or a fetch date alone never establishes timing; a fresh fetch never sets an effective date.

An **observation** is an immutable, timestamped source snapshot that (1) was successfully retrieved after the relevant event (the previous answer for the old value, the old-value observation for the new value), with its retrieval timestamp (`observed_at`) recorded independently of the source's publication or modification timestamps; (2) keeps any cache metadata and age the provider reports; and (3) has content sufficient to support the specific pricing claim (a validated `pass` statement). A provider-cached copy can be an observation. **A fresh retrieval is not necessarily fresh source content:** a cached result establishes what the provider returned at a particular time, not that the underlying source had that value at that time. So each observation also needs a **content as-of time**: `observed_at` when the provider reports a successful live crawl (`fresh_fetch` and `crawl_status = ok`); otherwise the provider's last-updated time when it gives one (the conservative choice: the earlier time); otherwise unknown. If the as-of time cannot be established, the observation cannot support a positive `changed` verdict. For the proof, the old-value observation's retrieval and as-of times must both be later than the previous answer, and the new-value observation's must be later than the old-value observation's. This introduces no crawler: it only reads what the search provider returned. Whether the contract can hold a provider-reported cache age or capture time is open: Q-019.

If neither proof can be established, the verdict is `differs_timing_unknown`. The 48 hour window is removed.

## Consequences and trade-offs

- The baseline's own observation precedes its presentation, so the first audit that sees a different price will usually be `differs_timing_unknown` unless an explicit effective date is stated. `changed` by bracketing needs a re-observation of the old value after the answer, so the demo recordings must include one.
- Cached results with no usable content as-of time never support `changed`, so a provider that mostly returns cached pages with no dates will mostly give `differs_timing_unknown`.
- Pages whose locale cannot be determined never yield `changed` by bracketing, which gives more `differs_timing_unknown` on vendors with a single global page.
- Architecture §8, scenarios 2 and 3, the scenario matrix and open items U12 and U19 were corrected on 2026-11-12; the old text is kept there as history. The contract's reason values (`same_source_bracketing`, `stated_effective_date`) still fit and are unchanged.

## Evidence and implementation references

- A recorded owner decision only. Nothing is implemented or tested; the change detector is milestone 4.

## Revisit when

- The change detector is written, Q-019 is settled, or real pages show that the as-of requirement or the `und` rule gives mostly `differs_timing_unknown`.
