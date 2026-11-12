import { afterEach, describe, expect, it } from 'vitest';
import { OfficialDomains } from '../../../src/app/live/registry.js';
import type {
  LlmPort,
  StreamEvent,
  StreamRequest,
  StructuredRequest,
  StructuredResult,
} from '../../../src/shared/llm.js';
import { acknowledge, ask, DAY, eventsOf, scalar, startE2e, type E2eApp } from './harness.js';
import { analysis, fixture } from './scenarios.js';

/**
 * Sourced sentences end to end: real server, database, orchestrator, research service and answer pipeline; only
 * the search provider and the model are replayed. Every name, page and number is [SYNTHETIC] on `.example`.
 */

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

/**
 * Counts model calls per role and lets a synthesis fixture cite a source by its domain: `{{S:host}}` becomes
 * the `[[S:src_..]]` placeholder of the source the prompt lists for that host. A host the prompt does not list
 * resolves to the id remembered from an earlier turn (so a test can cite a source of another turn).
 */
class SpyLlm implements LlmPort {
  readonly roles: string[] = [];
  private readonly remembered = new Map<string, string>();

  constructor(private readonly inner: LlmPort) {}

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.roles.push(r.role);
    return this.inner.structured(r);
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.roles.push(r.role);
    const content = r.messages.at(-1)?.content ?? '';
    const listed = new Map<string, string>();
    for (const m of content.matchAll(/\[\[S:(src_[A-Za-z0-9_-]+)\]\] domain: (\S+)/g)) {
      listed.set(m[2] ?? '', m[1] ?? '');
    }
    for await (const e of this.inner.stream(r)) {
      if (e.type !== 'delta') {
        yield e;
        continue;
      }
      const text = e.text.replace(/\{\{S:([^}]+)\}\}/g, (_all, host: string) => {
        const id = listed.get(host) ?? this.remembered.get(host) ?? 'src_unlisted';
        return `[[S:${id}]]`;
      });
      yield { ...e, text };
    }
    for (const [host, id] of listed) this.remembered.set(host, id);
  }
}

const RUNTIME = 'https://exampleruntime.example/blog/24';
const RUNTIME_TEXT =
  '[SYNTHETIC] ExampleRuntime 24.1.0 is available. It ships a built-in test runner and a faster module loader. Published 3 November 2026.';
const COMMUNITY = 'https://community.example/runtime-24';
const COMMUNITY_TEXT =
  '[SYNTHETIC] A community review says the loader is 30% faster in ExampleRuntime 24.';

const GENERAL_Q = 'What is new in ExampleRuntime 24?';
const OTHER_Q = 'What does the ExampleRuntime test runner do?';

function generalFixture(deltas: string[], more: string[] = []) {
  return fixture({
    analysis: [
      {
        whenMessageContains: GENERAL_Q,
        reply: analysis({
          laneHint: 'research',
          intents: ['general'],
          queries: ['ExampleRuntime 24 new features'],
        }),
      },
      {
        whenMessageContains: OTHER_Q,
        reply: analysis({
          laneHint: 'research',
          intents: ['general'],
          queries: ['ExampleRuntime test runner'],
        }),
      },
    ],
    search: [
      {
        query: 'ExampleRuntime 24 new features',
        steps: [
          {
            hits: [
              { url: RUNTIME, title: '[SYNTHETIC] ExampleRuntime 24', text: RUNTIME_TEXT },
              { url: COMMUNITY, title: '[SYNTHETIC] Review', text: COMMUNITY_TEXT },
            ],
          },
        ],
      },
      {
        query: 'ExampleRuntime test runner',
        steps: [
          {
            hits: [
              {
                url: 'https://docs.example/runner',
                title: '[SYNTHETIC] Runner docs',
                text: '[SYNTHETIC] The runner finds files ending in .test.js and runs them in parallel.',
              },
            ],
          },
        ],
      },
    ],
    // a rule that WOULD match the general page if extraction ran: the count below proves it never does
    extraction: [
      {
        entity: 'ExampleRuntime',
        sourceContains: 'ExampleRuntime 24.1.0',
        statement: {
          kind: 'release',
          plan: null,
          planNorm: null,
          value: null,
          releaseTitle: 'ExampleRuntime 24.1.0',
          releaseKind: 'launch',
          conditions: null,
          quote: 'ExampleRuntime 24.1.0 is available',
          contextQuote: null,
          polarity: 'affirmed',
          modality: 'current',
          effectiveFromText: null,
          eventDateText: null,
          significance: null,
          significanceReason: null,
        },
      },
    ],
    synthesis: [
      { whenMessageContains: GENERAL_Q, deltas },
      { whenMessageContains: OTHER_Q, deltas: more },
    ],
  });
}

