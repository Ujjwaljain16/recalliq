# Extraction calibration

How well the evidence extractor does on real pricing pages, and how to measure a change to its prompt.

Verification is strict on purpose ([architecture R2](architecture.md), [ADR-11](adr/ADR-11.md)): a bare `$` stays
currency-unknown, a page title, URL or domain never names the vendor, and "no seat language" is never "flat". The
aim here is better **extraction**, so that more of what the page really says reaches the verifier in a form it can
confirm. Nothing in this work weakens a check.

**Nothing in this document is a measured model result.** The results section at the end is empty until the
evaluation has been run with a real model.

## Why

A real run asked about the pricing of a managed-Postgres vendor. The model proposed 47 statements from real
pricing pages and every one failed or was weak at T0 to T2, mostly on currency (it wrote `USD` for a page that
shows a bare `$`), plan binding and subject binding (a table row quoted without the plan or product name), and
usage prices without their metered unit. The calibration set turns that observation into something repeatable.

## The data set

`tests/fixtures/calibration/`, described in its own README. Pages were captured once with the project's own Exa
search adapter (`src/search/exa-adapter.ts`), full-text mode and the product's 6000-character budget, restricted to
one vendor domain per request, and are stored exactly as returned.

| | |
|---|---|
| Pages | 20 (3 are negative controls) |
| Vendors | 18: Pipedrive, Salesforce, Freshworks, HubSpot (2 pages), Close, Zoho, Neon (2 pages), Supabase, Render, Railway, DigitalOcean, Aiven, Notion, Linear, Canva, Slack, Atlassian, Dropbox |
| Gold claims | 80 (41 high, 35 medium, 4 low confidence) |
| Traps | 59 (competitor 1, annual figure shown as monthly 5, promotional 4, usage price without unit 4, other plan 19, other 26) |
| Ignorable entries | 23 |
| Search requests | 18, total cost USD 0.126 (contentMode text, 6000 characters, captured 2026-11-12) |

Categories (a page can be in several): per-seat CRM 11, usage-based hosting 8, tiered billing with annual or
monthly prices 13, conditions, promotions, free tiers, contact-sales and multiple currencies 12, negative control 3.
Highlights: a seven-currency per-seat page, price cards whose unit sits on a different line from the amount, a table
whose rows never name the product, a vendor FAQ that quotes a competitor's price, a footnote-only promotion, pages
that name plans but print no amount.

### Labelling method and limitations

- **The labels were made by an AI reading the pages and have not been checked by a human.** Spot-check the claims
  marked `low` or `medium` confidence first. A wrong label shows up as a model "error" or a missed claim.
- Each gold claim has the true field values, a verbatim quote and context, and `expected`: the outcome of the
  current T0 to T2 checks for exactly that quote and context, with the verifier's reasons when it is not `pass`.
  Those outcomes are pinned by a test, so a verifier change that moves one is noticed.
- `bestAchievable` records a better context for the same claim, found by searching the lines above the quote, when it
  turns a non-pass into a pass. It is evidence about what the contract allows, not a second opinion on the label.
- Currency is what the quote (or its context) states. A currency declared elsewhere on the page is noted, not applied.
- The set is small and skewed to vendors with plain pricing pages. It says nothing about pages that need scripts to
  show a price (three of the pages are exactly that: the captured text has the plan names and no amounts).
- Pages change. A recapture can invalidate a label; labels are tied to the captured text, not to the live page.
- Gold lists are complete for headline plan prices and sampled for long tables (the rest are `ignorable`). At most 8
  claims per page, because the extractor keeps 8 statements per entity and kind.
- No page in the set has struck-through markup, so there is no `crossed_out` trap with a real example.

### Adding a page

1. Capture it (one request, about USD 0.007), with the key in the environment, never in a file the script reads:

   ```
   EXA_API_KEY=... npx tsx scripts/extraction-eval.ts capture --domain example.com \
     --query "Example pricing" --out-dir ./new-pages --confirm-live-calls
   ```

   Copy the chosen page to `tests/fixtures/calibration/pages/<id>.json` unchanged.
2. Write `gold/<id>.json` by reading the text: entity context, claims (verbatim `quote` and `contextQuote`),
   traps, ignorable entries, confidence. Add the page to `manifest.json` and update the request count and cost.
3. Run `npx vitest run tests/unit/evidence/calibration-*.test.ts`. The dataset test checks that quotes are verbatim and
   within their limits and that no claim satisfies a trap. The oracle test shows what the verifier does with the new
   claims; set each claim's `expected` (and `bestAchievable` if a different context passes) to that result after
   checking the reason is the verifier being right and not the label being wrong.
4. Mark every label you are unsure of `low` or `medium`.

## The oracle test

