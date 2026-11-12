# ADR-37: Locale as a dimension of the belief key

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-12: canonical BCP-47 locale in the key, `und` when unknown, different locales incomparable
- **Recorded:** 2026-11-11, updated 2026-11-12
- **Related:** [ADR-21](ADR-21.md), [ADR-36](ADR-36.md), [Q-001](../questions.md)

## Context

The key had no locale. The same plan sold at different prices in different regions mapped to one key, and the "comparable locale" condition of ADR-36 could not be evaluated.

## Options considered

- Leave the key as is and record regional pricing as a limitation.
- Add `locale` to the key.

## Decision

Locale is part of the key and of pricing comparability.

- `PriceBeliefKey.locale` is a canonical BCP-47 tag as produced by `Intl.getCanonicalLocales` (for example `en-GB`), or `und` when it cannot be determined. Regional distinctions are preserved.
- It is derived by code from the source URL (path segment, subdomain or query), never by the model, and never from currency.
- The encoding gains `|loc=<locale>` after `cur=`; the key version stays 1 because no belief key has ever been stored.
- `keyForEvidence` takes `{ domain, urlNorm }` instead of a domain.
- `comparableKeys` returns `different` for different locales, including `und` against a known locale.
- An `und` locale cannot independently establish a positive `changed` verdict (ADR-36).

## Consequences and trade-offs

- Applied to the shared type ([src/shared/belief.ts](../../src/shared/belief.ts)) and to contracts §2 on 2026-11-12; the encode, decode and comparison functions are implemented.
- No SQL change: the key is a TEXT column and its decoded JSON is a TEXT column. No stored data needs converting; beliefs are derived and rebuildable ([ADR-35](ADR-35.md)).
- Pages with no detectable locale are keyed `und`: they are comparable with each other as keys, but can never support `changed` by bracketing.
- Detecting a locale from a URL misses locales set by cookies or IP address.

## Evidence and implementation references

- [src/belief/belief-key.ts](../../src/belief/belief-key.ts) and [src/belief/locale.ts](../../src/belief/locale.ts), tested by [tests/unit/belief/belief-key.test.ts](../../tests/unit/belief/belief-key.test.ts): encode and decode round trip, canonical locale, `und` for ambiguous or contradicting signals, different locales incomparable. Two different regional pages that are both `und` share a key and can be reported as contested; that is a known limitation. Whether the search provider's crawler location changes the prices it sees is undocumented and unmeasured (U17).

## Revisit when

- After the U17 spot check of regional prices.
