import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { Finding, FindingSet } from '../../../src/shared/findings.js';
import type { MessageId, SnapshotId } from '../../../src/shared/ids.js';
import type { ResolvedContext } from '../../../src/shared/memory.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import { FakeBudget } from '../../helpers/budget.js';
import { T_NOV_3, context, finding, sink } from '../../unit/answer/builders.js';

/**
 * The cases of a live sweep (real model and search provider, empty database, Europe/London), replayed offline
 * through the real answer pipeline with the model's sentences as it wrote them. Page texts are [SYNTHETIC]
 * stand-ins that state what the live pages stated.
 */

const NODE = 'src_nodejs' as SnapshotId;
const TS = 'src_tsblog' as SnapshotId;
const GH = 'src_ghdocs' as SnapshotId;
const VERCEL = 'src_vercel' as SnapshotId;
const AP = 'src_activepieces' as SnapshotId;
const NETLIFY = 'src_netlify' as SnapshotId;
const USA = 'src_usatoday' as SnapshotId;

const PAGES: Record<string, { domain: string; text: string }> = {
  [NODE]: {
    domain: 'nodejs.org',
    text: 'Node.js 24 introduces a new permission model and ships npm 11. Node.js 24 was released on 6 May 2025.',
  },
  [TS]: {
    domain: 'devblogs.microsoft.com',
    text: 'Announcing TypeScript 5.9. TypeScript 5.9 is the latest stable release of TypeScript.',
  },
  [GH]: {
    domain: 'docs.github.com',
    text: 'GitHub Copilot Business is listed at $19 USD per granted seat per month.',
  },
  [VERCEL]: { domain: 'vercel.com', text: 'Vercel pricing. Pro plan for teams.' },
  [AP]: {
    domain: 'activepieces.com',
    text: 'Vercel Pro is listed at $20 per user per month. Netlify Pro is listed at $19 per member per month.',
  },
  [NETLIFY]: {
    domain: 'netlify.com',
    text: 'Netlify Pro costs $19 per member per month.',
  },
  [USA]: {
    domain: 'usatoday.com',
    text: 'Get-in tickets for the U.S. Grand Prix at Circuit of The Americas begin at $598, while Las Vegas Grand Prix prices start at $666.',
  },
};

function set(ids: SnapshotId[], findings: Finding[] = []): FindingSet {
  return {
    turnId: 'trn_1',
    createdAt: T_NOV_3,
    findings,
    sources: Object.fromEntries(
      ids.map((id) => {
        const p = PAGES[id];
        if (!p) throw new Error(id);
        return [
          id,
          {
            url: `https://${p.domain}/page`,
            title: `[SYNTHETIC] ${p.domain}`,
            domain: p.domain,
            tier: 'B' as const,
            observedAt: T_NOV_3,
            content: { text: p.text, publishedAt: T_NOV_3 },
          },
        ];
      }),
    ),
  };
}

async function run(
  deltas: string[],
  findings: FindingSet,
  user: string,
  ctx: ResolvedContext = context(),
) {
  const llm = new FakeLlm().queueStream({ deltas });
  const s = sink();
  const r = await new LlmAnswerPipeline({ llm, options: { judge: false } }).run(
    {
      findings,
      recall: new Map<MessageId, { text: string; localTime: string }>(),
      ctx,
      userMessage: user,
      window: [],
      tz: 'Europe/London',
    },
    new FakeBudget(60_000),
    s.emit,
  );
  const content = llm.streamCalls[0]?.messages.at(-1)?.content ?? '';
  return { r, events: s.events, content, texts: r.sentences.map((x) => x.text) };
}

const withheld = (events: SseEvent[]): string =>
  events
    .flatMap((e) =>
      e.event === 'warning' && e.data.code === 'sentence_withheld' ? [e.data.text] : [],
    )
    .join(' ');

const SINCE_MONDAY: ResolvedContext['temporal'][number] = {
  mention: {
    text: 'since Monday',
    expr: { kind: 'since', anchor: { kind: 'weekday', weekday: 1, modifier: 'last' } },
    role: 'change_since',
  },
  candidates: [
    {
      startMs: Date.UTC(2026, 10, 9),
      endMs: Date.UTC(2026, 10, 10),
      localDate: '2026-11-09',
      tz: 'Europe/London',
    },
  ],
  status: 'resolved',
};

