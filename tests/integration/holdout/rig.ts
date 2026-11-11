import { expect } from 'vitest';
import type { ReplayFixtureInput } from '../../../src/app/live/fixture.js';
import { OfficialDomains } from '../../../src/app/live/registry.js';
import {
  acknowledge,
  ask,
  DAY,
  eventsOf,
  scalar,
  startE2e,
  type E2eApp,
  type TurnOutcome,
} from '../e2e/harness.js';
import {
  auditOf,
  extractionOf,
  fixture,
  priceQuery,
  quoteFor,
  researchOf,
  say,
} from '../e2e/scenarios.js';
import type { Client } from '../e2e/harness.js';
import { caseOf, type HoldoutCase, type Verdict } from './cases.js';

/**
 * Helpers for the holdout cases. They only build replay fixtures and read what the real application stored and
 * streamed; they contain no copy of the system's rules. Every vendor, page and price is synthetic.
 */

export { DAY };
export const HOUR = 3_600_000;
export const TUE = Date.UTC(2026, 10, 3, 10, 0, 0);

export const FIRST = 'What does Acme CRM cost?';
export const AGAIN = 'Is the Acme CRM price you gave me still correct?';
export const FALLBACK_QUERY = 'Acme CRM pricing plans per user 2026';

export const URL_GB = 'https://acme.example/en-gb/pricing';
export const URL_US = 'https://acme.example/en-us/pricing';
export const URL_NO_LOCALE = 'https://acme.example/pricing';
export const URL_OTHER_PATH = 'https://acme.example/en-gb/plans';
export const URL_OTHER_DOMAIN = 'https://acme-crm.example/en-gb/pricing';

export const TWO_DOMAINS = (): OfficialDomains =>
  new OfficialDomains({ 'acme crm': ['acme.example', 'acme-crm.example'] });

export type Marker = 'live' | 'cached' | 'none' | 'live-failed';

/** One price statement a page carries and the model "extracts" from it. */
export interface Claim {
  line: string;
  amount: number;
  effective?: string;
}

/** One search result: a synthetic page and what the provider says about it. */
export interface Obs {
  url?: string;
  claim?: Claim;
  extraLines?: string[];
  /** A statement the model wrongly extracts for the vendor (for example a partner product's price). */
  misclaim?: Claim;
  /** Replaces the whole page text. */
  body?: string;
  marker?: Marker;
  lastUpdatedAt?: number;
}

export type Step = Obs[] | 'unavailable';

export const lineFor = (amount: number, effective?: string): string =>
  quoteFor('Acme CRM', amount) + (effective ? ` (effective ${effective})` : '');

/** A vendor price page observation. */
export function o(amount: number, over: Partial<Obs> = {}): Obs {
  return { claim: { line: lineFor(amount), amount }, ...over };
}

/** The same with an explicit effective date written next to the price. */
export function oEff(amount: number, effective: string, over: Partial<Obs> = {}): Obs {
  return { claim: { line: lineFor(amount, effective), amount, effective }, ...over };
}

function pageText(ob: Obs): string {
  if (ob.body !== undefined) return ob.body;
  const lines = [
    '[SYNTHETIC] Acme CRM',
    'Plans and pricing',
    'Acme CRM Starter US$20 per user per month, billed annually',
  ];
  if (ob.claim) lines.push(ob.claim.line);
  for (const l of ob.extraLines ?? []) lines.push(l);
  return lines.join('\n');
}

const MARKERS = {
  live: { source: 'live', status: 'ok' },
  cached: { source: 'cached', status: 'ok' },
  'live-failed': { source: 'live', status: 'failed' },
} as const;

type SearchEntry = NonNullable<ReplayFixtureInput['search']>[number];
type Extraction = NonNullable<NonNullable<ReplayFixtureInput['llm']>['extraction']>[number];

function toStep(s: Step): SearchEntry['steps'][number] {
  if (s === 'unavailable') return { error: 'unavailable' };
  return {
    hits: s.map((ob) => {
      const marker = ob.marker ?? 'live';
      return {
        url: ob.url ?? URL_GB,
        title: '[SYNTHETIC] Acme CRM pricing',
        text: pageText(ob),
        ...(ob.lastUpdatedAt !== undefined ? { lastUpdatedAt: ob.lastUpdatedAt } : {}),
        ...(marker === 'none' ? {} : { marker: MARKERS[marker] }),
      };
    }),
  };
}

