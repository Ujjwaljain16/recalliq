# ADR-37: Locale as a dimension of the belief key

- **Status:** Proposed
- **Implementation:** not implemented
- **Decided:** Pending review. Owner asked for the smallest contract change to be proposed, not applied
- **Recorded:** 2026-11-11
- **Related:** [ADR-21](ADR-21.md), [ADR-36](ADR-36.md), [Q-001](../questions.md)

## Context

The key has no locale. The same plan sold at different prices in different regions maps to one key, and the "comparable locale" condition of ADR-36 cannot be evaluated.

## Options considered

- Leave the key as is and record regional pricing as a limitation.
- Add `locale` to the key (proposed).

## Decision

None yet. The proposal: `locale` is a lower-cased language or language-region tag or `unspecified`, derived by code from the URL (path segment, subdomain or query), never by the model; encoded as `|loc=<locale>`; no SQL change.

## Consequences and trade-offs

- A contract change (not applied). Two observations of the same URL with unspecified locale are comparable; unspecified against a known locale is not.

## Evidence and implementation references

- The proposal is written in Q-001. Nothing is implemented. Whether the search provider's crawler location changes the prices it sees is undocumented and unmeasured (U17).

## Revisit when

- Review before the change detector is written.
