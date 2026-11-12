/**
 * Search provider bake-off harness (ADR-08). BUILT AND UNIT-TESTED, NOT RUN: no live provider has been called
 * and no result exists. See docs/provider-evaluation.md for the design.
 *
 * Library part: fixed benchmark cases, per-case scoring, aggregation. The only things measured are the ones the
 * port reports (latency, cost) or that can be checked mechanically from the response (domain, date presence,
 * price-like text, structure). Correctness of dates and prices needs a human label and is NOT scored here.
 *
 * CLI part (`npx tsx scripts/bakeoff.ts --mode=replay --recording=<file>` or `--mode=live --confirm-spend`):
 * refuses to call a live provider without an explicit flag and a configured key, and writes results under
 * `eval/results/` only when asked. Never run automatically.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ExaSearchAdapter } from '../src/search/exa-adapter.js';
import { ReplaySearchAdapter } from '../src/search/replay.js';
import {
  SearchError,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../src/shared/search.js';
import { SystemClock } from '../src/temporal/clock.js';
import { parseSourceStructure } from '../src/sources/structure.js';
import { normalizeUrl } from '../src/sources/url.js';

export interface BenchmarkCase {
  id: string;
  kind: 'pricing' | 'release';
  request: SearchRequest;
  /** Registrable domains that count as official for this vendor. */
  officialDomains: string[];
}

const pricingReq = (query: string, domains: string[]): SearchRequest => ({
  query,
  numResults: 5,
  includeDomains: domains,
  freshness: 'live',
  liveTimeoutMs: 5000,
  contentMode: 'text',
  contentChars: 6000,
});

/** Fixed benchmark: vendors named in the project's challenge questions plus common SaaS pricing pages. */
export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    id: 'hubspot-pricing',
    kind: 'pricing',
    officialDomains: ['hubspot.com'],
    request: pricingReq('HubSpot pricing', ['hubspot.com']),
  },
  {
    id: 'notion-pricing',
    kind: 'pricing',
    officialDomains: ['notion.com', 'notion.so'],
    request: pricingReq('Notion pricing', ['notion.com', 'notion.so']),
  },
  {
    id: 'slack-pricing',
    kind: 'pricing',
    officialDomains: ['slack.com'],
    request: pricingReq('Slack pricing', ['slack.com']),
  },
  {
    id: 'zoom-pricing',
    kind: 'pricing',
    officialDomains: ['zoom.us', 'zoom.com'],
    request: pricingReq('Zoom pricing', ['zoom.us', 'zoom.com']),
  },
  {
    id: 'asana-pricing',
    kind: 'pricing',
    officialDomains: ['asana.com'],
    request: pricingReq('Asana pricing', ['asana.com']),
  },
  {
    id: 'github-pricing',
    kind: 'pricing',
    officialDomains: ['github.com'],
    request: pricingReq('GitHub pricing plans', ['github.com']),
  },
  {
    id: 'openai-release',
    kind: 'release',
    officialDomains: ['openai.com'],
    request: {
      query: 'OpenAI announces new',
      numResults: 6,
      includeDomains: ['openai.com'],
      freshness: 'cached',
      contentMode: 'highlights',
      contentChars: 2000,
    },
  },
];

/** Currency symbol or ISO code next to a number: "$90", "€15", "15 EUR", "USD 20". */
const PRICE_LIKE =
  /(?:[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP|JPY)\b|\b(?:USD|EUR|GBP|JPY)\s?\d[\d,.]*)/;

