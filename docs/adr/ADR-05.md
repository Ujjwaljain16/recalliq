# ADR-05: Retrieval: SQL, FTS5 and write-time enrichment; no embeddings

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner: "No embeddings unless evaluation demonstrates a material retrieval problem", 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-04](ADR-04.md), [ADR-07](ADR-07.md)

## Context

The hardest lookups are by date and entity, which are exact filters; candidate sets after a date filter are tiny. Embeddings would need a second API or a runtime model download.

## Options considered

- Vector retrieval.
- Hybrid vectors plus FTS.
- SQL, FTS5 and write-time enrichment.

## Decision

SQL, FTS5 and write-time enrichment. Candidates (at most eight) are disambiguated by the analysis call or by asking the user.

## Consequences and trade-offs

- Paraphrased topics may be missed by keyword search.
- Enrichment must be written at persist time.

## Evidence and implementation references

- Implemented: `message_search`, the `message_fts` index and its sync triggers in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql); sync tested in [tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts).
- Not implemented: the retriever, the enricher, and the candidate ranking (milestone 3). `complete()` rejects enrichment until then (Q-014).
- No retrieval quality has been measured. The 90 % recall@5 threshold in the architecture is a proposed trigger, not a result.

## Revisit when

- An evaluation set shows paraphrase recall below the agreed threshold. Then add vectors behind the retrieval port, vendoring any model at install time.