function extractionFor(c: Claim): Extraction {
  const base = extractionOf('Acme CRM', c.amount);
  return {
    ...base,
    sourceContains: c.line,
    statement: {
      ...base.statement,
      quote: c.line,
      ...(c.effective !== undefined ? { effectiveFromText: c.effective } : {}),
    },
  };
}

export const DEFAULT_RESEARCH_SYNTH = ['Acme CRM Pro is [[F1]].'];
export const DEFAULT_AUDIT_SYNTH = [
  'I said [[F1:baseline]]. Now the page shows [[F1]]. Acme CRM: [[F1:verdict]].',
];

export interface RigOptions {
  /** One entry per call of the price search, in order: the first is the first turn's. */
  steps: Step[];
  /** 'example' is the synthetic registry file; 'none' registers nothing. */
  registry?: 'example' | 'none' | OfficialDomains;
  researchSynth?: string[];
  auditSynth?: string[];
  /** What the fallback query answers: empty hits or a provider failure. */
  fallback?: 'empty' | 'unavailable';
}

export interface FindingEv {
  entityName: string;
  currentStatus: string;
  verdict: Verdict | null;
  verdictReason: string | null;
  direction?: 'up' | 'down' | 'other';
  changeWindow?: { after: number; notAfter: number };
  effectiveFrom?: number;
  baseline?: { value: { amount: number } };
  current?: { value: { amount: number } | null; verifiedAt: number | null };
  coverage: { freshOfficialFetched: boolean; failure: string | null };
}

export interface AuditResult {
  turn: TurnOutcome;
  finding: FindingEv | undefined;
  verdict: Verdict | null;
  text: string;
  warnings: string[];
}

function many<T>(n: number, v: T): T[] {
  return Array.from({ length: n }, () => v);
}

export class Rig {
  private constructor(
    readonly t: E2eApp,
    readonly user: Client,
    readonly conv: string,
  ) {}

  first: TurnOutcome | undefined;

  static async start(o: RigOptions): Promise<Rig> {
    const claims = new Map<string, Claim>();
    for (const s of o.steps) {
      if (s === 'unavailable') continue;
      for (const ob of s) {
        for (const c of [ob.claim, ob.misclaim]) if (c) claims.set(c.line, c);
      }
    }
    const fallbackStep: SearchEntry['steps'][number] =
      o.fallback === 'unavailable' ? { error: 'unavailable' } : { hits: [] };
    const base = fixture({
      analysis: [researchOf(FIRST, ['Acme CRM']), auditOf(AGAIN, 'Acme CRM')],
      extraction: [...claims.values()].map(extractionFor),
      synthesis: [
        say(FIRST, ...(o.researchSynth ?? DEFAULT_RESEARCH_SYNTH)),
        say(AGAIN, ...(o.auditSynth ?? DEFAULT_AUDIT_SYNTH)),
      ],
      search: [
        { query: priceQuery('Acme CRM'), steps: o.steps.map(toStep) },
        { query: FALLBACK_QUERY, steps: many(10, fallbackStep) },
        {
          query: 'Acme CRM official site',
          steps: many<SearchEntry['steps'][number]>(10, { hits: [] }),
        },
      ],
    });
    // A synthetic stand-in for the entailment judge: it confirms a quote that states the claimed price and a date.
    const fx: ReplayFixtureInput = {
      ...base,
      llm: {
        ...base.llm,
        judge: [
          { whenContains: 'effective', reply: { verdict: 'supports', reason: '[SYNTHETIC]' } },
        ],
      },
    };
    const registry =
      o.registry === 'none'
        ? OfficialDomains.none()
        : o.registry === undefined || o.registry === 'example'
          ? undefined
          : o.registry;
    const t = await startE2e({ fixture: fx, ...(registry ? { registry } : {}) });
    const user = t.client();
    const conv = await user.newConversation();
    return new Rig(t, user, conv);
  }

