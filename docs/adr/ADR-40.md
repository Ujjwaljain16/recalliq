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

## Consequences and trade-offs

- No token-by-token typing: the first visible text arrives when the first sentence is validated.
- Answers can be shorter than what the model wrote, because withheld sentences are dropped.
- The "rendered but unverified" case in ADR-38 should now arise only from a post-release defect.
- The `pending_judge` sentence status and the `verification` event stay in the contract for that defect path and should not occur in normal operation.

## Evidence and implementation references

- Not implemented. The answer pipeline as first built streams deltas immediately and must be changed to this rule before it is integrated.

## Revisit when

- Time to first visible sentence is measured and found too slow, or withheld sentences are frequent enough to hurt answers.
