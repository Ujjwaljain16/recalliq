import { describe, expect, it } from 'vitest';
import {
  DomainAuthorityClassifier,
  isOfficialHost,
  registrableDomain,
} from '../../../src/evidence/authority.js';
import { flatten, locateVerbatim, normalizeText } from '../../../src/evidence/text.js';
import { parseDates } from '../../../src/evidence/dates.js';
import { EntailmentJudge, deterministicEntailment } from '../../../src/evidence/entailment.js';
import {
  LlmError,
  type LlmPort,
  type StructuredRequest,
  type StructuredResult,
  type VerifiedEvidence,
} from '../../../src/shared/index.js';
import { FakeBudget } from '../../helpers/budget.js';
import { raw, run, snapshot } from './support.js';

describe('authority tiers', () => {
  const classify = new DomainAuthorityClassifier();
  const official = ['acme.example'];
  const s = (url: string, domain: string) =>
    snapshot('x', { url, urlNorm: url.replace(/^https?:\/\//, ''), domain });

  it('T-AUTH-01: an official pricing page is A1, another official page A2', () => {
    expect(classify.classify(s('https://acme.example/pricing', 'acme.example'), official)).toBe(
      'A1',
    );
    expect(
      classify.classify(s('https://www.acme.example/en-gb/plans', 'acme.example'), official),
    ).toBe('A1');
    expect(
      classify.classify(s('https://pricing.acme.example/', 'pricing.acme.example'), official),
    ).toBe('A1');
    expect(
      classify.classify(s('https://acme.example/blog/new-pricing-post', 'acme.example'), official),
    ).toBe('A2');
    expect(
      classify.classify(s('https://docs.acme.example/changelog', 'docs.acme.example'), official),
    ).toBe('A2');
  });

  it('T-AUTH-02: a look-alike host is never official', () => {
    for (const url of [
      'https://acme.example.evil.example/pricing',
      'https://notacme.example/pricing',
      'https://evil.example/acme.example/pricing',
    ])
      expect(classify.classify(s(url, new URL(url).hostname), official)).toBe('C');
  });

  it('T-AUTH-03: curated secondary sources are B and everything else C', () => {
    expect(classify.classify(s('https://www.g2.com/products/acme', 'g2.com'), official)).toBe('B');
    expect(
      classify.classify(s('https://random-blog.example/acme', 'random-blog.example'), official),
    ).toBe('C');
    expect(classify.classify(s('https://acme.example/pricing', 'acme.example'), [])).toBe('C');
  });

  it('T-AUTH-04: a title that names the vendor does not make a page official', () => {
    const snap = snapshot('x', {
      title: 'Acme official pricing',
      url: 'https://blog.example/post',
      urlNorm: 'blog.example/post',
      domain: 'blog.example',
    });
    expect(classify.classify(snap, official)).toBe('C');
  });

  it('T-AUTH-05: registrable domains', () => {
    expect(registrableDomain('https://pricing.hubspot.com/x')).toBe('hubspot.com');
    expect(registrableDomain('shop.acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('acme.example')).toBe('acme.example');
    expect(isOfficialHost('x.acme.example', ['acme.example'])).toBe(true);
  });
});

describe('text and date helpers', () => {
  it('T-TXT-01: normalisation keeps digits, currency symbols, negations and units distinct', () => {
    const pairs = [
      ['$90 per user', '$9 0 per user'],
      ['$90', '90'],
      ['not available', 'available'],
      ['$90 per month', '$90 per year'],
      ['90 USD', '90 EUR'],
      ['10%', '10'],
    ] as const;
    for (const [a, b] of pairs) expect(normalizeText(a)).not.toBe(normalizeText(b));
  });

  it('T-TXT-02: it folds width, quote style, dashes and spacing', () => {
    expect(normalizeText('＄９０')).toBe('$90');
    expect(normalizeText('It’s “great” – really')).toBe('It\'s "great" - really');
    expect(flatten('a \n  b\t c').flat).toBe('a b c');
  });

  it('T-TXT-03: verbatim matching respects number and word boundaries', () => {
    expect(locateVerbatim('Pro $190 per user', '$90')).toBeNull();
    expect(locateVerbatim('Pro $1,090 per user', '090')).toBeNull();
    expect(locateVerbatim('per users', 'per user')).toBeNull();
    expect(locateVerbatim('Pro $90 per user', '$90 per user')).toEqual({ start: 4, end: 16 });
  });

  it('T-TXT-04: dates parse only when unambiguous', () => {
    expect(parseDates('effective 1 December 2026')[0]?.ms).toBe(Date.UTC(2026, 11, 1));
    expect(parseDates('on December 1, 2026')[0]?.ms).toBe(Date.UTC(2026, 11, 1));
    expect(parseDates('on 2026-12-01')[0]?.ms).toBe(Date.UTC(2026, 11, 1));
    expect(parseDates('in December 2026')[0]).toMatchObject({ precision: 'month' });
    expect(parseDates('on 01/12/2026')).toEqual([]);
    expect(parseDates('on 31 February 2026').filter((d) => d.precision === 'day')).toEqual([]);
    expect(parseDates('on 1 December')).toEqual([]);
  });
});

class FakeJudge implements LlmPort {
  calls = 0;
  constructor(private readonly verdict: 'supports' | 'partial' | 'unsupported' | LlmError) {}
  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls++;
    if (this.verdict instanceof LlmError) return Promise.reject(this.verdict);
    expect(r.role).toBe('judge');
    return Promise.resolve({
      value: r.schema.parse({ verdict: this.verdict, reason: 'because' }),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'fake-small',
      latencyMs: 1,
    });
  }
  stream(): never {
    throw new Error('unused');
  }
}

/** A passing statement whose quote carries two amounts, which the deterministic checks cannot settle. */
function uncertain(): VerifiedEvidence {
  const ev = run(raw('Acme Pro $90 per user per month (Starter $20 per user per month)'));
  expect(ev.verification.status).toBe('pass');
  return ev;
}

describe('T3 entailment', () => {
  it('T-ENT-01: a plain single-amount statement is entailed without a judge', () => {
    expect(deterministicEntailment(run(raw('Acme Pro $90 per user per month')))).toBe('entailed');
  });

  it('T-ENT-02: competing material in the quote leaves doubt', () => {
    expect(deterministicEntailment(uncertain())).toBe('uncertain');
  });

  it('T-ENT-03: the judge is not called when the checks already entail the claim', async () => {
    const llm = new FakeJudge('unsupported');
    const out = await new EntailmentJudge({ llm }).refine(
      run(raw('Acme Pro $90 per user per month')),
      new FakeBudget(60_000),
    );
    expect(out.outcome).toBe('not_needed');
    expect(llm.calls).toBe(0);
  });

  it('T-ENT-04: the judge can confirm', async () => {
    const out = await new EntailmentJudge({ llm: new FakeJudge('supports') }).refine(
      uncertain(),
      new FakeBudget(60_000),
    );
    expect(out.outcome).toBe('confirmed');
    expect(out.evidence.verification.status).toBe('pass');
  });

  it('T-ENT-05: the judge can downgrade pass to weak (partial) or fail (unsupported) and clears the key', async () => {
    const e = uncertain();
    expect(e.beliefKey).not.toBeNull();
    const weak = await new EntailmentJudge({ llm: new FakeJudge('partial') }).refine(
      e,
      new FakeBudget(60_000),
    );
    expect(weak.outcome).toBe('downgraded');
    expect(weak.evidence.verification.status).toBe('weak');
    expect(weak.evidence.beliefKey).toBeNull();
    const failed = await new EntailmentJudge({ llm: new FakeJudge('unsupported') }).refine(
      e,
      new FakeBudget(60_000),
    );
    expect(failed.evidence.verification.status).toBe('fail');
  });

  it('T-ENT-06: the judge can never upgrade a weak or failed statement, and is not even asked', async () => {
    const weak = run(raw('Pro $90 per user per month'), { snap: { title: null } });
    const failed = run(raw('Acme Pro $90 per user per month', { snapshotRef: 'src_x' }));
    expect(weak.verification.status).toBe('weak');
    expect(failed.verification.status).toBe('fail');
    const llm = new FakeJudge('supports');
    for (const e of [weak, failed]) {
      const out = await new EntailmentJudge({ llm }).refine(e, new FakeBudget(60_000));
      expect(out.evidence).toBe(e);
      expect(out.evidence.verification.status).not.toBe('pass');
    }
    expect(llm.calls).toBe(0);
  });

  it('T-ENT-07: a judge failure or an exhausted budget leaves the deterministic result unchanged', async () => {
    const e = uncertain();
    const failing = await new EntailmentJudge({
      llm: new FakeJudge(new LlmError('unavailable', 'x')),
    }).refine(e, new FakeBudget(60_000));
    expect(failing).toEqual({ evidence: e, outcome: 'unavailable' });
    const budget = new FakeBudget(1000);
    budget.spend(1000);
    const llm = new FakeJudge('unsupported');
    const skipped = await new EntailmentJudge({ llm }).refine(e, budget);
    expect(skipped).toEqual({ evidence: e, outcome: 'skipped' });
    expect(llm.calls).toBe(0);
  });

  it('T-ENT-08: a programmer error from the model client is not swallowed', async () => {
    const llm: LlmPort = {
      structured: () => Promise.reject(new TypeError('bug')),
      stream: () => {
        throw new Error('unused');
      },
    };
    await expect(
      new EntailmentJudge({ llm }).refine(uncertain(), new FakeBudget(60_000)),
    ).rejects.toThrow('bug');
  });
});
