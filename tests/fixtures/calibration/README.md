# Extraction calibration set

Real public pricing pages and hand-reviewed gold claims, used to measure and improve evidence extraction
(`docs/extraction-calibration.md` describes the method, the metrics and how to run the evaluation).

**The labels were made by an AI reading the pages. They have not been checked by a human.** Treat every gold
claim as a proposal and spot-check the labels marked `low` or `medium` confidence first (`confidence` in each
claim, `pageConfidence` per page). The reviewer of record is an AI model, not an oracle: it can misread a layout,
and a page that changes after capture will not match its label.

## Contents

- `manifest.json`: the page list, the capture date, the search request count and cost, and who labelled.
- `pages/<id>.json`: one captured page: `{url, urlNorm, capturedAt, provider, title, text, requestId}`. `text` is
  exactly what the project's Exa adapter returned for a full-text request with the 6000-character budget. The
  excerpts are short public factual text; the source URL and capture date are recorded with each. Do not edit
  them: the gold quotes must stay verbatim.
- `gold/<id>.json`: the entity context for the page, the gold claims, the traps and the ignorable statements.

## Gold file fields

- `entity`: name, aliases, the vendor's known plans (used by the verifier's intervening-plan rule), official
  domains, and competitors named on the page.
- `claims[]`: `plan`, `value` (amount, currency as the page states it within the quote or its context,
  `unit`, `usageUnit`, `billingPeriod`, `valueKind`), `modality`, `conditions`, the verbatim `quote` (at most 400
  characters) and `contextQuote` (nearest heading or table header above it, at most 200), `expected` (the outcome
  of the current deterministic checks T0 to T2 for exactly this quote and context, with the reason when it is
  not `pass`), `bestAchievable` (a better context for the same fields, when one makes the claim pass), and
  `confidence`.
- `traps[]`: statements that must not be produced (a competitor's price, a worked example, a promotional price
  shown as current, an annual figure labelled monthly, a usage price without its unit, a price for a plan that
  has none on the page). A trap with an empty match on a negative control means: any price is wrong.
- `ignorable[]`: true statements the claim list deliberately does not enumerate (for example the other rows of a
  long size table). A statement that matches one counts neither for nor against precision.

## Labelling rules

- A gold claim states what the page says, not what the verifier can confirm. `expected` records what the
  verifier does with the ideal quote, so a claim can be true and still `weak` or `fail`.
- `currency` is `unknown` for a bare `$` or yen sign. A currency declared elsewhere on the page, outside the
  quote and its context (for example a footnote "Price shown in USD"), is noted but not applied, because the
  verifier cannot see it.
- No page excerpt contains struck-through markup, so no trap of kind `crossed_out` exists in this set.
- Gold lists are complete for headline plan prices; large size tables are sampled and the rest are ignorable.
  At most 8 claims per page, because the extractor keeps at most 8 statements per entity and kind.
- Three negative controls (`zoho-crm-pricing`, `jira-pricing`, `dropbox-standard-plan`) have no extractable
  price in the captured text.

To add a page, follow "Adding a page" in `docs/extraction-calibration.md`.
