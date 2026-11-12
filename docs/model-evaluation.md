# Model evaluation

**Status: the benchmark has not been run.** The only live observation is one smoke check of two calls, recorded in section 5 as a single observation. It is not a benchmark and supports no latency, cost, accuracy or failure-rate claim. The model choice ([ADR-14](adr/ADR-14.md)) stays Proposed, and free-tier eligibility of any model is unverified.

## 1. What exists

| Piece | Where | State |
|---|---|---|
| Gemini adapter behind `LlmPort` (`generateContent`, `streamGenerateContent`) | `src/llm/gemini/` | Built, tested against hand-authored `[SYNTHETIC]` HTTP fixtures. Never called live. |
| Anthropic adapter behind `LlmPort` | `src/llm/anthropic/` | Frozen. Written from documentation and tested only against hand-authored fixtures. It was never run live, so its wire format is not verified. |
| Scripted fake, recording and replay adapters | `src/llm/fake.ts`, `src/llm/replay.ts` | Built. Replay never falls back to a live call. |
| Client-side limiter, bounded retries with backoff and jitter | `src/llm/limiter.ts`, `src/llm/gemini/adapter.ts` | Built, unit-tested with injected time and randomness. |
| Fixed benchmark set and harness | `src/llm/bench/`, `scripts/model-bench.ts` | Built and unit-tested against the fake adapter. **Not run against any model.** |
| Live integration tests | `tests/integration/llm/gemini-live.test.ts` | Skipped unless `GEMINI_API_KEY` and `GEMINI_MODEL` are in `process.env`. They ran once, by the owner (section 5). The per-test timeout is 60 s because the limiter spacing alone exceeds vitest's default 5 s. |

Provider choice is explicit configuration. There is no fallback from one provider to another: a failure raises a typed `LlmError`.

## 2. Fixed benchmark design

The set is `bench-set-1` (`src/llm/bench/cases.ts`). Every case is synthetic (invented companies, invented messages); nothing comes from a user or from the repository database. Free-tier prompts may be used by the provider to improve its products, so a live run must only ever send these cases.

| Dimension | How it is measured | Cases |
|---|---|---|
| Structured extraction reliability | The analysis prompt returns JSON that passes the zod schema, then per-case checks: entities found, temporal expression kept as data (never computed), "still correct?" cue, a user fact with a verbatim quote. A schema failure after the bounded repair is a failure; a schema-valid wrong answer is `wrong`. | 3 |
| T2/T3 assist | The judge prompt must call a supported comparison supported and an unsupported one not supported. | 2 |
| Answer synthesis | One streamed reply; checks that it is non-empty and records time to first token from the provider (the browser sees text only when a whole sentence has been validated). Placeholder discipline is judged by the answer pipeline's own checks, not by this harness. | 1 |
| Correctness | Share of cases `ok` among those attempted. | all |
| Latency | Per call, as reported by the adapter (`latencyMs`, `ttftMs`); summarised only from observed values. | all |
| Tokens | Input, output and cached tokens as reported by the provider; thinking tokens are counted as output. | all |
| Cost | Computed only when the person running it passes `--price-in` and `--price-out` (per million tokens). Otherwise `null`. | all |
| Failure rate | Calls that raised a typed error divided by attempted calls. | all |

Six cases, at most six provider calls plus any analysis retry (a second attempt after a transient failure). The call cap is enforced by the harness, and the command sets provider retries to zero so the cap is also a cap on requests.

### How to run it (after the owner approves live spending)

```
GEMINI_API_KEY=... GEMINI_MODEL=... npx tsx scripts/model-bench.ts --adapter gemini --max-calls 8 --confirm-live-calls
```

The command refuses to run without `--max-calls` and, for a live adapter, without `--confirm-live-calls`. It reads the key and model only from the process environment, never from a file, and never prints them. With `--adapter fake` it answers from canned replies; that output checks the wiring and is not a measurement.

## 3. Wire format: verified against documentation versus assumed

Checked on 2026-11-12 against the public Gemini documentation, without a live call. All of it lives in `src/llm/gemini/wire.ts`.

