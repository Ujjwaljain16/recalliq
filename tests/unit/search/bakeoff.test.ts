import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CASES,
  failedScore,
  runBakeoff,
  scoreResponse,
  summarise,
  type BenchmarkCase,
} from '../../../scripts/bakeoff.js';
import {
  ReplayMissError,
  SearchError,
  type SearchHit,
  type SearchPort,
  type SearchResponse,
} from '../../../src/shared/search.js';

const kase: BenchmarkCase = BENCHMARK_CASES[0] as BenchmarkCase;

const hit = (over: Partial<SearchHit>): SearchHit => ({
  url: 'https://www.hubspot.com/pricing',
  title: null,
  text: '# Pricing\n\nPro $90 per user',
  publishedAt: 1,
  lastUpdatedAt: null,
  providerScore: null,
  freshFetch: true,
  crawlStatus: 'ok',
  ...over,
});
const resp = (
  hits: SearchHit[],
  latencyMs = 100,
  costUsd: number | null = 0.01,
): SearchResponse => ({
  provider: 'fake',
  hits,
  droppedMalformed: 2,
  latencyMs,
  costUsd,
  observedAt: 0,
});

describe('bake-off scoring (fake data only: these are harness tests, not benchmark results)', () => {
  it('has a fixed, valid benchmark', () => {
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(BENCHMARK_CASES.map((c) => c.id)).size).toBe(BENCHMARK_CASES.length);
    for (const c of BENCHMARK_CASES) expect(c.officialDomains.length).toBeGreaterThan(0);
  });

  it('scores official domain, dates, price text, structure and fresh fetch', () => {
    const s = scoreResponse(
      kase,
      resp([
        hit({}),
        hit({
          url: 'https://blog.example/hubspot-review',
          publishedAt: null,
          text: 'no numbers',
          freshFetch: false,
        }),
        hit({ url: 'https://nothubspot.com/x', text: '15 EUR / month' }),
      ]),
    );
    expect(s.officialDomainHit).toBe(true);
    expect(s.dateAvailability).toBeCloseTo(2 / 3);
    expect(s.priceTextShare).toBeCloseTo(2 / 3);
    expect(s.structureShare).toBeCloseTo(1 / 3);
    expect(s.freshFetchShare).toBeCloseTo(2 / 3);
    expect(s.droppedMalformed).toBe(2);
  });

  it('does not count look-alike domains as official, and subdomains do count', () => {
    const only = (url: string) => scoreResponse(kase, resp([hit({ url })])).officialDomainHit;
    expect(only('https://nothubspot.com/')).toBe(false);
    expect(only('https://hubspot.com.evil.example/')).toBe(false);
    expect(only('https://app.hubspot.com/')).toBe(true);
    expect(only('javascript:1')).toBe(false);
  });

  it('empty results give null shares, not zero or NaN', () => {
    const s = scoreResponse(kase, resp([]));
    expect(s.hits).toBe(0);
    expect(s.dateAvailability).toBeNull();
    expect(s.priceTextShare).toBeNull();
    expect(s.officialDomainHit).toBe(false);
  });

  it('summarises percentiles, failures and cost', () => {
    const scores = [100, 200, 300, 400].map((l) => scoreResponse(kase, resp([hit({})], l, 0.5)));
    scores.push(failedScore(kase, 'rate_limited'));
    const sum = summarise('fake', scores);
    expect(sum).toMatchObject({
      cases: 5,
      failed: 1,
      latencyP50Ms: 200,
      latencyP95Ms: 400,
      totalCostUsd: 2,
      officialDomainHitRate: 1,
    });
    expect(summarise('fake', []).officialDomainHitRate).toBeNull();
  });

  it('runBakeoff turns provider errors into failed scores but lets a replay miss stop the run', async () => {
    const flaky: SearchPort = {
      provider: 'fake',
      search: (req) =>
        req.query.startsWith('Slack')
          ? Promise.reject(new SearchError('rate_limited', 'x'))
          : Promise.resolve(resp([hit({})])),
    };
    const { scores, summary } = await runBakeoff(flaky, BENCHMARK_CASES);
    expect(scores.find((s) => s.caseId === 'slack-pricing')?.errorCode).toBe('rate_limited');
    expect(summary.failed).toBe(1);

    const miss: SearchPort = {
      provider: 'r',
      search: () => Promise.reject(new ReplayMissError('miss')),
    };
    await expect(runBakeoff(miss, BENCHMARK_CASES)).rejects.toBeInstanceOf(ReplayMissError);
  });
});