describe('defect 1a: a release verb that quotes its page in a sourced sentence', () => {
  it('"What is new in Node.js 24?": the attributed sentence that says what the page introduces is released', async () => {
    const { texts, r, events } = await run(
      [
        `According to nodejs.org, Node.js 24 introduces a new permission model [[S:${NODE}]]. `,
        `Node.js 24 was released on 6 May 2025 [[S:${NODE}]].`,
      ],
      set([NODE]),
      'What is new in Node.js 24?',
    );
    expect(withheld(events)).toBe('');
    expect(texts).toEqual([
      'According to nodejs.org, Node.js 24 introduces a new permission model [1].',
      'According to nodejs.org: Node.js 24 was released on 6 May 2025 [1].',
    ]);
    expect(r.sentences.every((s) => s.kind === 'sourced')).toBe(true);
  });

  it('"What is the latest stable version of TypeScript?": a quoted release is released, attributed', async () => {
    const { texts } = await run(
      [`TypeScript 5.9 is the latest stable release of TypeScript [[S:${TS}]].`],
      set([TS]),
      'What is the latest stable version of TypeScript?',
    );
    expect(texts).toEqual([
      'According to devblogs.microsoft.com: TypeScript 5.9 is the latest stable release of TypeScript [1].',
    ]);
  });

  it('also in a turn with findings (the broad lexicon applies there)', async () => {
    const { texts } = await run(
      [`According to nodejs.org, Node.js 24 introduces a new permission model [[S:${NODE}]].`],
      set([NODE], [finding(1, { entityName: 'ExampleCo1' })]),
      'What is new in Node.js 24 and what does ExampleCo1 cost?',
    );
    expect(texts).toHaveLength(1);
  });

  it.each([
    ['since', 'Node.js 24 introduces a new permission model since May'],
    ['recently', 'Node.js 24 recently introduced a new permission model'],
    ['just', 'Node.js 24 just shipped npm 11'],
    ['now', 'Node.js 24 now ships npm 11'],
    ['no longer', 'Node.js 24 introduces a new permission model and no longer needs flags'],
    ['this week', 'Node.js 24 was released this week'],
    ['a change word', 'Node.js 24 introduces a new permission model and changed npm'],
    ['a price-change word', 'Node.js 24 introduces a new permission model and cut prices'],
  ])('withholds a release verb tied to time or change (%s)', async (_label, sentence) => {
    const { texts, events } = await run(
      [`${sentence} [[S:${NODE}]].`],
      set([NODE]),
      'What is new in Node.js 24?',
    );
    expect(texts).toEqual([]);
    expect(withheld(events)).toContain('unsupported_verdict_word');
  });

  it('with a "since" anchor: an undated release quote is withheld, a quote with the page\'s date is released', async () => {
    const ctx = context({ temporal: [SINCE_MONDAY] });
    const undated = await run(
      [`According to nodejs.org, Node.js 24 introduces a new permission model [[S:${NODE}]].`],
      set([NODE]),
      'What has Node.js released since Monday?',
      ctx,
    );
    expect(undated.texts).toEqual([]);
    expect(withheld(undated.events)).toContain('unsupported_verdict_word');
    const dated = await run(
      [`According to nodejs.org, Node.js 24 was released on 6 May 2025 [[S:${NODE}]].`],
      set([NODE]),
      'What has Node.js released since Monday?',
      ctx,
    );
    expect(dated.texts).toEqual([
      'According to nodejs.org, Node.js 24 was released on 6 May 2025 [1].',
    ]);
  });

  it('a date the page does not give is still withheld by grounding', async () => {
    const { texts, events } = await run(
      [`According to nodejs.org, Node.js 24 was released on 10 November 2026 [[S:${NODE}]].`],
      set([NODE]),
      'What has Node.js released since Monday?',
      context({ temporal: [SINCE_MONDAY] }),
    );
    expect(texts).toEqual([]);
    expect(withheld(events)).toContain('ungrounded_number');
  });

  it('a negative release claim is never a quotation', async () => {
    const { texts } = await run(
      [`According to nodejs.org, nothing was released for Node.js 24 [[S:${NODE}]].`],
      set([NODE]),
      'What is new in Node.js 24?',
    );
    expect(texts).toEqual([]);
  });

  it('a VERIFIED sentence still needs a releases_found verdict for a release verb', async () => {
    const f = finding(1, { entityName: 'ExampleCo1' });
    const { texts, events } = await run(
      [
        'ExampleCo1 launched [[F1]]. ',
        `ExampleCo1 introduced [[F1]], according to nodejs.org [[S:${NODE}]].`,
      ],
      set([NODE], [f]),
      'What does ExampleCo1 cost?',
    );
    expect(texts).toEqual([]);
    expect(withheld(events)).toContain('unsupported_verdict_word');
  });
});

describe('defect 2: a sentence made only of citations', () => {
  it('"According to vercel.com: [1], [3]." is withheld (empty_sentence)', async () => {
    const { texts, events } = await run(
      [
        `According to vercel.com: [[S:${VERCEL}]], [[S:${AP}]]. `,
        `[[S:${VERCEL}]]. `,
        `Vercel Pro is listed at $20 per user per month [[S:${AP}]].`,
      ],
      set([VERCEL, AP]),
      'How much does Vercel cost?',
    );
    expect(texts).toEqual([
      'According to activepieces.com: Vercel Pro is listed at $20 per user per month [2].',
    ]);
    expect(withheld(events)).toContain('empty_sentence');
  });

  it('a verified sentence whose placeholder renders nothing and has under three words is withheld too', async () => {
    const f = finding(1, { entityName: 'ExampleCo1', verdict: null });
    const { texts, events } = await run(['ExampleCo1: [[F1:baseline]].'], set([], [f]), 'Price?');
    expect(texts).toEqual([]);
    expect(withheld(events)).toMatch(/inapplicable_variant|empty_sentence/);
  });
});

