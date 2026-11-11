# ADR-36: Stricter proof for a post-baseline change

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner decision, 2026-11-11 (Q-001), the effective-date distinction, 2026-11-12, and the definitions of observation, source identity and comparability, approved 2026-11-12
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

An **observation** is an immutable, timestamped source snapshot with sufficient content and a validated supporting pricing statement. "Sufficient content" is implemented strictly as a successful fresh crawl (`fresh_fetch` and `crawl_status = ok`); this is the orchestrator's reading and is stricter than the wording approved.

If neither proof can be established, the verdict is `differs_timing_unknown`. The 48 hour window is removed.

## Consequences and trade-offs

- The baseline's own observation precedes its presentation, so the first audit that sees a different price will usually be `differs_timing_unknown` unless an explicit effective date is stated. `changed` by bracketing needs a re-observation of the old value after the answer, so the demo recordings must include one.
- Pages whose locale cannot be determined never yield `changed` by bracketing, which gives more `differs_timing_unknown` on vendors with a single global page.
- Architecture §8, scenarios 2 and 3, the scenario matrix and open items U12 and U19 were corrected on 2026-11-12; the old text is kept there as history. The contract's reason values (`same_source_bracketing`, `stated_effective_date`) still fit and are unchanged.

## Evidence and implementation references

- A recorded owner decision only. Nothing is implemented or tested; the change detector is milestone 4.

## Revisit when

- The change detector is written, or real pages show that the strict fresh-crawl reading or the `und` rule gives mostly `differs_timing_unknown`.
