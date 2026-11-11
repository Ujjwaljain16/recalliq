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
   - The nouns `release`, `releases` and `release notes` allow only a **neutral heading**: the noun, up to three other words before it (the entity name and a little more), a colon immediately after it, and a placeholder of a releases-intent finding right after the colon ("Pipedrive releases: [[F2]]"). A heading is presentation only, so any verdict of that finding justifies it, including unable_to_verify, because the placeholder alone carries the statement. A claim word before the noun (no, several, new, latest, a, has, there are, ...) means it is not a heading.
   - Any other use of the noun is a **claim** and needs a compatible verdict of a releases-intent finding in the same clause: a negative ("has no releases", "no new releases", "nothing was released", "without releases", or "releases: none, ...") needs none_found; a positive existence claim ("had releases", "several releases", "new releases", "a release") needs releases_found with at least one item. unable_to_verify authorises neither claim. Free text after the heading colon or a dash is a claim and is judged as one; only the colon followed directly by the placeholder is a heading.
   - A claim that names a specific item ("launched Smart Docs", "the latest release is Smart Docs") also needs the item to match: every content word after the verb or noun, up to the end of the clause, must occur in the title of one item of the finding that has a fitting kind (launch or change for launch verbs, removal for removal verbs). A different or invented item is withheld. A claim that names nothing ("launched it", "shipped something") is decided by the verdict alone.
   - Every sentence is judged on its own placeholders: a heading in one sentence never authorises the next sentence.
   - The verbs (launched, released, shipped, introduced, rolled out, announced, unveiled) still need a `:verdict` of a releases_found finding with a compatible item; none_found never authorises them. For a sourced sentence this is amended (see "Amendment, 2026-11-12" below).
   - A releases-intent finding never authorises price wording, and a pricing finding never authorises any release wording, heading or claim.
5. The synthesis prompt states the same rule (prompt version `synthesis.v3`, now `synthesis.v6` with the amendment below): free text must not describe changes.

**Limitation, stated plainly.** The word lists (the original phrase families and a broader lexicon of change verbs, comparatives and timing words, matched after normalising case, spacing, look-alike characters and hyphenation) are a backstop. They are not a complete natural-language semantic detector: a paraphrase outside the lists can pass, and a harmless sentence that uses a listed word (for example "you can change plans", or "Use the release notes [[S:src_one]]" with no releases finding in the clause) is withheld. The verdict-placeholder requirement and the prompt are the boundary; the lists only catch the wording they know. The corpus in `tests/unit/answer` records known false positives and known false negatives.

## Duplicate text

A placeholder renders a complete statement or value, so the free text around it must not repeat it (the observed defect: "No verified price was found for Neon [[F1]]" read as "... for Neon no verified price was found"). When a sentence ends, before release, the pipeline compares its free text, case-insensitively and ignoring punctuation and whitespace, with the rendered text of its placeholders. It withholds the sentence (issue `duplicate_text`, same semantics as any other withheld sentence) when the free text contains a placeholder's whole rendered text of two or more words, or a run of three consecutive words of it with at least two content words (units and common filler words such as `per`, `user`, `month` do not count). A run never spans a placeholder, and a placeholder that renders a single word is not compared. The synthesis prompt asks for a lead-in with the entity name and a colon instead. Like the change-language check, this is a backstop and not complete: a restatement in different words passes, and a harmless sentence that happens to repeat three content words of a rendering is withheld.

## Amendment, 2026-11-12: release verbs in sourced sentences

Measured live, the rule above withheld every useful sentence of "what is new in a runtime" and "what is the latest stable version of a language": the pages said what a version introduces, and the model's attributed sentences repeating them were withheld (`unsupported_verdict_word`). The rule exists to stop unproven claims of change by the assistant ("X shipped Y since Monday"). A sourced, attributed sentence that states what its page says ("According to nodejs.org, Node.js 24 introduces a new permission model [1].") is a quotation of the page, not a temporal claim of ours.

Amended rule, for SOURCED sentences only (ADR-42: the sentence cites a source of this turn and renders no finding):

1. A release verb (launched, released, shipped, introduced, rolled out, announced, unveiled, in any tense of the lexicon) or a positive or heading use of the noun "release" is allowed when (i) the sentence is sourced and passes the grounding check, (ii) it contains no temporal-relation or change word: since, recently, lately, just, now, today, yesterday, overnight, no longer, anymore, this week (month, year), last week (month, year), new since, and every change, price-change, removal, unchanged and was-wrong word of the lexicon (changed, updated, raised, cut, increased, decreased, dropped, ...), and (iii) the turn has no "since" anchor (`change_since`), or the sentence names a date, which grounding then requires in the cited excerpt.
2. A negative release claim ("nothing was released", "no releases") is never a quotation and stays withheld. Price-change words stay forbidden in sourced sentences as before.
3. In a sourced sentence every release verb of the lexicon is now checked, also in a turn without findings (before, only the past forms of the core list were), so a present-tense verb tied to time ("now ships", "just introduced") is withheld where it used to pass.
4. Verified sentences are unchanged: their release words still need a releases_found verdict placeholder with a compatible item.

Implemented in `releaseQuoteAllowed` of `src/answer/t3a.ts`; the turn's "since" anchor reaches it as `T3aContext.changeSince`. Tests: [live-sweep.test.ts](../../tests/integration/answer/live-sweep.test.ts), [grounded.test.ts](../../tests/integration/e2e/grounded.test.ts), [sourced.test.ts](../../tests/integration/answer/sourced.test.ts).

## Consequences and trade-offs

- No token-by-token typing: the first visible text arrives when the first sentence is validated.
- Answers can be shorter than what the model wrote, because withheld sentences are dropped.
- The "rendered but unverified" case in ADR-38 should now arise only from a post-release defect.
- The `pending_judge` sentence status and the `verification` event stay in the contract for that defect path and should not occur in normal operation.

## Evidence and implementation references

- Implemented in the answer pipeline (`src/answer/pipeline.ts`, `assembler.ts`, `t3a.ts`) and tested in `tests/integration/answer` and `tests/unit/answer`. The synthesis and judge models were only exercised through fakes and recorded fixtures.

## Revisit when

- Time to first visible sentence is measured and found too slow, or withheld sentences are frequent enough to hurt answers.
