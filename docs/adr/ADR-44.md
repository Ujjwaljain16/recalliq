# ADR-44: Work out of the box: exact-name domains are official, a requested live crawl is current

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-12, after a live check of the self-audit flow
- **Recorded:** 2026-11-12
- **Related:** [ADR-36](ADR-36.md), [ADR-38](ADR-38.md), [docs/security.md](../security.md), [docs/running.md](../running.md)

## Context

A live run on a fresh install (no official-domain registry) showed two strict rules working together to switch
off the product's main feature:

1. Without a registry, nothing was official, so Supabase's own pricing page on supabase.com counted as an
   unofficial (tier C) page. Its prices were extracted correctly but never verified, and the answer said "I could
   not confirm a price through my checks" while quoting supabase.com.
2. Exa never confirms per result that a live crawl happened. Only a confirmed fresh fetch dated a price, so every
   price was "last seen date unknown" (stale). A stale finding is never an eligible baseline (ADR-38), so asking
   "Is the Supabase price you gave me still correct?" could never compare against the earlier answer, even with a
   registry.

Both rules are right in principle and both were deliberate. Together they meant a reviewer could never see an
audit of an earlier answer.

## Options considered

- **Keep both rules strict.** Fully conservative, but on a fresh install the agent cannot verify any vendor price
  and can never audit its own earlier answer.
- **Ship a list of vendor domains.** Rejected: the owner chose not to commit real-vendor domain lists, and a list
  only covers the vendors someone thought of.
- **Fetch each result page ourselves to get a confirmed fresh fetch.** Rejected for now: it adds a second tool
  beside web search, and server-side fetching of arbitrary URLs needs its own SSRF defences.
- **Exact-name domains plus requested crawls as current (chosen),** keeping every rule about timing a change.

## Decision

1. **Exact-name domains are official.** When the registry has no entry for an entity, a domain that is exactly
   its one-word name (letters and digits, at least four) on a common company ending (`.com`, `.io`, `.ai`, `.dev`,
   `.app`, `.co`, `.tech`, `.so`), and its subdomains, count as official and owned: supabase.com for Supabase,
   pipedrive.com for Pipedrive. Look-alikes (`supabase-deals.com`, `supabasepricing.com`), other endings, and
   multi-word names ("Zoho CRM") are not matched. A registry entry for the name replaces the guess. Code:
   `nameDomains` in [src/app/live/registry.ts](../../src/app/live/registry.ts).
2. **A requested live crawl dates the content.** A snapshot whose crawl basis is `requested_live` (a live crawl was
   requested and enough content came back, [src/search/crawl-basis.ts](../../src/search/crawl-basis.ts)) gets
   `displayedAt = observedAt`, so a recent price can be current and an answer built on it can be a baseline. Its
   `displayedAtBasis` stays `unknown` and it is not a fresh fetch. Code: `timeFields` in
   [src/evidence/verifier.ts](../../src/evidence/verifier.ts).

**What does not change.**

- "Changed" still needs ADR-36's proof: the old value re-observed after our answer by a confirmed fresh fetch, or
  an effective date on the page. A requested crawl can support "no sign of a change" or "differs, timing
  unknown", never "changed on <date>". `unchanged_confirmed` still needs an A1 fresh fetch.
- Tier C pages (unlisted, not the exact name) still cannot produce a change or confirmation verdict.
- A routing gap found in the same run was fixed alongside: "is the price you gave me still correct?" hinted as
  research now goes to the audit lane ([src/orchestration/routing.ts](../../src/orchestration/routing.ts)).

## Consequences and trade-offs

- A company whose exact name on one of these endings belongs to someone else would have that site treated as
  official (linear.com is not Linear's site; linear.app is). A registry entry fixes it for that name. This is a
  real weakening of the "an unknown page must not manufacture a change" rule, accepted so the agent verifies
  vendor prices with no setup; it still cannot manufacture a *timed* change.
- If Exa served cached content despite the live request, a price would be dated later than the page really was.
  The effect is limited to calling an old value current, which the next fresh observation corrects.

## Evidence and implementation references

Live check, 2026-11-12: before the change, "Is the Supabase price you gave me still correct?" routed to research and found no baseline. Tests: [tests/unit/app/official-domains.test.ts](../../tests/unit/app/official-domains.test.ts),
[tests/unit/evidence/subject-ownership.test.ts](../../tests/unit/evidence/subject-ownership.test.ts) (T-EV-OWN-42),
[tests/unit/belief/crawl-basis.test.ts](../../tests/unit/belief/crawl-basis.test.ts),
[tests/unit/orchestration/routing-planner.test.ts](../../tests/unit/orchestration/routing-planner.test.ts).

## Revisit when

- A search provider reports per-result crawl confirmation: use it instead of the requested-crawl rule.
- A reviewed official-domain registry flow exists: the exact-name guess can become its fallback only.