describe('T-E2E a general question is search and synthesis only, and its sourced sentences are grounded', () => {
  it('searches without an entity, makes no extraction call, and releases only grounded sourced sentences', async () => {
    let spy: SpyLlm | undefined;
    t = await startE2e({
      fixture: generalFixture([
        'ExampleRuntime 24.1.0 ships a built-in test runner {{S:exampleruntime.example}}. ',
        'ExampleRuntime 24.2.0 adds a watch mode {{S:exampleruntime.example}}. ',
        'The loader is 30% faster {{S:exampleruntime.example}}. ',
        'A community review says the loader is 30% faster {{S:community.example}}. ',
        'ExampleRuntime 24.1.0 was released on 3 November 2026 {{S:exampleruntime.example}}. ',
        'ExampleRuntime 24.1.0 was just released {{S:exampleruntime.example}}. ',
        'Version 25 is planned. ',
        'I can look into any part of it in more depth.',
      ]),
      wrapLlm: (inner) => (spy = new SpyLlm(inner)),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), GENERAL_Q);

    // search, then synthesis: no extraction call, no finding, no extraction state
    expect(spy?.roles).toEqual(['analysis', 'synthesis']);
    expect(eventsOf(turn, 'finding')).toEqual([]);
    expect(eventsOf(turn, 'source')).toHaveLength(2);
    const stages = (eventsOf(turn, 'progress') as Array<{ stage: string }>).map((p) => p.stage);
    expect(stages).toContain('SEARCHING');
    expect(stages).not.toContain('EXTRACTING');
    expect(turn.status).toBe('complete');

    expect(turn.sentences).toEqual([
      'ExampleRuntime 24.1.0 ships a built-in test runner [1].',
      ' A community review says the loader is 30% faster [2].',
      // a release verb quoting its page, attributed and dated, is a sourced statement (ADR-40 amendment)
      ' ExampleRuntime 24.1.0 was released on 3 November 2026 [1].',
      ' I can look into any part of it in more depth.',
    ]);
    const reasons = (eventsOf(turn, 'warning') as Array<{ code: string; text: string }>)
      .filter((w) => w.code === 'sentence_withheld')
      .map((w) => w.text)
      .join(' ');
    expect(reasons).toContain('ungrounded_number'); // 24.2.0, and 30% from the source that does not say it
    expect(reasons).toContain('unsupported_verdict_word'); // "just released": a temporal claim, not a quotation
    expect(reasons).toContain('free_number'); // a number with no citation

    const kinds = (eventsOf(turn, 'answer.sentence_end') as Array<{ kind?: string }>).map(
      (e) => e.kind ?? null,
    );
    expect(kinds).toEqual(['sourced', 'sourced', 'sourced', null]);
    expect(
      (turn.completed?.sentences as Array<{ kind?: string }> | undefined)?.map(
        (s) => s.kind ?? null,
      ),
    ).toEqual(['sourced', 'sourced', 'sourced', null]);
    // nothing sourced becomes an assertion, and nothing was extracted or stored as evidence
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM evidence_statements')).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM entities')).toBe(0);
  });

  it('a general question that names a product still makes no extraction call', async () => {
    let spy: SpyLlm | undefined;
    const base = generalFixture([
      'ExampleRuntime 24.1.0 ships a built-in test runner {{S:exampleruntime.example}}.',
    ]);
    const named = {
      ...base,
      llm: {
        ...base.llm,
        analysis: [
          {
            whenMessageContains: GENERAL_Q,
            reply: analysis({
              laneHint: 'research',
              intents: ['general'],
              entities: [{ text: 'ExampleRuntime', normalized: 'exampleruntime' }],
              queries: ['ExampleRuntime 24 new features'],
            }),
          },
        ],
      },
    };
    t = await startE2e({ fixture: named, wrapLlm: (inner) => (spy = new SpyLlm(inner)) });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), GENERAL_Q);
    expect(spy?.roles.filter((r) => r === 'extraction')).toEqual([]);
    expect(turn.sentences).toEqual(['ExampleRuntime 24.1.0 ships a built-in test runner [1].']);
  });

  it('a sentence citing a source of an earlier turn is withheld', async () => {
    t = await startE2e({
      fixture: generalFixture(
        ['ExampleRuntime 24.1.0 ships a built-in test runner {{S:exampleruntime.example}}.'],
        [
          'The runner runs files in parallel {{S:docs.example}}. ',
          'ExampleRuntime 24.1.0 ships a built-in test runner {{S:exampleruntime.example}}.',
        ],
      ),
      wrapLlm: (inner) => new SpyLlm(inner),
    });
    const user = t.client();
    const conv = await user.newConversation();
    await acknowledge(user, await ask(user, conv, GENERAL_Q));
    const second = await ask(user, conv, OTHER_Q);
    expect(second.sentences).toEqual([
      'According to docs.example: The runner runs files in parallel [1].',
    ]);
    const reasons = (eventsOf(second, 'warning') as Array<{ code: string; text: string }>)
      .map((w) => w.text)
      .join(' ');
    expect(reasons).toContain('unknown_ref');
  });
});

