import type { LlmUsage } from '../../shared/llm.js';
import type { PageScore, Rate, Summary } from './scoring.js';
import { summarize } from './scoring.js';

export interface RunMeta {
  /** Which prompt was under test (a version string). */
  promptVersion: string;
  /** `gemini`, `replay`, `oracle`, `oracle-best` or `empty`. Only `gemini` is a measurement of a model. */
  adapter: string;
  /** The model identifier the adapter reported, when there is one. Never a credential. */
  model: string | null;
  startedAt: string;
  datasetPages: number;
  datasetClaims: number;
  /** Structured calls made through the port. */
  calls: number;
  /** Provider requests counted at the HTTP layer (retries and repairs included); null when not a live run. */
  providerRequests: number | null;
  maxCalls: number | null;
  maxOutputTokens: number;
  usage: LlmUsage;
  notes: string[];
}

export interface EvalReport {
  version: 1;
  meta: RunMeta;
  summary: Summary;
  pages: PageScore[];
}

export function buildReport(meta: RunMeta, pages: readonly PageScore[]): EvalReport {
  return { version: 1, meta, summary: summarize(pages), pages: [...pages] };
}

const pct = (r: Rate): string =>
  r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`;

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

function ratio(r: Rate): string {
  return r.value === null ? 'n/a' : `${Math.round(r.value * 100)}%`;
}

/** A readable plain-text rendering of a report. Numbers are the report's; nothing is added or rounded away. */
export function formatTable(report: EvalReport): string {
  const { meta, summary: s } = report;
  const out: string[] = [];
  out.push(
    `Extraction evaluation: prompt ${meta.promptVersion}, adapter ${meta.adapter}${meta.model ? `, model ${meta.model}` : ''}`,
  );
  out.push(
    `${meta.datasetPages} pages, ${meta.datasetClaims} gold claims, ${meta.calls} calls` +
      (meta.providerRequests !== null ? `, ${meta.providerRequests} provider requests` : '') +
      `, ${meta.usage.inputTokens} input / ${meta.usage.outputTokens} output tokens`,
  );
  for (const n of meta.notes) out.push(`note: ${n}`);
  out.push('');
  out.push('Claim level');
  out.push(`  precision                      ${pct(s.precision)}`);
  out.push(`  recall                         ${pct(s.recall)}`);
  out.push(`  precision, verified (pass)     ${pct(s.verifiedPrecision)}`);
  out.push(`  recall, verified (pass)        ${pct(s.verifiedRecall)}`);
  out.push(`  recall, verified, of passable  ${pct(s.verifiedRecallOfPassable)}`);
  out.push(`  recall, no low-confidence gold ${pct(s.recallExcludingLowConfidence)}`);
  out.push(`  false-pass rate                ${pct(s.falsePassRate)}`);
  const fp = Object.entries(s.falsePasses.byClass)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  out.push(`  false passes by kind           ${fp === '' ? 'none' : fp}`);
  out.push(
    `  verdicts (price statements)    pass ${s.statusCounts.pass}, weak ${s.statusCounts.weak}, fail ${s.statusCounts.fail}`,
  );
  out.push(
    `  negative controls              ${s.negativeControls.pagesWithPriceStatements}/${s.negativeControls.pages} pages with a price statement, ${s.negativeControls.priceStatements} statements, ${s.negativeControls.passStatements} passed`,
  );
  out.push('');
  out.push(`Field accuracy (over gold claims aligned to a statement: ${pct(s.alignedGoldRate)})`);
  for (const [k, r] of Object.entries(s.fieldAccuracy)) out.push(`  ${pad(k, 14)} ${pct(r)}`);
  out.push('');
  out.push('Supporting quote');
  out.push(`  verbatim in the page           ${pct(s.quote.verbatim)}`);
  out.push(`  contains the claimed value     ${pct(s.quote.containsValue)}`);
  out.push(`  both                           ${pct(s.quote.accurate)}`);
  out.push('');
  const checks = Object.entries(s.checkFailures).sort(
    ([, a], [, b]) => b.weak + b.fail - (a.weak + a.fail),
  );
  out.push('Checks that did not pass (statement counts)');
  if (checks.length === 0) out.push('  none');
  for (const [k, v] of checks)
    out.push(`  ${pad(k, 24)} weak ${padL(String(v.weak), 3)}  fail ${padL(String(v.fail), 3)}`);
  out.push('');
  out.push('By category');
  for (const [k, c] of Object.entries(s.byCategory))
    out.push(
      `  ${pad(k, 17)} pages ${padL(String(c.pages), 2)}  gold ${padL(String(c.goldClaims), 3)}  precision ${padL(ratio(c.precision), 4)}  recall ${padL(ratio(c.recall), 4)}  verified recall ${padL(ratio(c.verifiedRecall), 4)}`,
    );
  out.push('');
  out.push(
    `${pad('page', 34)} ${padL('gold', 4)} ${padL('pred', 4)} ${padL('tp', 3)} ${padL('prec', 5)} ${padL('rec', 5)} ${padL('pass', 4)} ${padL('weak', 4)} ${padL('fail', 4)} ${padL('fpass', 5)}`,
  );
  for (const p of report.pages) {
    const prec =
      p.predicted === 0 ? 'n/a' : `${Math.round((p.truePositives / p.predicted) * 100)}%`;
    const rec = p.goldClaims === 0 ? 'n/a' : `${Math.round((p.matchedGold / p.goldClaims) * 100)}%`;
    out.push(
      `${pad(p.pageId + (p.extractionFailure ? ' (FAILED)' : ''), 34)} ${padL(String(p.goldClaims), 4)} ${padL(String(p.predicted), 4)} ${padL(String(p.truePositives), 3)} ${padL(prec, 5)} ${padL(rec, 5)} ${padL(String(p.statusAll.pass), 4)} ${padL(String(p.statusAll.weak), 4)} ${padL(String(p.statusAll.fail), 4)} ${padL(String(p.falsePasses), 5)}`,
    );
  }
  return out.join('\n');
}