`tests/unit/evidence/calibration-oracle.test.ts` builds `RawEvidence` directly from the gold claims (the ideal
extraction, no model) and runs them through the real `RuleEvidenceVerifier`.

| | Claims |
|---|---|
| Gold claims | 80 |
| Pass T0 to T2 with the labelled quote and context | 15 |
| Weak | 38 |
| Fail | 27 |
| Pass with the best context found | 26 |

So even a perfect extractor cannot get more than about 33% of these claims (26 of 80) past the verifier with the
contexts found, and 19% (15 of 80) with the nearest heading. The gaps, with the claims they affect (`page/claim`):

1. **The vendor is not named near the price (61 claims have a weak `subject_binding`).** `subject_binding` is weak when no alias of the
   vendor is in the amount's line or in the context. Price cards and tables head their rows with plan names, and
   many pages never repeat the vendor's name in the body (Pipedrive, Notion, Linear, Canva, DigitalOcean). The
   contract says `contextQuote` is the nearest heading or table header; the verifier accepts any verbatim line above
   the quote within 1,500 characters. A sentence that names the vendor can therefore carry the subject
   (11 claims become `pass` this way: six Aiven plan rows, two Railway plan prices, Railway egress, Slack Free, Notion Custom Agents).
   Where the vendor appears more than 1,500 characters above, or only in the title, nothing can pass. This is
   ADR-11 working as designed; the question for the owner is whether a non-heading line should be allowed to name the
   vendor (the v2 prompt uses it).
2. **Unit on a different line, or a unit word the check does not know (11 claims fail).** The verifier reads the line
   that holds the amount. In a price card the amount, "per seat per month" and "billed annually" are separate lines,
   so `per_seat` cannot pass: Pipedrive (four monthly-billed-annually claims), HubSpot's teaser (four), and Canva
   (three; "per person" is not a seat marker either, and its "/year" is on the next line). The only verifiable form of these claims says `unspecified` for the unit and period, which loses
   information, or quotes a line that happens to hold both (Pipedrive's annual-total line passes on everything but
   the subject).
3. **Metered vocabulary (7 claims).** `usage` needs one of a fixed list of metered markers. "per CU-hour" (Neon, four
   claims), "/GiB/mo" (DigitalOcean storage) and "/100 sessions" (Freshsales add-on) fail, and a usage unit must appear
   in the text as one token sequence: `gb-month` does not match "GB / month" (Railway RAM).
4. **Billing-period phrasing (10 claims fail `monthly_billed_annually`).** "$9/seat (annual)" does
   not read as "billed annually" ("$35/month (annual)" now does, see below), a "Billed yearly" line below the price is another line, and the captured Freshsales
   text glued "billed annuallyFor", which the word-boundary match misses. HubSpot, Freshsales (three),
   Linear (two), Pipedrive (four, with the unit gap above).
5. **A cue on the previous line (4 claims).** "Starts at" on its own line above "$100/month": the lower-bound cue is
   out of the amount's line, so `lower_bound` is judged inconsistent (HubSpot teaser).
6. **A condition in a footnote (1 claim).** A promotional price whose "limited time, new customers" note is a footnote
   far below cannot be quoted with the price within 400 characters; marked `promotional` it fails for lack of a cue,
   marked `current` it would pass wrongly (HubSpot teaser, Starter).
7. **A plan word inside the sentence (1 claim).** "Free to try, then $10 per 1,000 monthly credits" binds the price to
   the Free plan (Notion Custom Agents). Quoting only "then $10 per 1,000 monthly Notion credits." passes.
8. **Currency vocabulary (1 claim).** A yen sign followed by `JPY` ("12,000 円 JPY") has no recognised marker, and
   SEK is not in the table (Salesforce).

### A verifier defect found, and fixed

`$ 25 USD/User/Month` was resolved as a **bare** `$` (unknown currency): the prefix symbol took precedence over the
explicit code `USD` right after the amount, so an extraction of `USD` failed T2. The architecture table lists `USD`
as an explicit marker, and a bare `$` only stays unknown when nothing else states the currency. The fix is in
`markerFor` (`src/evidence/currency.ts`): when the symbol is a bare `$` or `¥` and a code that symbol can stand for
(USD, CAD, AUD, NZD, SGD for `$`; JPY, CNY for `¥`) follows the amount, the code decides. A bare symbol alone, and a
code the symbol cannot stand for (`$ 25 EUR`), still resolve to unknown. Regression tests:
`tests/unit/evidence/currency-explicit-code.test.ts`. It affects Salesforce (five claims), Slack, and a structured-data
line on the Freshsales page. It is not a relaxation of the bare-`$` rule.

### A second verifier defect found, and fixed

