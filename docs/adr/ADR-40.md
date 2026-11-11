# ADR-40: Factual sentences are released only after validation

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner decision, 2026-11-12
- **Recorded:** 2026-11-12
- **Related:** [ADR-16](ADR-16.md), [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md), [ADR-38](ADR-38.md)

## Context

ADR-16 streamed every sentence immediately and let later checks only downgrade it. A model that writes "The current plan costs $100/month" in free text would show that claim in the browser before the free-text check could flag it. The system's promise is that it knows the difference between what it generated, what it told someone, and what the evidence establishes, and that difference has to hold in the browser.

## Options considered

- Stream raw text and downgrade later (ADR-16).
- Buffer the whole answer.
- Stream tokens, hold back only from the first risky token, and retract the sentence if it fails.
- Release one validated sentence at a time (chosen).

## Decision

Three states, kept distinct everywhere:

- **received**: text that has arrived from the model. It is held inside the answer pipeline, never sent to the browser, never stored.
- **validated**: a sentence that passed placeholder authorisation, rendering, the render-integrity check, the free-text check and, where it applies, the judge.
- **presented**: a released sentence that the browser acknowledged as rendered (ADR-23).

Rules:

1. Only validated sentences are sent. The unit of release is the sentence, not the token, because a sentence can become factual halfway through. A sentence is sent as one `answer.delta` carrying its complete rendered text, followed by `answer.sentence_end`; the client may animate it. Narrative sentences with no placeholders and no risky free text pass at their end and are not delayed further.
2. A sentence that fails any check is **withheld**: it is not sent and not stored, it consumes no sentence index, and a `sentence_withheld` warning names the issue codes.
3. A sentence that needs the judge waits for it, within the judge's time cap. With no result by then it is withheld, not sent as "unchecked".
4. If the stream is interrupted, the incomplete trailing sentence is never sent. `streamed_through` counts only sent sentences, and the stored message contains only sent text.
5. If every sentence is withheld, the orchestrator writes its own deterministic reply; the model's text is not used.
6. `unverified`, `unchecked` and `truncated` stay in the type. The answer pipeline no longer produces them for text it sends; they remain for a defect found after release, which is reported by a `verification` event and is never presented as verified.

## Change language

The safety boundary for statements about change is **structural**, not lexical. Rules, enforced by the free-text check of the answer pipeline (`src/answer/t3a.ts`):

1. A finding's internal `changed` status, or a plain current-value placeholder `[[F3]]`, never authorises language about a change over time or a comparison.
2. Every sentence that contains such language must carry, in the same clause, a `[[F3:verdict]]` or `[[F3:baseline]]` placeholder of the finding the words are about, and that finding's verdict must fit the words, strictly:
   - `changed` permits only wording consistent with the proven change and its direction (an up change does not permit down wording), and wording that implies a time or window (`since`, `recently`, `last week`) only when the finding carries a window or an effective date;
   - `differs_timing_unknown` permits only neutral wording that the values differ and the timing is unknown, never raised, cut, jumped, rose, fell, went up, now costs more, used to, previously or similar;
   - `unchanged_confirmed` permits only unchanged or same-price wording; `no_evidence_of_change` only the no-sign-of-change wording; `baseline_incorrect` only was-wrong or out-of-date wording;
   - contested, unable_to_verify, stale and unknown findings authorise no definitive change claim;
   - historical wording (`used to`, `previously`, `formerly`, `no longer`) needs a verdict that proves a change.
3. Findings cannot borrow each other's verdicts. A word attaches to the finding whose placeholder is in its own clause (a clause ends at `;`, `and`, `but`, `while`, `whereas`, `which`), or to the sentence's only finding. Several findings in one clause, no finding to attach to, or a plural reference (`both`, `they`) over several findings is ambiguous and the sentence is withheld.
4. A comparison across findings (`cheaper than`) is decided by the judge and never authorises a temporal word.
5. The synthesis prompt states the same rule (prompt version `synthesis.v3`): free text must not describe changes.

**Limitation, stated plainly.** The word lists (the original phrase families and a broader lexicon of change verbs, comparatives and timing words, matched after normalising case, spacing, look-alike characters and hyphenation) are a backstop. They are not a complete natural-language semantic detector: a paraphrase outside the lists can pass, and a harmless sentence that uses a listed word (for example "you can change plans") is withheld. The verdict-placeholder requirement and the prompt are the boundary; the lists only catch the wording they know. The corpus in `tests/unit/answer` records known false positives and known false negatives.

## Consequences and trade-offs

- No token-by-token typing: the first visible text arrives when the first sentence is validated.
- Answers can be shorter than what the model wrote, because withheld sentences are dropped.
- The "rendered but unverified" case in ADR-38 should now arise only from a post-release defect.
- The `pending_judge` sentence status and the `verification` event stay in the contract for that defect path and should not occur in normal operation.

## Evidence and implementation references

- Implemented in the answer pipeline (`src/answer/pipeline.ts`, `assembler.ts`, `t3a.ts`) and tested in `tests/integration/answer` and `tests/unit/answer`. The synthesis and judge models were only exercised through fakes and recorded fixtures.

## Revisit when

- Time to first visible sentence is measured and found too slow, or withheld sentences are frequent enough to hurt answers.
