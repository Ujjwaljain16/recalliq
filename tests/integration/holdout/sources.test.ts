import { afterEach, describe, expect, it } from 'vitest';
import {
  crawlBases,
  DAY,
  eventsOfFinding,
  expectConsistent,
  expectNoLiveCheckClaim,
  expectVerdict,
  expectWording,
  o,
  Rig,
  TWO_DOMAINS,
  URL_OTHER_DOMAIN,
  type Marker,
  type Obs,
  type RigOptions,
} from './rig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

async function start(o: RigOptions): Promise<Rig> {
  rig = await Rig.start(o);
  return rig;
}

describe('HOLDOUT 6: the current source is cached', () => {
  it('HO-06a a cached re-observation never confirms freshness and the wording claims no live check', async () => {
    const r = await start({ steps: [[o(90)], [o(90, { marker: 'cached' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-06a', a.verdict);
    expect(a.finding?.coverage.freshOfficialFetched).toBe(false);
    expect(crawlBases(r)[0]).toBe('cached');
    expectNoLiveCheckClaim(a.text);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-06b an unmarked re-observation never confirms freshness and the wording claims no live check', async () => {
    const r = await start({ steps: [[o(90)], [o(90, { marker: 'none' })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-06b', a.verdict);
    expect(a.finding?.coverage.freshOfficialFetched).toBe(false);
    expect(crawlBases(r)[0]).toBe('unknown');
    expectNoLiveCheckClaim(a.text);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  const weak: Array<[string, Marker, string]> = [
    ['cached', 'cached', 'cached'],
    ['unmarked', 'none', 'unknown'],
    ['a live crawl that failed', 'live-failed', 'unknown'],
  ];
  for (const [label, marker, basis] of weak) {
    it(`HO-06c a first-time answer from ${label} is stale, never confirmed, and claims no check`, async () => {
      const r = await start({ steps: [[o(90, { marker })]] });
      const turn = await r.research();
      const finding = eventsOfFinding(turn)[0];
      expect(finding?.currentStatus).toBe('stale');
      expect(finding?.coverage.freshOfficialFetched).toBe(false);
      expect(turn.sentences.join(' ')).toContain('last seen');
      expectNoLiveCheckClaim(turn.sentences.join(' '));
      expect(crawlBases(r)).toEqual([basis]);
      expect(
        r.scalar("SELECT count(*) FROM source_snapshots WHERE crawl_basis = 'confirmed_live'"),
      ).toBe(0);
      expect(r.scalar("SELECT count(*) FROM beliefs WHERE status = 'confirmed'")).toBe(0);
    });
  }

  it('HO-06e a cached new value after a live re-observation of the old one never changes anything', async () => {
    const r = await start({
      steps: [[o(90)], [o(90)], [o(100, { marker: 'cached' })]],
    });
    await r.research();
    await r.audit(9 * DAY);
    const last = await r.audit(10 * DAY);
    expectVerdict('HO-06e', last.verdict);
    expectWording(last.verdict, last.text);
    expectConsistent(r, last);
  });
});

describe('HOLDOUT 7: the vendor has several domains', () => {
  it("HO-07a an observation of the vendor's other domain does not satisfy same-source bracketing", async () => {
    const r = await start({
      steps: [[o(90)], [o(100, { url: URL_OTHER_DOMAIN })]],
      registry: TWO_DOMAINS(),
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-07a', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-07b old value re-observed on the first domain, new value only on the second: never changed', async () => {
    const r = await start({
      steps: [[o(90)], [o(90)], [o(100, { url: URL_OTHER_DOMAIN })]],
      registry: TWO_DOMAINS(),
    });
    await r.research();
    const mid = await r.audit(8 * DAY);
    expect(mid.verdict).toBe('unchanged_confirmed');
    const last = await r.audit(9 * DAY);
    expectVerdict('HO-07b', last.verdict);
    expectWording(last.verdict, last.text);
    expectConsistent(r, last);
  });

  it('HO-07c conflicting values on the two registered domains in the same window are contested', async () => {
    const r = await start({
      steps: [[o(90)], [o(90), o(100, { url: URL_OTHER_DOMAIN })]],
      registry: TWO_DOMAINS(),
    });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-07c', a.verdict);
    expect(a.finding?.currentStatus).toBe('contested');
    expect(a.text).toContain('official sources disagree');
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });

  it('HO-07d a second domain outside the registry neither contests nor changes the official value', async () => {
    const r = await start({ steps: [[o(90)], [o(90), o(100, { url: URL_OTHER_DOMAIN })]] });
    await r.research();
    const a = await r.audit(8 * DAY);
    expectVerdict('HO-07d', a.verdict);
    expectWording(a.verdict, a.text);
    expectConsistent(r, a);
  });
});

const PARTNER_CUE =
  'Zeta Sync add-on from Zeta Labs: Pro US$15 per user per month, billed annually';
const PARTNER_PLAIN = 'Pro US$15 per user per month, billed annually';
const VENDORLESS_OWN = 'Pro US$90 per user per month, billed annually';

function noPartnerLeak(r: Rig, text: string): void {
  expect(
    r.scalar(
      "SELECT count(*) FROM evidence_statements WHERE verification_status = 'pass' AND payload_json LIKE '%15%' AND quote LIKE '%US$15%'",
    ),
  ).toBe(0);
  expect(r.scalar('SELECT count(*) FROM beliefs WHERE value_json LIKE \'%"amount":15%\'')).toBe(0);
  expect(r.scalar("SELECT count(*) FROM assertions WHERE rendered_text LIKE '%US$15%'")).toBe(0);
  expect(text).not.toContain('US$15');
}

describe('HOLDOUT 8: a third-party product appears on an official vendor page', () => {
  it('HO-08a an add-on price whose own quote names another company is never the vendor price', async () => {
    const r = await start({
      steps: [
        [
          o(90, {
            extraLines: ['Marketplace partners', PARTNER_CUE],
            misclaim: { line: PARTNER_CUE, amount: 15 },
          }),
        ],
      ],
    });
    const turn = await r.research();
    const finding = eventsOfFinding(turn)[0];
    expect(finding?.currentStatus).toBe('confirmed');
    expect(finding?.current?.value?.amount).toBe(90);
    noPartnerLeak(r, turn.sentences.join(' '));
  });

  it('HO-08b a partner-listing price with no vendor name and no cue in its own line is blocked by the page above it', async () => {
    const r = await start({
      steps: [
        [
          o(90, {
            extraLines: ['Marketplace partners', 'Zeta Sync by Zeta Labs', PARTNER_PLAIN],
            misclaim: { line: PARTNER_PLAIN, amount: 15 },
          }),
        ],
      ],
    });
    const turn = await r.research();
    const finding = eventsOfFinding(turn)[0];
    expect(finding?.current?.value?.amount).toBe(90);
    noPartnerLeak(r, turn.sentences.join(' '));
  });

  it('HO-08c a page that holds only the partner price yields no verified price', async () => {
    const partnerOnly: Obs = {
      body: ['[SYNTHETIC] Acme CRM', 'Plans and pricing', 'Marketplace partners', PARTNER_CUE].join(
        '\n',
      ),
      misclaim: { line: PARTNER_CUE, amount: 15 },
    };
    const r = await start({ steps: [[partnerOnly]] });
    const turn = await r.research();
    expect(turn.sentences.join(' ')).toContain('no verified price was found');
    noPartnerLeak(r, turn.sentences.join(' '));
    expect(r.scalar('SELECT count(*) FROM beliefs')).toBe(0);
  });

  it("HO-08d control: the vendor's own plan-tied price with no vendor name binds by registered ownership", async () => {
    const own: Obs = {
      claim: { line: VENDORLESS_OWN, amount: 90 },
    };
    const r = await start({ steps: [[own]] });
    const turn = await r.research();
    const finding = eventsOfFinding(turn)[0];
    expect(finding?.currentStatus).toBe('confirmed');
    expect(finding?.current?.value?.amount).toBe(90);
    expect(
      r.scalar(
        "SELECT count(*) FROM evidence_statements WHERE verification_status = 'pass' AND verification_json LIKE '%registered domain ownership%'",
      ),
    ).toBe(1);
  });

  it('HO-08e control: the same vendor-less price on an unregistered domain stays weak', async () => {
    const own: Obs = {
      claim: { line: VENDORLESS_OWN, amount: 90 },
    };
    const r = await start({ steps: [[own]], registry: 'none' });
    const turn = await r.research();
    expect(turn.sentences.join(' ')).toContain('no verified price was found');
    expect(
      r.scalar("SELECT count(*) FROM evidence_statements WHERE verification_status = 'pass'"),
    ).toBe(0);
    expect(r.scalar('SELECT count(*) FROM beliefs')).toBe(0);
  });
});
