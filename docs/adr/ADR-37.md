# ADR-37: Locale as a dimension of the belief key

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner decision, 2026-11-12: locale is a required pricing-comparability dimension. The typed-key encoding below is the recorded proposal; the contract text is not yet edited
- **Recorded:** 2026-11-11, updated 2026-11-12
- **Related:** [ADR-21](ADR-21.md), [ADR-36](ADR-36.md), [Q-001](../questions.md)

## Context

The key has no locale. The same plan sold at different prices in different regions maps to one key, and the "comparable locale" condition of ADR-36 cannot be evaluated.

## Options considered

- Leave the key as is and record regional pricing as a limitation.
- Add `locale` to the key.

## Decision

Locale is part of price comparability. The recorded change to the typed key:

- `PriceBeliefKey` gains `locale: string`, a lower-cased language or language-region tag, or `unspecified`;
- it is derived by code from the URL (path segment, subdomain or query), never by the model;
- the encoding gains `|loc=<locale>`;
- `keyForEvidence` needs the source URL as well as the domain, so its second argument becomes `{ domain, urlNorm }`;
- `comparableKeys` treats two keys that differ only in locale as `different`, and `unspecified` against a known locale as not comparable.

## Consequences and trade-offs

- A change to contracts §2 (the type, the encoding comment, the `keyForEvidence` signature) and to the belief-key tests. It is **not applied**: the contract text is unchanged, and the edit belongs with the first milestone that writes belief keys. No SQL change: the key is a TEXT column and its decoded JSON is a TEXT column.
- No belief rows exist yet, and beliefs are derived and rebuildable ([ADR-35](ADR-35.md)), so no stored data needs converting. If keys had been stored, the encoding version would have to change.
- Pages with no detectable locale all get `unspecified` and stay comparable with each other. The price is that "unspecified against known" gives `differs_timing_unknown` in the change proof, never `changed`.
- Detecting a locale from a URL will miss locales set by cookies or IP address.

## Evidence and implementation references

- The proposal is written in Q-001. Nothing is implemented or tested. Whether the search provider's crawler location changes the prices it sees is undocumented and unmeasured (U17).

## Revisit when

- Contracts §2 is next edited, before the belief key code is written (milestone 4), and after the U17 spot check.