const ZETA_Q = 'What does Zeta Cloud cost?';
const ZETA_AUDIT = 'Is the Zeta Cloud price you gave me still correct?';
const ZETA_URL = 'https://zeta.example/pricing';
const ZETA_QUOTE = 'Pro US$25 per user per month, billed annually';
/** The entity is named only in the title, never near the price: subject binding is weak, nothing is verified. */
const ZETA_PAGE = `[SYNTHETIC]\nPlans\n${ZETA_QUOTE}`;

function zetaFixture() {
  const page = {
    hits: [{ url: ZETA_URL, title: '[SYNTHETIC] Zeta Cloud pricing', text: ZETA_PAGE }],
  };
  const zeta = { text: 'Zeta Cloud', normalized: 'zeta cloud' };
  return fixture({
    analysis: [
      {
        whenMessageContains: ZETA_Q,
        reply: analysis({ laneHint: 'research', intents: ['pricing'], entities: [zeta] }),
      },
      {
        whenMessageContains: ZETA_AUDIT,
        reply: analysis({
          laneHint: 'audit',
          intents: ['pricing'],
          entities: [zeta],
          asksStillCorrect: true,
        }),
      },
    ],
    search: [
      { query: 'Zeta Cloud official site', steps: [{ hits: [] }, { hits: [] }] },
      { query: 'Zeta Cloud pricing', steps: [page, page] },
      { query: 'Zeta Cloud pricing plans per user 2026', steps: [page, page] },
    ],
    extraction: [
      {
        entity: 'Zeta Cloud',
        sourceContains: ZETA_QUOTE,
        statement: {
          kind: 'price',
          plan: 'Pro',
          planNorm: 'pro',
          value: {
            amount: 25,
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
          quote: ZETA_QUOTE,
          contextQuote: null,
          polarity: 'affirmed',
          modality: 'current',
          effectiveFromText: null,
          eventDateText: null,
          significance: null,
          significanceReason: null,
        },
      },
    ],
    synthesis: [
      {
        whenMessageContains: ZETA_Q,
        deltas: [
          'Zeta Cloud: [[F1]]. ',
          'The Zeta Cloud pricing page lists Pro at US$25 per user per month {{S:zeta.example}}.',
        ],
      },
      { whenMessageContains: ZETA_AUDIT, deltas: ['Zeta Cloud: [[F1]].'] },
    ],
  });
}

describe('T-E2E a price that fails verification can be quoted, never remembered as a claim', () => {
  it('quotes the page as a sourced sentence, creates no belief or baseline from it, and a later audit has none', async () => {
    let spy: SpyLlm | undefined;
    t = await startE2e({
      registry: OfficialDomains.none(),
      fixture: zetaFixture(),
      wrapLlm: (inner) => (spy = new SpyLlm(inner)),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, ZETA_Q);

    // extraction still runs for a pricing turn; the evidence is not verified, so nothing is confirmed
    expect(spy?.roles).toContain('extraction');
    const finding = eventsOf(first, 'finding')[0] as { currentStatus: string; current?: unknown };
    expect(finding.currentStatus).not.toBe('confirmed');
    expect(finding.current).toBeUndefined();

    expect(first.sentences[0]).toBe(
      'The Zeta Cloud pricing page lists Pro at US$25 per user per month [1] — not confirmed by my own checks.',
    );
    const kinds = (eventsOf(first, 'answer.sentence_end') as Array<{ kind?: string }>).map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(['sourced']);

    // the sourced sentence is never an assertion, and no assertion carries its value
    const rows = t.app.db
      .prepare('SELECT sentence_index AS i, value_json AS v FROM assertions')
      .all() as Array<{ i: number; v: string | null }>;
    expect(rows.every((r) => r.i === 0)).toBe(true);
    expect(rows.some((r) => (r.v ?? '').includes('25'))).toBe(false);
    expect(scalar(t.app, "SELECT count(*) FROM beliefs WHERE status = 'confirmed'")).toBe(0);

    await acknowledge(user, first);
    t.clock.advance(2 * DAY);
    const audit = await ask(user, conv, ZETA_AUDIT);
    const auditFindings = eventsOf(audit, 'finding') as Array<{ baseline?: unknown }>;
    expect(auditFindings.every((f) => f.baseline === undefined)).toBe(true);
  });
});
