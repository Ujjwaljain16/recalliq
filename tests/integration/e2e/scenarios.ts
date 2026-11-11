import type { ReplayFixtureInput } from '../../../src/app/live/fixture.js';

/**
 * Fixture builders. Every vendor, page and price is [SYNTHETIC]: fictional names on `.example` domains.
 * Nothing here was produced by a provider.
 */

type Llm = NonNullable<ReplayFixtureInput['llm']>;
type AnalysisRule = NonNullable<Llm['analysis']>[number];
type AnalysisReply = AnalysisRule['reply'];
type Extraction = NonNullable<Llm['extraction']>[number];
type Synthesis = NonNullable<Llm['synthesis']>[number];
type SearchEntry = NonNullable<ReplayFixtureInput['search']>[number];

export const PRICE_URL = {
  acme: 'https://acme.example/en-gb/pricing',
  beta: 'https://beta.example/en-gb/pricing',
  gamma: 'https://gamma.example/en-gb/pricing',
} as const;

export type Vendor = 'Acme CRM' | 'Beta Suite' | 'Gamma Desk';
const KEY: Record<Vendor, keyof typeof PRICE_URL> = {
  'Acme CRM': 'acme',
  'Beta Suite': 'beta',
  'Gamma Desk': 'gamma',
};
const GUESS: Record<Vendor, string> = {
  'Acme CRM': 'acme.example',
  'Beta Suite': 'beta.example',
  'Gamma Desk': 'gamma.example',
};

export const quoteFor = (v: Vendor, amount: number): string =>
  `${v} Pro US$${amount} per user per month, billed annually`;

export function pricingPage(v: Vendor, amount: number): string {
  return `[SYNTHETIC] ${v}\nPlans and pricing\n${v} Starter US$20 per user per month, billed annually\n${quoteFor(v, amount)}`;
}

export function mention(v: Vendor, guess = true): AnalysisReply['entities'][number] {
  return {
    text: v,
    normalized: v.toLowerCase(),
    ...(guess ? { officialDomainGuess: GUESS[v] } : {}),
  };
}

export function analysis(over: Partial<AnalysisReply> = {}): AnalysisReply {
  return {
    laneHint: 'chat',
    intents: [],
    temporal: [],
    entities: [],
    references: [],
    topicTerms: [],
    asksStillCorrect: false,
    queries: [],
    alternateQueries: [],
    userFacts: [],
    ...over,
  };
}

export const researchOf = (message: string, vendors: Vendor[]): AnalysisRule => ({
  whenMessageContains: message,
  reply: analysis({
    laneHint: 'research',
    intents: ['pricing'],
    entities: vendors.map((v) => mention(v)),
  }),
});

export const auditOf = (message: string, v: Vendor): AnalysisRule => ({
  whenMessageContains: message,
  reply: analysis({
    laneHint: 'audit',
    intents: ['pricing'],
    entities: [mention(v, false)],
    asksStillCorrect: true,
  }),
});

export function extractionOf(v: Vendor, amount: number): Extraction {
  return {
    entity: v,
    sourceContains: quoteFor(v, amount),
    statement: {
      kind: 'price',
      plan: 'Pro',
      planNorm: 'pro',
      value: {
        amount,
        currency: 'USD',
        currencySymbol: 'US$',
        unit: 'per_seat',
        usageUnit: null,
        billingPeriod: 'monthly_billed_annually',
        valueKind: 'exact',
      },
      releaseTitle: null,
      releaseKind: null,
      conditions: null,
      quote: quoteFor(v, amount),
      contextQuote: null,
      polarity: 'affirmed',
      modality: 'current',
      effectiveFromText: null,
      eventDateText: null,
      significance: null,
      significanceReason: null,
    },
  };
}

/** The search query the planner produces for a vendor's current price. */
export const priceQuery = (v: Vendor): string => `${v} pricing`;

export function priceSearch(v: Vendor, ...amounts: Array<number | 'unavailable'>): SearchEntry {
  return priceSearchAt(PRICE_URL[KEY[v]], v, priceQuery(v), ...amounts);
}

/** The same pages served from another url and/or query (look-alike hosts, fallback rounds). */
export function priceSearchAt(
  url: string,
  v: Vendor,
  query: string,
  ...amounts: Array<number | 'unavailable'>
): SearchEntry {
  return {
    query,
    steps: amounts.map((a) =>
      a === 'unavailable'
        ? { error: 'unavailable' as const }
        : {
            hits: [
              {
                url,
                title: `[SYNTHETIC] ${v} pricing`,
                text: pricingPage(v, a),
              },
            ],
          },
    ),
  };
}

export const say = (whenMessageContains: string, ...deltas: string[]): Synthesis => ({
  whenMessageContains,
  deltas,
});

export function fixture(parts: {
  analysis?: AnalysisRule[];
  extraction?: Extraction[];
  synthesis?: Synthesis[];
  search?: SearchEntry[];
}): ReplayFixtureInput {
  return {
    version: 1,
    class: 'synthetic',
    label: '[SYNTHETIC] end-to-end scenario',
    search: parts.search ?? [],
    llm: {
      analysis: parts.analysis ?? [],
      extraction: parts.extraction ?? [],
      synthesis: parts.synthesis ?? [],
      judge: [],
    },
  };
}