A quote that holds several prices ("Essentials $49/month (monthly) or $35/month (annual), Growth ...") was checked
for unit and billing period against the whole line, so a cue that belonged to another price satisfied the claim for
this one: `{Essentials, 35, monthly}` passed on the "monthly" next to $49, and `{Essentials, 35,
monthly_billed_annually}` failed. The cues are now bound to the amount (`src/evidence/binding.ts`): its own head
(the text after it up to the next separator, with its billing clauses), a cue-only label right before it, and the
text that belongs to no price (the lead-in, "Current list rates (per seat) are approximately:"). For the period
check, "$35/month (annual)" is a monthly price billed annually, so it fails as `monthly` and as `annual` and passes
as `monthly_billed_annually`; an amount with no cue of its own while another price in the quote has one is weak,
and a cue-only piece between two prices that could belong to either is weak. Quotes with one price are judged
exactly as before. Effect on the oracle: three claims move from fail to pass, the annual rates of Close's Essentials,
Growth and Scale plans (their gold claim is `monthly_billed_annually`, which the quote supports); the pins in
`close-plans-and-billing.json` were changed for those three and for nothing else. Regression tests:
`tests/unit/evidence/billing-binding.test.ts`.

### The oracle with a registry of owned domains

[ADR-41](adr/ADR-41.md) lets a domain the owner's registry maps to an entity bind the subject of a plan-tied price on a page that presents pricing, unless a blocker fires. The evaluation takes an optional registry (`--registry <file>`, a JSON object of entity name to domains, the format of `OFFICIAL_DOMAINS_FILE`; default none), and `runOracle` takes the same. **The registry used for the numbers below is a measurement aid, not an owner registry:** each gold page's own vendor is mapped to the domain of the page's URL, derived by `registryFromGoldPages` from the data. It answers what the ceiling would be if the owner had registered these vendors. No registry is committed as a default and none of any real vendor ships.

| | Without a registry | With the measurement-aid registry |
|---|---|---|
| Pass | 15 | 40 |
| Weak | 38 | 13 |
| Fail | 27 | 27 |

The without-registry numbers are asserted equal to the ones above (`T-EV-OWN-60`). With the registry, 25 claims move from weak to pass and nothing else moves; no failing claim changes. Each of the 25 was held back only by `subject_binding: weak` (asserted in `T-EV-OWN-61`), so the new outcome is the labelled one:

- Pipedrive: `lite-annual-total`, `ultimate-annual-total`
- Salesforce: `starter-usd`, `starter-eur`, `starter-aud`, `pro-usd`, `core-usd`, `advanced-usd`, `max-usd`
- HubSpot: `free`
- Supabase: `free-from`, `pro-from`, `team-from`, `micro-compute`, `pro-disk-overage`, `pro-egress-overage`
- Render: `postgres-free`, `postgres-1c-2g`
- Railway: `hobby`, `pro`, `egress-container`
- Notion: `plus`, `business`, `free`
- Slack: `free`

Twenty claims keep a weak subject with the registry: 10 sit under an integration cue (typically an "Integrations" menu above the price list), 3 under a comparison cue, and 7 where the plan binding does not pass (so ownership is not used). The pins in the gold files are the no-registry baseline and were not changed.

**Traps.** Every labelled trap (56) was turned into the statement it forbids, from the closest gold claim with the trap's amount, unit, period, currency, plan and modality, or from the page line for traps that are defined by a quote. None passes, with or without the registry (`T-EV-OWN-64`); no trap moved. This is an adversarial check of the verifier on the labelled traps, not a measurement of a model.

Two things the ownership rule does not do, and one it was made to do. It does not change the billing period or unit checks, so the annual-as-monthly defect is not fixed by accident: `$35/month (annual)` claimed as monthly still fails `billing_period` while the subject passes. It does not add the vendor to the quote. And a claim whose unit or period could be contradicted by a cue on another line of the quote (for example a "Billed yearly" line under a price) is not bound by ownership: without that guard the Linear trap "monthly price billed yearly" would have turned from weak into pass.

## The evaluation

`scripts/extraction-eval.ts run` runs the real extractor path (`LlmEvidenceExtractor`: prompt, message, ref mapping,
caps) and the real verifier over every gold page, one entity and one snapshot per call, then scores the result.

```
# offline: wiring check and verifier ceiling (the oracle answers with the gold claims)
npx tsx scripts/extraction-eval.ts run --adapter oracle
npx tsx scripts/extraction-eval.ts run --adapter oracle-best
npx tsx scripts/extraction-eval.ts run --adapter empty

# live, the same dataset, v1 then v2 (the caller supplies the environment)
GEMINI_API_KEY=... GEMINI_MODEL=... npx tsx scripts/extraction-eval.ts run --adapter gemini \
  --prompt extract-v1 --max-calls 40 --confirm-live-calls --out before.json --record-to before-replies.json
GEMINI_API_KEY=... GEMINI_MODEL=... npx tsx scripts/extraction-eval.ts run --adapter gemini \
  --prompt extract-v2 --max-calls 40 --confirm-live-calls --out after.json --record-to after-replies.json

# score recorded replies again, without a model
npx tsx scripts/extraction-eval.ts run --adapter replay --replay after-replies.json --prompt extract-v2
```