  /** The first (research) turn. `ack`: true acknowledges everything, false nothing, a number through that sentence. */
  async research(ack: boolean | number = true): Promise<TurnOutcome> {
    const turn = await ask(this.user, this.conv, FIRST);
    this.first = turn;
    if (ack === true) await acknowledge(this.user, turn);
    else if (typeof ack === 'number') await acknowledge(this.user, turn, ack);
    return turn;
  }

  /** The browser acknowledging the first answer after the fact. */
  async ackFirstLate(): Promise<void> {
    if (!this.first) throw new Error('no first turn');
    await acknowledge(this.user, this.first);
  }

  async audit(afterMs: number): Promise<AuditResult> {
    this.t.clock.advance(afterMs);
    const turn = await ask(this.user, this.conv, AGAIN);
    const findings = eventsOf(turn, 'finding') as FindingEv[];
    const finding = findings[0];
    return {
      turn,
      finding,
      verdict: finding?.verdict ?? null,
      text: turn.sentences.join(' '),
      warnings: eventsOf(turn, 'warning').map((w) => (w as { code: string }).code),
    };
  }

  scalar<T = number>(sql: string, ...p: unknown[]): T {
    return scalar<T>(this.t.app, sql, ...p);
  }

  async stop(): Promise<void> {
    await this.t.stop();
  }
}

// ── expectations ────────────────────────────────────────────────────────────────────────────────────────────

/** Checks the verdict against the case definition (written before the run) and its forbidden list. */
export function expectVerdict(c: HoldoutCase | string, actual: Verdict | null): void {
  const def = typeof c === 'string' ? caseOf(c) : c;
  expect(def.forbidden, `${def.id} forbidden verdicts`).not.toContain(actual);
  expect(def.verdicts, `${def.id} expected one of ${JSON.stringify(def.verdicts)}`).toContain(
    actual,
  );
}

/** The assertion event the specification writes on the baseline for each verdict (contracts section 2). */
export const EVENT_OF: Record<Verdict, string | null> = {
  unchanged_confirmed: 'reaffirmed',
  changed: 'superseded_world_changed',
  baseline_incorrect: 'retracted_was_wrong',
  contested: 'contested',
  differs_timing_unknown: 'differs_timing_unknown',
  unable_to_verify: 'unverifiable_now',
  no_evidence_of_change: null,
};

/** Verdict events (not presented / not_presented) a turn wrote. */
export function verdictEvents(rig: Rig, turnId: string): string[] {
  return rig.t.app.db
    .prepare(
      "SELECT status FROM assertion_events WHERE turn_id = ? AND status NOT IN ('presented','not_presented') ORDER BY rowid",
    )
    .pluck()
    .all(turnId) as string[];
}

/**
 * Nothing was stored that contradicts the verdict: the finding row carries the verdict that was streamed, the
 * baseline got exactly the event the mapping prescribes (none for no_evidence_of_change or no verdict), and in
 * particular no world-change event without a changed verdict.
 */
export function expectConsistent(rig: Rig, r: AuditResult): void {
  const rows = rig.t.app.db
    .prepare('SELECT verdict, current_status FROM findings WHERE turn_id = ? ORDER BY ord')
    .all(r.turn.turnId) as Array<{ verdict: string | null; current_status: string }>;
  expect(rows[0]?.verdict ?? null).toBe(r.verdict);
  expect(rows[0]?.current_status).toBe(r.finding?.currentStatus);
  const events = verdictEvents(rig, r.turn.turnId);
  const expected =
    r.verdict === null ? [] : EVENT_OF[r.verdict] === null ? [] : [EVENT_OF[r.verdict]];
  expect(events).toEqual(expected);
  if (r.verdict !== 'changed') expect(events).not.toContain('superseded_world_changed');
  if (r.verdict !== 'unchanged_confirmed') expect(events).not.toContain('reaffirmed');
  if (r.verdict !== 'baseline_incorrect') expect(events).not.toContain('retracted_was_wrong');
}

// ── wording ─────────────────────────────────────────────────────────────────────────────────────────────────