describe('defect 3: a finding with no verified value and a source that states one', () => {
  const copilot = finding(1, {
    entityName: 'GitHub Copilot Business',
    currentStatus: 'unknown',
    current: undefined,
  });

  it('the finding reads as what it is, never "no verified price was found"', async () => {
    const { texts } = await run(
      ['GitHub Copilot Business: [[F1]].'],
      set([GH], [copilot]),
      'How much is GitHub Copilot Business?',
    );
    expect(texts).toEqual([
      'GitHub Copilot Business: I could not confirm a price through my checks.',
    ]);
  });

  it('the model is told the finding has no verified value and that it may quote the page instead', async () => {
    const { texts, content } = await run(
      [
        `According to docs.github.com, GitHub Copilot Business is listed at $19 USD per granted seat per month [[S:${GH}]].`,
      ],
      set([GH], [copilot]),
      'How much is GitHub Copilot Business?',
    );
    expect(content).toMatch(/F1: entity "GitHub Copilot Business".*no verified value/);
    // the sourced sentence alone is a complete answer; no contradicting finding line is required
    expect(texts).toEqual([
      'According to docs.github.com, GitHub Copilot Business is listed at $19 USD per granted seat per month [1].',
    ]);
  });

  it('a finding whose search failed is not marked: its failure must still be said', async () => {
    const failed = finding(1, {
      entityName: 'GitHub Copilot Business',
      currentStatus: 'unable_to_verify',
      verdict: null,
      verdictReason: 'search_timeout',
      current: undefined,
    });
    const { content } = await run(
      ['GitHub Copilot Business: [[F1]].'],
      set([GH], [failed]),
      'Price?',
    );
    expect(content).not.toContain('no verified value');
    expect(content).toContain("couldn't be checked this time (the search timed out)");
  });
});

describe('defect 4: one paragraph per entity in a comparison', () => {
  it('the observed shape is regrouped, with no space before a line break and no stray blank lines', async () => {
    const vercel = finding(1, {
      entityName: 'Vercel',
      currentStatus: 'unknown',
      current: undefined,
    });
    const netlify = finding(2, {
      entityName: 'Netlify',
      currentStatus: 'unknown',
      current: undefined,
    });
    const { r } = await run(
      [
        'Vercel: [[F1]]. \n',
        `According to activepieces.com, Vercel Pro is listed at $20 per user per month [[S:${AP}]].\n`,
        'Netlify: [[F2]]. \n\n\n',
        `Netlify Pro costs $19 per member per month [[S:${NETLIFY}]]. `,
        'Vercel has $9.99 hidden fees. ',
        'Both are popular.',
      ],
      set([AP, NETLIFY], [vercel, netlify]),
      'Compare Vercel and Netlify pricing',
    );
    expect(r.rendered).toBe(
      'Vercel: I could not confirm a price through my checks. According to activepieces.com, Vercel Pro is listed at $20 per user per month [1].' +
        '\n\nNetlify: I could not confirm a price through my checks. Netlify Pro costs $19 per member per month [2].' +
        ' Both are popular.',
    );
    expect(r.rendered).not.toMatch(/ \n/);
    expect(r.rendered).not.toMatch(/\n{3,}/);
  });
});

describe('defects 6 and 7: abbreviations and the spelling of the domain', () => {
  const F1 =
    'According to usatoday.com, get-in tickets for the U.S. Grand Prix at Circuit of The Americas begin at $598, while Las Vegas Grand Prix prices start at $666';

  it('the observed sentence with "U.S." stays one sentence, attributed once', async () => {
    const { texts, events } = await run(
      [`${F1} [[S:${USA}]].`],
      set([USA]),
      'How much are Formula 1 Grand Prix tickets?',
    );
    expect(withheld(events)).toBe('');
    expect(texts).toEqual([`${F1} [1].`]);
  });

  it('the same sentence split across stream chunks at the abbreviation', async () => {
    const { texts } = await run(
      [
        'According to usatoday.com, get-in tickets for the U.S.',
        ' Grand Prix at Circuit of The Americas begin at $598, while Las Vegas Grand Prix prices start at $666',
        ` [[S:${USA}]].`,
      ],
      set([USA]),
      'How much are Formula 1 Grand Prix tickets?',
    );
    expect(texts).toEqual([`${F1} [1].`]);
  });

  it('a model-written "According to Usatoday.com" keeps the domain as stored', async () => {
    const { texts } = await run(
      [`${F1.replace('usatoday.com', 'Usatoday.com')} [[S:${USA}]].`],
      set([USA]),
      'How much are Formula 1 Grand Prix tickets?',
    );
    expect(texts).toEqual([`${F1} [1].`]);
  });

  it('the attribution added in code is never capitalised', async () => {
    const { texts } = await run(
      [
        `Get-in tickets for the U.S. Grand Prix at Circuit of The Americas begin at $598 [[S:${USA}]].`,
      ],
      set([USA]),
      'How much are Formula 1 Grand Prix tickets?',
    );
    expect(texts).toEqual([
      'According to usatoday.com: Get-in tickets for the U.S. Grand Prix at Circuit of The Americas begin at $598 [1].',
    ]);
  });
});
