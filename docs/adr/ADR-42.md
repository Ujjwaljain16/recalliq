# ADR-42: Verified and sourced statements

- **Status:** Proposed
- **Implementation:** implemented
- **Decided:** Owner direction, 2026-11-12 (awaiting acceptance)
- **Recorded:** 2026-11-12
- **Related:** [ADR-38](ADR-38.md), [ADR-40](ADR-40.md)

## Context

Measured live with the real model and search provider, the assistant answered almost nothing useful outside verified prices. A question with no company in it ("what is new in a runtime", "who won the last race") was answered with "Which company or product should I look into?" and no search, because the planner only planned per entity. A price question whose evidence failed subject binding took 13 to 33 seconds and then said only "no verified price was found". The cause was in the answer stage: the synthesis model received placeholders and source ids, never what the sources said, and its first rule forbade it from writing any number. Whatever was not a verified finding could only come out empty. The persona ("a research assistant that tracks prices and product releases") also made conversational answers vague.

## Options considered

- **Keep withholding.** Only verified findings carry facts. Safe, but the assistant cannot answer general questions and says nothing useful when verification fails, which is most real pricing pages without an owner registry.
- **Let the model speak freely from the sources.** Fast and fluent, but nothing would stop a misread or invented number, and nothing would separate a quoted page from a verified fact: the guarantees of ADR-38 and ADR-40 would erode in practice.
- **LLM-judged grounding.** A second model checks each sentence against its sources. It adds a model call and latency to every sentence, its verdicts are not deterministic or testable offline, and a page that carries instructions could talk to the judge as well as to the writer.
- **Two kinds of statement with a deterministic grounding check (chosen).** Verified statements stay exactly as they are. Sourced statements are allowed, but only with a citation of a source of this turn, and only after code has found every number and every name they state in the excerpt they cite.

## Decision

1. **Verified statements** are unchanged: findings rendered by code through `[[F..]]` placeholders. They alone become assertions, beliefs and baselines (ADR-38 requires an F placeholder), and they alone may speak about change, through verdict placeholders (ADR-40). T0 to T3, the belief resolver, the change detector, baseline eligibility and the change-language policy are not weakened.
2. **Sourced statements** are sentences the model writes from the source excerpts it was shown. A sentence is sourced when it cites at least one source and renders no finding. It is released only when:
   - every cited id is a server-minted id of a source shown with an excerpt in this turn (fail closed otherwise, also for an id copied from history);
   - it contains no link and no email address, quotes at most 200 characters, and the answer's sourced sentences quote at most 1,200 in all;
   - ONE cited excerpt contains every number (amounts by currency and value, versions exactly, percentages, years, dates by their stated parts, other numbers after removing thousands separators and zero decimals, numbers in words literally) and every capitalised name it states, except a common first word, a word of the user's message and a word of an entity's name or alias. Both sides are normalised the same way and nothing is folded: full-width digits and currency signs never match ASCII ones;
   - T3a passes, with its change and comparison word rules applied exactly as to any other sentence.
   A sourced sentence that names none of its sources is opened in code with "According to <domain>: ". It never becomes an assertion, belief, baseline or verdict. A sentence with a number and no citation is withheld as before.
3. **The model sees the sources.** Per source of the turn: id, domain, title, provider publication date and an excerpt (at most 6 sources, 1,200 characters each, 8,000 in all, sources matching the query terms first), with links, emails and markdown removed and the text defused. History is defused and fenced as data, never sent as conversation turns. The excerpt shown is exactly the text the check uses.
4. **General research path.** With no entity, the analysis queries are searched without an entity (at most 3, 5 results, cached highlights), and general specs are never extracted: search and synthesis only. The clarifying question remains only for a turn with neither an entity nor a query.
5. **Visible difference.** The stored sentence and the `answer.sentence_end` and `answer.completed` events carry an optional `kind` (`verified` or `sourced`), and the client marks a sourced sentence as quoted from its source, not independently verified.

## Consequences and trade-offs

- General questions get answers with citations, and a failed verification can still tell the user what the page says, clearly attributed and never presented as verified.
- General turns make no extraction call, which removes the slowest stage from them.
- The grounding check is lexical. It cannot tell that a number belongs to the right thing: a correct price attached to the wrong plan passes when both occur in the same excerpt. It does not detect negation ("Pro is not $20"), paraphrased claims without numbers or capitalised names, or lower-case content words. The same-excerpt rule refuses an honest sentence that combines two sources.
- Change words stay governed by T3a as they are: in a turn with findings the broad lexicon applies, so a sourced sentence such as "the runtime ships a test runner" is withheld there; in a general turn only the core list applies.
- Quoted text is capped, so long explanations from a page are cut down to short attributed sentences.

## Evidence and implementation references

- Grounding: `src/answer/grounding.ts`; sourced checks and attribution: `src/answer/sourced.ts`; excerpts and page sanitising: `src/answer/excerpts.ts`; assembly: `src/answer/assembler.ts`; prompt: `src/llm/prompts/synthesis.ts` (`synthesis.v5`, `defuse`).
- Planning and research: `src/orchestration/planner.ts`, `src/research/service.ts`, `src/research/turn-sources.ts`.
- Tests: [grounding.test.ts](../../tests/unit/answer/grounding.test.ts), [sourced.test.ts](../../tests/integration/answer/sourced.test.ts), [defuse.test.ts](../../tests/unit/llm/defuse.test.ts), [excerpts.test.ts](../../tests/unit/answer/excerpts.test.ts), [planner-general.test.ts](../../tests/unit/orchestration/planner-general.test.ts), [grounded.test.ts](../../tests/integration/e2e/grounded.test.ts).
- Mutation checks, each made a test fail: grounding skipped; numbers compared against any source of the turn; cross-excerpt union allowed; change words skipped for sourced sentences; extraction not skipped on general intent; a sourced sentence stored as an assertion; spaced fence tags not defused; full-width look-alikes not folded; a sentence with a URL released.

## Revisit when

- Live answers show the same-excerpt or name rule withholding many correct sentences, or a lexical pass that is wrong (a number bound to the wrong subject) is seen in practice.
- A deterministic association between a number and its subject inside an excerpt (as T2 does for verified evidence) becomes affordable for sourced sentences.