const CHANGE_WORDS =
  /\b(raised|increased|went up|rose|jumped|cut|lowered|reduced|dropped|fell|went down|used to|previously|formerly|no longer|has changed|changed)\b/i;
const SAME_WORDS = /\b(unchanged|same price|no change|not changed|hasn't changed|still showed)\b/i;
const TIMING_WORDS = /\b(since|recently|last week)\b/i;
const OPPOSITE_UP = /\b(cut|lowered|reduced|dropped|fell|went down|down)\b/i;
const OPPOSITE_DOWN = /\b(raised|increased|went up|rose|jumped|up)\b/i;
const NO_SIGN = /\bno sign of a change\b/i;

/** The sentences each verdict renders itself (src/answer/render.ts); removed before scanning for change words. */
const OWN_TEMPLATES: Array<RegExp> = [
  /is different now; I can't tell whether it changed after my answer or my answer was already out of date/g,
  /no sign of a change in what I could check(, though it is listed differently now)?/g,
  /no current evidence either way( \(latest: [^)]*\))?/g,
  /the official page still showed the same price( when checked on [^.]*?(?=\.|$))?/g,
  /my earlier answer was already out of date/g,
  /official sources disagree/g,
  /sources disagree about when this changed/g,
  /couldn't be checked this time \([^)]*\)/g,
  /whether anything changed since then/g,
  /changed between [^.]*?(?=\.|$)/g,
  /changed from [^.]*?(?=\.|$)/g,
];

function stripOwn(text: string): string {
  return OWN_TEMPLATES.reduce((t, re) => t.replace(re, ' '), text);
}

/**
 * The user-visible sentences contain no change or unchanged claim the verdict does not allow (ADR-40 change
 * language; contracts compatible-verdict sets). The rendered verdict phrase itself is allowed.
 */
export function expectWording(
  verdict: Verdict | null,
  text: string,
  direction?: 'up' | 'down' | 'other',
): void {
  const rest = stripOwn(text);
  const bad = (re: RegExp, why: string): void => {
    expect(re.test(rest), `${why} in: ${text}`).toBe(false);
  };
  switch (verdict) {
    case 'changed':
      bad(SAME_WORDS, 'unchanged wording for a changed verdict');
      bad(NO_SIGN, 'no-sign wording for a changed verdict');
      if (direction === 'up') bad(OPPOSITE_UP, 'down wording for an up change');
      if (direction === 'down') bad(OPPOSITE_DOWN, 'up wording for a down change');
      return;
    case 'unchanged_confirmed':
      bad(CHANGE_WORDS, 'change wording for an unchanged verdict');
      return;
    case 'no_evidence_of_change':
      bad(CHANGE_WORDS, 'change wording');
      bad(SAME_WORDS, 'unchanged wording where only no evidence of change is allowed');
      return;
    case 'differs_timing_unknown':
      bad(CHANGE_WORDS, 'change wording where the timing is unknown');
      bad(SAME_WORDS, 'unchanged wording where the price differs');
      bad(TIMING_WORDS, 'timing wording where the timing is unknown');
      return;
    default:
      bad(CHANGE_WORDS, 'change wording');
      bad(SAME_WORDS, 'unchanged wording');
      return;
  }
}

/** No claim that a live check happened where the finding is not confirmed fresh. */
export function expectNoLiveCheckClaim(text: string): void {
  expect(
    /\b(live|just now|today|checked on|still showed|confirmed|verified)\b/i.test(text),
    text,
  ).toBe(false);
}

/** What the stored snapshots say their freshness rests on, newest first. */
export function crawlBases(rig: Rig): string[] {
  return rig.t.app.db
    .prepare('SELECT crawl_basis FROM source_snapshots ORDER BY observed_at DESC, rowid DESC')
    .pluck()
    .all() as string[];
}

export function userIdOf(rig: Rig, turnId: string): string {
  return rig.scalar<string>('SELECT user_id FROM turns WHERE id = ?', turnId);
}

export function eventsOfFinding(turn: TurnOutcome): FindingEv[] {
  return eventsOf(turn, 'finding') as FindingEv[];
}