Safety: a live run needs both `--confirm-live-calls` and `--max-calls N`, where N is a hard cap on HTTP requests to
the provider (retries and repairs included; the adapter is built with no retries) and is at least the number of
pages. Output tokens per call are capped (`--max-output-tokens`, default 2500, at most 4000). The key and model come
only from `process.env`; the script never reads a `.env` file, never prints a key, and a report holds only the model
name. `--json` prints the report as JSON, `--out file.json` writes it, `--pages a,b` limits the run.

### Metrics

All counted over price statements. A page's statements are matched to its gold claims one to one, the strongest
verdict first.

- **Match.** A statement matches a gold claim when plan (a claim without a plan accepts any), amount, currency,
  unit, usage unit (letters and digits only, so `gb-month` equals `GB / month`) and billing period are equal.
- **Duplicate.** A further statement that matches an already matched claim. Not counted as a prediction.
- **Ignored.** A statement matching an `ignorable` entry. Not counted either way.
- **Precision** = matched statements / predicted statements (all except duplicates and ignored). **Recall** =
  matched gold claims / gold claims. A negative control has no gold: every price statement on it is a false positive.
- **Verified precision / recall:** the same restricted to statements that pass T0 to T2. **Verified recall of
  passable** divides by the gold claims that verification can ever pass (labelled `pass`, or `pass` with a better
  context), the fair denominator given the gaps above.
- **Recall without low-confidence gold:** recall with the claims labelled `low` removed.
- **False pass rate.** Passing statements that are not a match, a duplicate of one or ignorable, over all passing
  statements. Broken down by kind: `trap`, `unmatched`, `contradicts` (right amount, wrong plan, currency, unit or
  period), `underspecified` (right amount, plan and currency, but unit, period or usage unit left `unspecified` where
  the gold has one).
- **Field accuracy.** Each gold claim is aligned to the statement with the same amount that agrees on most fields; for
  the aligned pairs: entity, plan, subject (entity and plan), unit, usage unit (usage claims only), currency, billing
  period, value kind, modality, and conditions (present exactly when the gold has them).
- **Supporting quote.** Verbatim in the page (same normalisation as T1) **and** containing the claimed amount.
- Also reported: verdict counts, which checks failed how often, results by category and per page, negative controls,
  calls, provider requests and tokens.

## Prompt extract-v2 (candidate)

`src/evidence/prompts/extraction.ts` keeps `EXTRACTION_PROMPT_VERSION = 'extract-v1'` and the v1 text unchanged, and
adds `EXTRACTION_SYSTEM_PROMPT_V2`, `EXTRACTION_PROMPTS` and `extractionPromptFor(version)`. `LlmEvidenceExtractor`
takes an optional `prompt`, so the same code runs either; the output schema, message format and token cap are shared.
To make v2 the default after it has been measured, change the default in `extractor.ts` and the version constant.

What v2 changes, each tied to a failure above, with no vendor, page or gold answer in the text:

- Tells the model how the checker reads a proposal (one line at a time) so quote and context are chosen to carry
  the evidence.
- Currency: copy what the quote shows; a bare `$` or yen sign is `unknown`; never infer USD; a code beside a symbol
  decides.
- Quote the line that holds the amount together with its unit and period; copy a table row together with the plan or
  product name; if the unit or period is only on another line, leave it `unspecified` rather than claim it.
- `contextQuote`: the closest line above that supplies the entity or plan the quote lacks.
- Usage prices keep `unit: usage` with the unit words from the quote, never as a plain price.
- `monthly_billed_annually` only when one line says both; two statements when a line gives both prices.
- Promotional, conditional, historical and planned modalities with the cue words in `conditions`; skip a price whose
  condition is in a footnote that cannot be quoted with it.
- No statements for other vendors, crossed-out prices, percentages, totals, worked examples, allowances or fees;
  never an amount from memory; fewer, correct statements.

Known limits of v2: it cannot make a claim pass where the oracle shows the contract does not allow it (gaps 1 to 8),
and "leave unspecified" trades information for a verifiable statement, which the metrics report as `underspecified`
rather than as a false pass of another kind.

## Results

Not run yet. The BEFORE run (extract-v1) and AFTER run (extract-v2) on the same dataset, with the same model, are to
be added here with the model name, the date and the report files.