export interface CaseScore {
  caseId: string;
  status: 'ok' | 'failed';
  errorCode?: string;
  hits: number;
  droppedMalformed: number;
  /** An official-domain hit is in the results. */
  officialDomainHit: boolean;
  /** Share of hits with a provider publishedAt, in [0,1]; null when there are no hits. */
  dateAvailability: number | null;
  /** Share of hits whose text contains a currency-and-number pattern; pricing cases only. */
  priceTextShare: number | null;
  /** Share of hits whose text has at least one heading or table (structure survived). */
  structureShare: number | null;
  freshFetchShare: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

const share = (xs: boolean[]): number | null =>
  xs.length === 0 ? null : xs.filter(Boolean).length / xs.length;

function isOfficial(url: string, domains: readonly string[]): boolean {
  try {
    const host = normalizeUrl(url).domain;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function scoreResponse(c: BenchmarkCase, r: SearchResponse): CaseScore {
  return {
    caseId: c.id,
    status: 'ok',
    hits: r.hits.length,
    droppedMalformed: r.droppedMalformed,
    officialDomainHit: r.hits.some((h) => isOfficial(h.url, c.officialDomains)),
    dateAvailability: share(r.hits.map((h) => h.publishedAt !== null)),
    priceTextShare: c.kind === 'pricing' ? share(r.hits.map((h) => PRICE_LIKE.test(h.text))) : null,
    structureShare: share(
      r.hits.map((h) => {
        const s = parseSourceStructure(h.text);
        return s.headings.length + s.tables.length > 0;
      }),
    ),
    freshFetchShare: c.request.freshness === 'live' ? share(r.hits.map((h) => h.freshFetch)) : null,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
  };
}

export function failedScore(c: BenchmarkCase, errorCode: string): CaseScore {
  return {
    caseId: c.id,
    status: 'failed',
    errorCode,
    hits: 0,
    droppedMalformed: 0,
    officialDomainHit: false,
    dateAvailability: null,
    priceTextShare: null,
    structureShare: null,
    freshFetchShare: null,
    latencyMs: null,
    costUsd: null,
  };
}

export interface ProviderSummary {
  provider: string;
  cases: number;
  failed: number;
  officialDomainHitRate: number | null;
  meanDateAvailability: number | null;
  meanPriceTextShare: number | null;
  meanStructureShare: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  totalCostUsd: number | null;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Nearest-rank percentile of a non-empty sorted array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function summarise(provider: string, scores: CaseScore[]): ProviderSummary {
  const ok = scores.filter((s) => s.status === 'ok');
  const nums = (f: (s: CaseScore) => number | null): number[] =>
    ok.map(f).filter((x): x is number => x !== null);
  const lat = nums((s) => s.latencyMs).sort((a, b) => a - b);
  const costs = nums((s) => s.costUsd);
  return {
    provider,
    cases: scores.length,
    failed: scores.length - ok.length,
    officialDomainHitRate:
      ok.length === 0 ? null : ok.filter((s) => s.officialDomainHit).length / ok.length,
    meanDateAvailability: mean(nums((s) => s.dateAvailability)),
    meanPriceTextShare: mean(nums((s) => s.priceTextShare)),
    meanStructureShare: mean(nums((s) => s.structureShare)),
    latencyP50Ms: percentile(lat, 0.5),
    latencyP95Ms: percentile(lat, 0.95),
    totalCostUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
  };
}

/** Runs every case once, sequentially, against one port. Provider errors become failed scores. */
export async function runBakeoff(
  port: SearchPort,
  cases: readonly BenchmarkCase[],
  perCallTimeoutMs = 10_000,
): Promise<{ scores: CaseScore[]; summary: ProviderSummary }> {
  const scores: CaseScore[] = [];
  for (const c of cases) {
    try {
      const r = await port.search(c.request, AbortSignal.timeout(perCallTimeoutMs));
      scores.push(scoreResponse(c, r));
    } catch (e) {
      // ReplayMissError and programmer errors are not provider failures: let them stop the run.
      if (!(e instanceof SearchError)) throw e;
      scores.push(failedScore(c, e.code));
    }
  }
  return { scores, summary: summarise(port.provider, scores) };
}

async function main(argv: string[]): Promise<void> {
  const arg = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const mode = arg('mode');
  let port: SearchPort;
  if (mode === 'replay') {
    const file = arg('recording');
    if (!file) throw new Error('--recording=<file> is required in replay mode');
    port = ReplaySearchAdapter.fromJson(fs.readFileSync(file, 'utf8'));
  } else if (mode === 'live') {
    if (!argv.includes('--confirm-spend')) {
      throw new Error(
        'Live mode spends money: pass --confirm-spend after the owner has approved it.',
      );
    }
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) throw new Error('EXA_API_KEY is not set (use an ignored .env)');
    port = new ExaSearchAdapter({ apiKey, fetch: (u, i) => fetch(u, i), clock: new SystemClock() });
  } else {
    throw new Error('Usage: --mode=replay --recording=<file> | --mode=live --confirm-spend');
  }
  const out = await runBakeoff(port, BENCHMARK_CASES);
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