**Verified in the documentation**
- `generateContent` and `streamGenerateContent` are `POST /v1beta/models/{model}:...`.
- Request: `contents[]` with `role` (`user` or `model`) and `parts[].text`; `systemInstruction` (text parts); `generationConfig` with `maxOutputTokens`, `temperature`, `responseMimeType` (`application/json`), `responseJsonSchema` (the documented field), `thinkingConfig` (`thinkingLevel`, `thinkingBudget`, `includeThoughts`).
- Response: `candidates[].content.parts[].text`; `finishReason` values (`STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, ...); `promptFeedback.blockReason` (no candidates when set); `usageMetadata` (`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount`, `totalTokenCount`); `modelVersion`.
- Retry guidance: retry `429`, `408` and `5xx` with exponential backoff and jitter and a maximum; do not retry `400`, `402`, `403`. A `429` is a per-minute limit or an exhausted daily quota.
- Structured output supports types, `enum`, `properties`, `required`, `items`, `anyOf`, `additionalProperties`, `minItems`/`maxItems`, `minimum`/`maximum`; length and pattern constraints are not enforced (so every reply is re-validated with zod).

**Assumed, not shown by the pages fetched** (confirm on the first live run)
1. The host `https://generativelanguage.googleapis.com` and the `x-goog-api-key` header. The header appears in the documentation's examples for another endpoint of the same API.
2. `?alt=sse` on `streamGenerateContent` returns `text/event-stream` in which each `data:` line is a complete response object, the last one carrying `finishReason` and `usageMetadata`, with no end sentinel. The reference page does not mention `alt=sse`.
3. The error body shape `{error:{code, message, status, details}}` and a `retryDelay` such as `"30s"` inside `details`. The errors page fetched documents only `code` and `message` (in a different, snake_case form), and neither `retryDelay` nor `Retry-After`.
4. `thoughtsTokenCount` is billed as output; it is added to `outputTokens` because the usage type has no separate field. `promptTokenCount` includes cached tokens, so input tokens are reported as prompt minus cached.
5. No tool is enabled: no search grounding, no URL context, no function calling. The request body has no `tools` field, and a test asserts it.

**After the single observation in section 5:** the two calls passed, which is consistent with assumptions 1 and 2 (host, header, and stream framing) but does not test assumptions 3 and 4 (error details, token accounting).

**Free-tier model.** No model identifier is hard-coded and none is claimed to be free-tier eligible. The owner chooses the model through `GEMINI_MODEL`.

## 4. Recording rules

- Only values actually observed in a run may be written in section 5.
- Never write an estimate, a target, a figure from a provider's marketing page, or a number from a run made with the fake adapter.
- A run that failed is recorded as a failed run, with its error codes.
- Raw replies are not committed unless they came from the synthetic set; keys are never recorded.

## 5. Run record (template)

Copy this block once per real run. Leave a field as `not recorded` rather than guessing.

```
Run id:                    (date and a short label)
Date (UTC):
Adapter:                   gemini
Model id (GEMINI_MODEL):   (exact string used)
Prompt set id:             bench-set-1   (and the prompt versions: analysis.v1, synthesis.v1, judge.v1)
Data:                      synthetic only (confirm)
Command line:              (exact, without any key)
Call cap (--max-calls):
Provider retries:          (maxRetries) and backoff settings
Request timeout:
Limiter:                   maxConcurrent / minSpacingMs
Tier / quota context:      (as stated by the provider console, if known)
Calls made:
Per call:                  case id | outcome | error code | latency ms | ttft ms | input / output / cached tokens
Failures:                  count and codes (rate_limited, unavailable, timeout, refused, invalid_output, ...)
Summary:                   ok / wrong / failed / skipped; failure rate; p50 and max latency (observed)
Cost:                      only if prices were supplied: the prices and the result
Notes:                     anything unexpected, including any wire-format assumption (section 3) that was wrong
```

### Runs recorded

#### Single observation, 2026-11-12 (not a benchmark)

Observed by the owner. Recorded exactly as reported; nothing else was measured.

```
Date (UTC):               2026-11-12
Adapter:                  gemini
Model id (GEMINI_MODEL):  gemini-3.5-flash-lite
Conditions:               synthetic prompts only, 2 calls (the two live tests), default limiter
Result:                   both calls passed
Observed:                 structured call 1.35 s; stream call 3.9 s (this includes the limiter's enforced spacing)
Not recorded:             tokens, per-call latency split, cost, retries, quota context
```

Earlier failed attempt with a different model, same day: `gemini-2.5-flash-lite` returned HTTP 404 with the message "no longer available to new users". The adapter surfaced it as a typed `bad_request` error. Recorded as a failure of that model id for this account, not as a finding about the model's quality.

Free-tier eligibility of `gemini-3.5-flash-lite` is not verified by this observation. Two calls say nothing about rates, quotas or reliability.

The benchmark set (`bench-set-1`) has not been run.
