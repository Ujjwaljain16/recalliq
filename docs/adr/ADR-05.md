# ADR-05: Retrieval: SQL, FTS5 and write-time enrichment; no embeddings

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner: "No embeddings unless evaluation demonstrates a material retrieval problem", 2026-11-11
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Index and triggers: `message_search`, `message_fts` and their sync triggers in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql); sync tested in [tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts).
- Retriever: [src/db/repositories/memory-retriever.ts](../../src/db/repositories/memory-retriever.ts) (date interval first, then FTS5 `bm25` within it). Write-time enrichment (search rows, tags, decisions): [src/db/repositories/enrichment.ts](../../src/db/repositories/enrichment.ts), written inside the completion transaction, with the model output built in [src/orchestration/prepare.ts](../../src/orchestration/prepare.ts). Disambiguation: [src/memory/recall.ts](../../src/memory/recall.ts) and the recall lanes.
- Tested end to end on the real write path by [tests/integration/db/memory-recall.test.ts](../../tests/integration/db/memory-recall.test.ts) and [tests/integration/orchestration/topical-recall.test.ts](../../tests/integration/orchestration/topical-recall.test.ts).
- No retrieval quality has been measured. The 90 % recall@5 threshold in the architecture is a proposed trigger, not a result.

## Revisit when

- An evaluation set shows paraphrase recall below the agreed threshold. Then add vectors behind the retrieval port, vendoring any model at install time.
