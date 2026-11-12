# ADR-43: Quick sourced answer first

- **Status:** Proposed
- **Implementation:** implemented
- **Decided:** Owner direction, 2026-11-12 (awaiting acceptance)
- **Recorded:** 2026-11-12
- **Related:** [ADR-38](ADR-38.md), [ADR-40](ADR-40.md), [ADR-42](ADR-42.md)

## Context

Measured live, a price or comparison turn took 18 to 26 seconds before any answer text appeared, because the answer stage started only after search, page extraction and verification had all finished. A general question, which extracts nothing, took 5 to 10 seconds. For a turn that extracts, the sources are known about 5 seconds in, long before the findings; the reader waited for the slowest stage to see anything.

## Options considered

- **A single stream after everything (the previous behaviour).** Simplest and the most consistent answer, but the reader sees nothing for the length of extraction and verification.
- **Show the findings card first.** The `finding` events arrive when verification ends, so this saves nothing: it is the same wait, with a card instead of text.
- **Stream a sourced answer as soon as the search results are in, then the verified section (chosen).** Uses the sourced sentences of ADR-42 for the part that can be said from the pages alone, while extraction and verification run in parallel, and continues with the verified sentences when they are ready.
- **Let the verified synthesis start on partial findings.** Faster still, but findings are assembled per entity from beliefs, baselines and verdicts; a partial set could contradict the final one and would weaken ADR-38 and ADR-40.

## Decision

1. When a turn will extract, the research service calls an optional `onSourcesReady(sources)` once the first sources with content are stored and before extraction starts. It has already sent their `source` events; the final source list keeps those keys first, in that order, so citation numbers never change. The coordinator starts the quick section there and does not wait for it.
2. The quick section is one model call (`AnswerPipeline.quick`, prompt `quick.v1` in `src/llm/prompts/quick.ts`) that sees only the turn's source excerpts (the same excerpts, defusing and fencing as ADR-42) and the user's message, and writes 2 to 4 short sentences, each citing a source, with no findings and no change or comparison words. Its sentences pass the existing sourced-sentence validation unchanged (same-excerpt grounding, change words, links, length, empty sentences), through the same sentence assembler and release gate, with `kind: 'sourced'`. A sentence with no citation is withheld. One sentence written in code, "Here is what the sources say while I check the details.", is released with the first sentence that passes (sentence 0); when none passes there is no quick section and no such sentence.
3. Its budget is its own stage (`quick`: cap 8 seconds, reserve 13 seconds like search). It does not start with less than the compact threshold left, and it never emits an `error` or a compaction warning: it is optional and its failure is silent.
4. When the findings are ready the coordinator stops the quick section where it is (a sentence still being written is dropped), and the normal synthesis runs as before, with the released quick sentences added to its prompt as fenced, defused history data and an instruction to confirm, add or explicitly correct them and never to repeat or silently contradict them. If the quick section had released nothing, the turn is exactly the turn without it. If the verified synthesis fails, the answer keeps what it released (status `interrupted`) and the findings still arrive.
5. One assistant message, one numbering: the quick sentences, then any sentence written in code that depends on the findings, then the verified sentences continue the numbering; the stored text is their concatenation. Only verified sentences (a finding placeholder) can become assertions, so a quick sentence never becomes a belief or a baseline; acknowledgement is per sentence, so an acknowledgement that reached only the quick part presents no assertion, and a later audit finds no baseline from the undelivered verified sentences.
6. The quick section runs only in the research lane, with no sentence written in code that must open the answer (no recalled day, no "no record" opening), and only for plans that extract. Replay components leave it off (a fixture scripts the full answer, and a quick call would be a fixture miss); the end-to-end tests turn it on with a scripted quick call.

## Consequences and trade-offs

- The first answer text for a price or comparison turn arrives about when the search ends instead of when verification ends. It costs one more synthesis-model call per such turn, made concurrently with extraction.
- The quick section is lexical, like ADR-42: a correct number attached to the wrong plan can pass. It can state a value the verified section later contradicts (a promotional price on a page that verification treats differently); the verified section is told to correct such a sentence explicitly, but the model may not. The reader sees the quick sentences marked as quoted from their source, not verified.
- A quick section cut by the findings can end after fewer sentences than planned. A turn whose findings come first has none.
- The sentence that the verified synthesis writes about the same entity may repeat a quick sentence's content in other words; the prompt forbids repeating, and no code check enforces it beyond the existing duplicate-text rule.
- The audit lane has no quick section: its code-written opening sentences must come first.

## Evidence and implementation references

- Code: `src/orchestration/quick.ts`, `src/orchestration/orchestrator.ts`, `src/answer/pipeline.ts` (`quick`), `src/llm/prompts/quick.ts`, `src/llm/prompts/synthesis.ts` (continuation rules), `src/research/service.ts` (`onSourcesReady`, early `source` events), `src/orchestration/config.ts` (the `quick` stage).
- Tests: [quick-answer.test.ts](../../tests/integration/e2e/quick-answer.test.ts), [quick.test.ts](../../tests/unit/answer/quick.test.ts).
- Mutation checks, each made tests fail: a sourced sentence allowed to become an assertion; the grounding check skipped for the quick section; the verified synthesis not given the quick sentences; the numbering restarting after the quick section.

## Revisit when

- Live answers show the verified section contradicting quick sentences often, or readers confused by the two parts.
- The quick call's latency or cost is not worth the time it saves (for example if extraction becomes fast).
- Extraction can be streamed per entity, so the verified part can start earlier without the risk of partial findings.
