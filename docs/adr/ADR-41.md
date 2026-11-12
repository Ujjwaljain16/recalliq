# ADR-41: Registered domain ownership as subject-binding evidence

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-12
- **Recorded:** 2026-11-12
- **Related:** [ADR-11](ADR-11.md), [ADR-21](ADR-21.md), [ADR-37](ADR-37.md)

## Context

Subject binding (architecture R2) lets a price belong to an entity only when the entity's name appears in the price's own line or in its associated header. A page title, a URL or a domain never binds a subject. The rule closes the comparison-article path, where a competitor's price is read as the vendor's. Its cost showed on real pricing pages: price cards and tables head their rows with plan names and never repeat the vendor's name, so a perfect extraction of a vendor's own pricing page stays `weak` on `subject_binding` (calibration gap 1). The owner can say which domains belong to which vendor (`OFFICIAL_DOMAINS_FILE`); until now that knowledge only raised an authority tier.

## Options considered

- Keep the rule as it is and accept the weak rate.
- Treat any page on an official domain as the vendor's and bind every price on it. Rejected: official domains also hold comparison pages, integration pages, partner listings, customer stories and embedded content, and a domain the application merely carries from an earlier source is not owner evidence.
- Bind a price by ownership only when the price is tied to the vendor's own offering and nothing on or above it points elsewhere (chosen).

## Decision

1. **Explicit ownership.** A domain that the owner's registry explicitly maps to an entity makes the entity the publisher of a page on that domain (the host, or a subdomain of it). The application supplies these as `EntityContext.ownedDomains` (an optional, additive field). They come from the registry only: never a name match, never a model's guess, never a domain the entity row merely carries, and never a domain listed for two entities or carried by another entity in the same run. `officialDomains` keeps its meaning and its other sources.
2. **Page level only.** Ownership says who published the page. It binds a price only when all of these hold: the page is clearly presenting pricing (a pricing path or host, or a title or heading naming pricing or plans); the price is tied to a plan or product of the vendor, which means the existing plan binding passed with a plan named in the quote or its associated header; the claimed unit and billing period also hold against the whole quote when a cue sits on another line; and no blocker fires.
3. **Blockers.** Deterministic, on the page title, the quote, its context and up to 1,500 characters of the page above the quote:
   - comparison: vs, versus, comparison, compared to or with, alternative(s) to, switch from, instead of, better than, competitors (the navigation label "compare plans" is not a comparison);
   - integration and third-party: integrates with, integration, connector, marketplace, powered by, built on, add-on from, third-party, plug-in;
   - partner, reseller and agency listings;
   - testimonial and quoted material: quotation marks around a sentence that holds the number, said, says, testimonial, customer story, case study, review, according to;
   - embedded external content;
   - any known other entity alias (`otherEntityAliases`);
   - a price list that names another organisation (a capitalised phrase before "pricing", "price list" or "plans" with a word that is neither generic, nor part of the vendor's name or plans).
   When a blocker fires the subject binding stays `weak`, exactly as without a registry.
4. **Provenance stays visible.** The vendor's name is never inserted into the quote or the context. The check result says plainly that the subject was bound by registered domain ownership and not by the quote: "subject bound by registered domain ownership, not by the quote: page published by the registered owner of acme.example; price tied to plan pro".
5. **Nothing else changes.** Plan binding, currency, unit, billing period, the conditional, promotional and planned cues, negation, historical and the T0 and T1 checks are untouched. A registered-domain claim of "$35/month (annual)" as `monthly` still fails the billing period while the subject passes. Unknown or conflicting ownership gives the behaviour of an unregistered page.

## What is not claimed

- It does not make every price on the domain the vendor's. It binds a subject for a plan-tied price on a page that presents pricing, and nothing more.
- The blockers are a conservative, deterministic backstop, not a semantic detector. They are keyword and pattern checks: they will miss a comparison or a testimonial phrased without a cue, and they will block legitimate pages that contain a cue word (an "Integrations" menu above a price list, for instance). A blocked price stays `weak`, which is the safe direction.
- Ownership is only as good as the registry. A wrong entry would bind a subject wrongly; the registry is the owner's.

## Consequences and trade-offs

- With no registry nothing changes. With one, more of a vendor's own pricing claims reach `pass`; the calibration oracle measures the effect (see [extraction-calibration.md](../extraction-calibration.md)).
- The architecture's sentence "the snapshot title, URL and domain never establish the subject" gains one narrow exception, noted in architecture R2. A title, a URL or an unregistered or merely official domain still establishes nothing.
- `EntityContext` and the resolved-context entity type each gain an optional field; the registry step sets it; the research service passes it through.

## Evidence and implementation references

- Verifier: `src/evidence/verifier.ts` (`registeredOwner`) and `src/evidence/ownership.ts` (host ownership, pricing-page test, blockers).
- Registry step: `OfficialDomains.apply` in `src/app/live/registry.ts` sets `ownedDomains` from the registry only.
- Tests: [subject-ownership.test.ts](../../tests/unit/evidence/subject-ownership.test.ts) (attribution, every blocker, conflicting and missing ownership, plan requirement, competitor attribution, the annual-as-monthly case) and [subject-ownership-calibration.test.ts](../../tests/unit/evidence/subject-ownership-calibration.test.ts) (the oracle with and without a registry, and every labelled trap).
- Evaluation: `scripts/extraction-eval.ts --registry <file>`; [subject-ownership-eval.test.ts](../../tests/integration/evidence/subject-ownership-eval.test.ts).
- Mutation checks (ownership ignored, plan requirement removed, each blocker removed, conflicting ownership treated as owned) each fail a test.

## Revisit when

- A real page is found where a blocker misses a third party's price, or where one blocks the vendor's own price often enough to matter.
- The registry is populated from more than the owner's explicit entries.
