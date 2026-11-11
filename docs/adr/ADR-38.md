# ADR-38: Which assertions may become historical baselines

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner decision, 2026-11-12: separate historical recall from baseline eligibility. The exact rules below were derived from the placeholder grammar, the persisted sentence statuses and the schema, and are recorded for the owner's review (Q-015)
- **Recorded:** 2026-11-11, updated 2026-11-12
- **Related:** [ADR-23](ADR-23.md), [ADR-32](ADR-32.md), [Q-015](../questions.md)

## Context

The system must remember what it said without treating everything it said as verified truth. What is actually stored: an assertion exists only for an `[[F<n>…]]` placeholder (`finding_id` is required; `[[M:…]]` and `[[S:…]]` create none). Each carries `placeholder`, `belief_key`, `value_json`, and links to evidence statements. Its sentence's status (`verified`, `no_claims`, `unverified`, `unchecked`, `truncated`) is in the message's `sentences_json`, and late checks never upgrade a sentence.

## Options considered

- Any stored assertion is a baseline.
- Presented assertions only.
- Presented assertions from verified sentences, current-value placeholder only, with valid evidence (chosen).

## Decision

Two separate questions, two separate rules.

**Historical recall** ("what did you tell me?"): an assertion may be recalled if it was **presented** (acknowledged as rendered). A rendered but unverified sentence stays recallable, shown as what the user saw and labelled as not verified. Streamed-but-unacknowledged and never-streamed assertions are not recalled as told.

**Baseline eligibility** (the earlier claim an audit compares against): all of

1. delivery state `presented`, in an earlier turn;
2. placeholder is the current-value variant `F<n>`. Not `F<n>:baseline` (a restatement; the original assertion is the baseline), `F<n>:verdict` (a comparison, not a value) or `F<n>:derived:<k>` (computed, no belief key of its own; its inputs are the baseline candidates);
3. its sentence has status `verified`. `unverified`, `unchecked` and `truncated` are recallable only;
4. `belief_key` and `value_json` are both set;
5. at least one linked evidence statement, and every linked statement has `verification_status = 'pass'`. An assertion whose evidence was removed (for example by privacy deletion) has no links and is ineligible.

A baseline keeps its original evidence links and the sentence status it had when stored; neither is recomputed. Re-checking whether the evidence still supports the value is a separate step (architecture §8, row 3).

## Consequences and trade-offs

- The baseline loader (milestone 3) must apply rules 2 to 5; the database enforces only presentation (rule 1) and cannot judge sentence status or evidence quality. A recalled but ineligible claim means an audit says what was said and that it was not verified, never a verdict on it.
- Fewer audits get a baseline. That is intended: an unverified claim is not a fact to compare against.
- The rules rely on the sentence status stored in JSON, so the loader reads `sentences_json` (or an equivalent join) and is untested until it exists.

## Evidence and implementation references

- Enforced and tested: a verdict event or a finding's baseline may only target an assertion presented to the same user in an earlier turn; delivery state is derived (T-ASR-05 in [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts), ADR-31). **Not implemented:** rules 2 to 5 and the loader. The rules are decided (Accepted); the implementation is partial for that reason.

## Revisit when

- The baseline loader is written (milestone 3), and when a sentence status or placeholder variant is added.
