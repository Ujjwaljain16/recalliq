import { keyForEvidence, releaseKeyForEvidence } from '../belief/belief-key.js';
import type {
  AuthorityTier,
  CheckResult,
  EntityContext,
  EvidenceVerifier,
  Ms,
  RawEvidence,
  SourceSnapshot,
  TimeFields,
  VerificationCheck,
  VerificationReport,
  VerifiedEvidence,
} from '../shared/index.js';
import { newId, type EvidenceId } from '../shared/ids.js';
import { declarationFitsSymbol, declaredCurrency, findAmounts, markerFor } from './currency.js';
import type { AmountToken, MarkerResult } from './currency.js';
import { hasEffectiveCue, parseDates } from './dates.js';
import { isOfficialHost } from './authority.js';
import {
  findPhrase,
  locateVerbatim,
  normalizeText,
  segmentAt,
  segments,
  splitCells,
  tokenDistance,
  type Located,
  type Segment,
} from './text.js';

export const MAX_QUOTE_CHARS = 400;
export const MAX_CONTEXT_CHARS = 200;
/** The associated header must sit this close above the quote (architecture R2). */
export const HEADER_MAX_DISTANCE = 1500;

type Outcome = CheckResult['outcome'];

function res(check: VerificationCheck, outcome: Outcome, detail?: string): CheckResult {
  return detail === undefined ? { check, outcome } : { check, outcome, detail };
}

// ── marker vocabularies (R2 rules table) ──
const SEAT =
  /(?:\/\s?(?:user|seat|member|agent|licen[cs]e)\b|\bper[\s-]+(?:[\w-]+\s+)?(?:user|seat|member|agent|licen[cs]e)\b|\beach\s+user\b)/i;
const FLAT =
  /\b(?:flat\s+(?:fee|rate)|per\s+(?:account|organi[sz]ation|org|workspace|team)|unlimited\s+users|for\s+your\s+whole\s+team)\b/i;
const METERED =
  /(?:\/\s?(?:GB|TB|MB|hour|request|vCPU|call|message|token)(?:-month)?\b|\bper\s+(?:GB|TB|MB|hour|request|vCPU|compute\s+hour|call|message|token|minute|execution|query)\b|\bper\s+1(?:,000|M)\s+\w+|\bper\s+(?:1,000|1000|million|thousand)\s+\w+)/i;
const MONTHLY = /(?:\/\s?mo(?:nth)?\b|\bper[\s-]+(?:[\w-]+\s+)?month\b|\bmonthly\b|\ba\s+month\b)/i;
const BILLED_ANNUALLY =
  /\b(?:billed|paid|charged)\s+(?:annually|yearly|annual|once\s+a\s+year|every\s+year)\b/gi;
const ANNUAL =
  /(?:\/\s?(?:yr|year)\b|\bper[\s-]+(?:[\w-]+\s+)?(?:year|annum)\b|\byearly\b|\bannual(?:ly)?\b)/i;
const ONE_TIME = /\bone[- ]time\b|\bonce\b|\bsingle\s+payment\b/i;
const NEG_BEFORE =
  /\b(?:no\s+longer|not|discontinued|removed|deprecated|retired|sunset(?:ted)?)\b/gi;
const NEG_AFTER = /\b(?:no\s+longer|discontinued|removed|deprecated|retired|sunset(?:ted)?)\b/i;
const HISTORICAL = /\b(?:was|previously|formerly|used\s+to|old\s+price)\b/gi;
const LOWER_CUE = /(?:starting\s+at|starts\s+at|as\s+low\s+as|beginning\s+at|from)$/i;
const UPPER_CUE = /up\s+to$/i;
const CONDITIONAL =
  /\b(?:if|when|for\s+teams\s+of|with\s+(?:an?\s+)?annual\s+commitment|minimum)\b/i;
const PROMOTIONAL =
  /\b(?:promo(?:tion(?:al)?)?|discount(?:ed)?|first\s+year|limited[- ]time)\b|\d\s?%\s?off\b/i;
const PLANNED_WORDS = /\b(?:will|coming\s+soon)\b/i;

interface Occurrence {
  token: AmountToken;
  marker: MarkerResult;
  /** Offsets in W of marker+amount. */
  start: number;
  end: number;
}

/** One verification run's working state. All offsets are into W = header + "\n" + quote when the header is usable. */
interface Work {
  raw: RawEvidence;
  s: SourceSnapshot;
  e: EntityContext;
  now: Ms;
  qn: string;
  cn: string;
  W: string;
  H: number;
  headerUsable: boolean;
  segs: Segment[];
  occ: Occurrence | null;
  seg: Segment | null;
  scope: string;
}

export interface VerifierOptions {
  newEvidenceId?: () => EvidenceId;
}

/**
 * T0 to T2: citation integrity, verbatim quote and context grounding, relational binding. Pure apart from
 * the injected id factory. The model proposed `raw`; nothing it says is believed until these checks pass.
 */
export class RuleEvidenceVerifier implements EvidenceVerifier {
  private readonly newEvidenceId: () => EvidenceId;

  constructor(opts: VerifierOptions = {}) {
    this.newEvidenceId = opts.newEvidenceId ?? (() => newId('ev'));
  }

  verify(
    raw: RawEvidence,
    s: SourceSnapshot,
    e: EntityContext,
    tier: AuthorityTier,
    now: Ms,
  ): VerifiedEvidence {
    const { checks, effectiveFrom, eventDate } = this.runChecks(raw, s, e, now);
    const status: VerificationReport['status'] = checks.some((c) => c.outcome === 'fail')
      ? 'fail'
      : checks.some((c) => c.outcome === 'weak')
        ? 'weak'
        : 'pass';
    const time = timeFields(s, effectiveFrom, eventDate);
    const base = {
      id: this.newEvidenceId(),
      snapshotId: s.id,
      urlNorm: s.urlNorm,
      entityId: e.id,
      kind: raw.kind,
      fields: raw.fields,
      quote: raw.quote,
      contextQuote: raw.contextQuote,
      polarity: raw.polarity,
      modality: raw.modality,
      authorityTier: tier,
      verification: { status, checks },
      significance: raw.significance,
      ...time,
    };
    const source = { domain: s.domain, urlNorm: s.urlNorm };
    const beliefKey =
      status !== 'pass'
        ? null
        : raw.kind === 'release'
          ? releaseKeyForEvidence(base)
          : keyForEvidence(base, source);
    return { ...base, beliefKey };
  }

  private runChecks(
    raw: RawEvidence,
    s: SourceSnapshot,
    e: EntityContext,
    now: Ms,
  ): { checks: CheckResult[]; effectiveFrom: Ms | null; eventDate: Ms | null } {
    const none = { effectiveFrom: null, eventDate: null };
    // T0: the citation must be to the snapshot and entity this verification was given.
    if (raw.snapshotRef !== s.id || raw.entityRef !== e.id) {
      return {
        checks: [
          res(
            'quote_verbatim',
            'fail',
            'T0 citation integrity: the statement cites a snapshot or entity that was not supplied',
          ),
        ],
        ...none,
      };
    }
    // T1: the quote and its context are verbatim in the snapshot.
    const text = normalizeText(s.text);
    const qn = normalizeText(raw.quote);
    const cn = raw.contextQuote === null ? null : normalizeText(raw.contextQuote);
    const checks: CheckResult[] = [];
    let qLoc: Located | null = null;
    if (qn.length === 0) checks.push(res('quote_verbatim', 'fail', 'empty quote'));
    else if (raw.quote.length > MAX_QUOTE_CHARS)
      checks.push(res('quote_verbatim', 'fail', `quote longer than ${MAX_QUOTE_CHARS} characters`));
    else {
      qLoc = locateVerbatim(text, qn);
      checks.push(
        qLoc
          ? res('quote_verbatim', 'pass')
          : res('quote_verbatim', 'fail', 'quote is not a verbatim passage of the snapshot'),
      );
    }
    let cLoc: Located | null = null;
    if (cn === null) checks.push(res('context_verbatim', 'n/a'));
    else if (cn.length === 0 || (raw.contextQuote ?? '').length > MAX_CONTEXT_CHARS)
      checks.push(res('context_verbatim', 'fail', 'empty or over-long context quote'));
    else {
      cLoc = locateVerbatim(text, cn);
      checks.push(
        cLoc
          ? res('context_verbatim', 'pass')
          : res('context_verbatim', 'fail', 'context is not verbatim in the snapshot'),
      );
    }
    if (!qLoc) return { checks, ...none };

    // Association: the header sits above the quote, close to it, with no other entity's heading between.
    let headerUsable = false;
    if (cn === null) checks.push(res('context_association', 'n/a'));
    else if (!cLoc) checks.push(res('context_association', 'fail', 'context was not found'));
    else {
      const problem = associationProblem(text, cLoc, qLoc, e);
      headerUsable = problem === null;
      checks.push(
        problem === null
          ? res('context_association', 'pass')
          : res('context_association', 'weak', problem),
      );
    }

    const w = this.prepare(raw, s, e, now, qn, headerUsable ? (cn ?? '') : '', headerUsable);
    const priceLike = raw.kind === 'price';
    if (priceLike) {
      checks.push(...this.priceChecks(w));
    } else {
      checks.push(res('value_presence', 'n/a'));
      checks.push(res('currency', 'n/a'), res('unit', 'n/a'), res('billing_period', 'n/a'));
      checks.push(this.titleCheck(w));
    }
    checks.push(...this.bindingChecks(w));
    const date = this.dateCheck(w);
    checks.push(date.check);
    checks.push(this.negationCheck(w));
    checks.push(this.historicalCheck(w));
    checks.push(this.conditionalCheck(w));
    checks.push(this.plannedCheck(w, date.effectiveFrom));
    return {
      checks: orderChecks(checks),
      effectiveFrom: date.effectiveFrom,
      eventDate: date.eventDate,
    };
  }

  private prepare(
    raw: RawEvidence,
    s: SourceSnapshot,
    e: EntityContext,
    now: Ms,
    qn: string,
    header: string,
    headerUsable: boolean,
  ): Work {
    const H = headerUsable ? header.length + 1 : 0;
    const W = headerUsable ? `${header}\n${qn}` : qn;
    const segs = segments(qn).map((g) => ({ ...g, start: g.start + H, end: g.end + H }));
    let occ: Occurrence | null = null;
    const v = raw.fields.value;
    if (raw.kind === 'price' && v) {
      const toks = findAmounts(qn).filter((t) => Math.abs(t.amount - v.amount) < 1e-9);
      const cands = toks
        .filter((t) => qn.charAt(t.end) !== '%')
        .map((t) => ({ token: t, marker: markerFor(qn, t) }));
      const pick = cands.find((c) => c.marker.hasMarker) ?? cands[0];
      if (pick)
        occ = {
          token: pick.token,
          marker: pick.marker,
          start: pick.marker.start + H,
          end: pick.marker.end + H,
        };
    }
    let seg: Segment | null;
    if (occ) seg = segmentAt(segs, occ.start);
    else {
      const anchor = anchorPhrase(raw);
      const hit = anchor ? findPhrase(qn, anchor)[0] : undefined;
      seg = (hit ? segmentAt(segs, hit.start + H) : null) ?? segs[0] ?? null;
    }
    const scope = (seg ? W.slice(seg.start, seg.end) : qn) + (headerUsable ? `\n${header}` : '');
    return { raw, s, e, now, qn, cn: header, W, H, headerUsable, segs, occ, seg, scope };
  }

  // ── price: value, currency, unit, billing period ──
  private priceChecks(w: Work): CheckResult[] {
    const v = w.raw.fields.value;
    if (!v) {
      return [
        res('value_presence', 'fail', 'a price statement carries no value'),
        res('currency', 'n/a'),
        res('unit', 'n/a'),
        res('billing_period', 'n/a'),
      ];
    }
    const out: CheckResult[] = [];
    // value presence
    if (!Number.isFinite(v.amount) || v.amount < 0)
      out.push(res('value_presence', 'fail', 'amount is not a non-negative number'));
    else if (!w.occ) {
      const any = findAmounts(w.qn).some((t) => Math.abs(t.amount - v.amount) < 1e-9);
      out.push(
        res(
          'value_presence',
          'fail',
          any ? 'the amount only appears as a percentage' : 'the amount is not in the quote',
        ),
      );
    } else if (!w.occ.marker.hasMarker) {
      out.push(
        res(
          'value_presence',
          'weak',
          'the amount has no adjacent currency marker, so it may not be a price',
        ),
      );
    } else out.push(res('value_presence', 'pass'));

    out.push(this.currencyCheck(w, v.currency, v.currencySymbol));
    out.push(this.unitCheck(w));
    out.push(this.periodCheck(w));
    return out;
  }

  private currencyCheck(w: Work, claimed: string, claimedSymbol: string | null): CheckResult {
    if (!w.occ) return res('currency', 'n/a', 'no value occurrence');
    const m = w.occ.marker;
    let resolved = m.code;
    if (m.bare) {
      const declared = declaredCurrency(`${w.qn}\n${w.headerUsable ? w.cn : ''}`);
      if (declared && declarationFitsSymbol(declared, m.symbol)) resolved = declared;
    }
    if (claimed !== resolved)
      return res('currency', 'fail', `quote resolves to ${resolved}, extraction says ${claimed}`);
    if (claimedSymbol !== null && !w.qn.includes(claimedSymbol) && m.symbol !== claimedSymbol)
      return res('currency', 'fail', `symbol "${claimedSymbol}" is not in the quote`);
    return res('currency', 'pass', resolved === 'unknown' ? 'currency not stated' : undefined);
  }

  private unitCheck(w: Work): CheckResult {
    const v = w.raw.fields.value;
    if (!v) return res('unit', 'n/a');
    const sc = w.scope;
    if (v.unit !== 'usage' && v.usageUnit !== null)
      return res('unit', 'fail', 'a usage unit was given for a non-usage price');
    switch (v.unit) {
      case 'unspecified':
        return res('unit', 'pass');
      case 'per_seat':
        return SEAT.test(sc)
          ? res('unit', 'pass')
          : res('unit', 'fail', 'per_seat claimed without a seat marker');
      case 'flat':
        if (SEAT.test(sc)) return res('unit', 'fail', 'flat claimed but the text is per seat');
        return FLAT.test(sc)
          ? res('unit', 'pass')
          : res(
              'unit',
              'fail',
              'flat claimed without a positive flat marker (no seat language is not flat)',
            );
      case 'usage': {
        if (!METERED.test(sc)) return res('unit', 'fail', 'usage claimed without a metered marker');
        if (!v.usageUnit) return res('unit', 'fail', 'usage claimed without a usage unit');
        return usageUnitPresent(sc, v.usageUnit)
          ? res('unit', 'pass')
          : res('unit', 'fail', 'the usage unit does not appear in the text');
      }
    }
  }

  private periodCheck(w: Work): CheckResult {
    const v = w.raw.fields.value;
    if (!v) return res('billing_period', 'n/a');
    const sc = w.scope;
    const monthly = MONTHLY.test(sc);
    const billedAnnually = new RegExp(BILLED_ANNUALLY.source, 'i').test(sc);
    const annual = ANNUAL.test(sc.replace(BILLED_ANNUALLY, ' '));
    switch (v.billingPeriod) {
      case 'unspecified':
        return res('billing_period', 'pass');
      case 'monthly':
        if (!monthly)
          return res('billing_period', 'fail', 'monthly claimed without a monthly marker');
        return billedAnnually
          ? res('billing_period', 'fail', 'text says billed annually: monthly_billed_annually')
          : res('billing_period', 'pass');
      case 'annual':
        if (monthly && billedAnnually)
          return res('billing_period', 'fail', 'text is monthly billed annually, not annual');
        return annual || (billedAnnually && !monthly)
          ? res('billing_period', 'pass')
          : res('billing_period', 'fail', 'annual claimed without an annual marker');
      case 'monthly_billed_annually':
        return monthly && billedAnnually
          ? res('billing_period', 'pass')
          : res('billing_period', 'fail', 'needs both a monthly marker and "billed annually"');
      case 'one_time':
        return ONE_TIME.test(sc)
          ? res('billing_period', 'pass')
          : res('billing_period', 'fail', 'one_time claimed without a one-time marker');
    }
  }

  private titleCheck(w: Work): CheckResult {
    const title = w.raw.fields.releaseTitle;
    if (w.raw.kind !== 'release' || !title) return res('value_presence', 'n/a');
    const found = findPhrase(`${w.qn}\n${w.headerUsable ? w.cn : ''}`, title).length > 0;
    return found
      ? res('value_presence', 'pass')
      : res('value_presence', 'weak', 'the release title is not in the quote or its header');
  }

  // ── subject, competitor, plan, intervening tier ──
  private bindingChecks(w: Work): CheckResult[] {
    const aliasHits = (aliases: readonly string[], kind: 'self' | 'other') =>
      aliases.flatMap((a) => findPhrase(w.W, a).map((l) => ({ ...l, kind })));
    const all = dropContained([
      ...aliasHits(w.e.aliases, 'self'),
      ...aliasHits(w.e.otherEntityAliases, 'other'),
    ]);
    const anchorStart = w.occ ? w.occ.start : (w.seg?.start ?? 0);
    const anchorEnd = w.occ ? w.occ.end : anchorStart;
    const inScope = (h: Located) =>
      (w.headerUsable && h.end <= w.H - 1) ||
      (w.seg !== null && h.start >= w.seg.start && h.end <= w.seg.end);
    const scoped = all.filter(inScope);
    const before = scoped.filter((h) => h.end <= anchorStart);
    const after = w.occ ? scoped.filter((h) => h.start >= anchorEnd && w.seg !== null) : [];
    let competitor: CheckResult;
    let closestOther = false;
    const nearest = (hits: typeof scoped, dist: (h: Located) => number) => {
      const sorted = [...hits].sort((a, b) => dist(a) - dist(b));
      const top = sorted[0];
      if (!top) return null;
      const tie = sorted.find((h) => h !== top && dist(h) === dist(top) && h.kind !== top.kind);
      return { top, tie: tie !== undefined };
    };
    const pick =
      before.length > 0
        ? nearest(before, (h) => tokenDistance(w.W, h.end, anchorStart))
        : nearest(after, (h) => tokenDistance(w.W, anchorEnd, h.start));
    if (!pick) competitor = res('competitor_attribution', 'n/a', 'no entity alias near the value');
    else if (pick.tie)
      competitor = res(
        'competitor_attribution',
        'weak',
        'two entities are equally close to the value',
      );
    else if (pick.top.kind === 'other') {
      closestOther = true;
      competitor = res(
        'competitor_attribution',
        'fail',
        'the closest entity to the value is another entity',
      );
    } else competitor = res('competitor_attribution', 'pass');

    const selfInScope = scoped.some((h) => h.kind === 'self');
    let subject: CheckResult;
    if (closestOther)
      subject = res('subject_binding', 'fail', 'the value belongs to another entity');
    else if (selfInScope) subject = res('subject_binding', 'pass');
    else {
      const headerNamed = w.raw.contextQuote
        ? w.e.aliases.some((a) => findPhrase(normalizeText(w.raw.contextQuote ?? ''), a).length > 0)
        : false;
      const titleOrUrl = w.e.aliases.some(
        (a) => findPhrase(`${w.s.title ?? ''} ${w.s.url}`, a).length > 0,
      );
      if (headerNamed && !w.headerUsable)
        subject = res(
          'subject_binding',
          'weak',
          'the entity is only in a header that is not associated with the quote',
        );
      else if (isOfficialHost(w.s.url || w.s.domain, w.e.officialDomains))
        subject = res('subject_binding', 'weak', 'only the official domain suggests the subject');
      else if (titleOrUrl)
        subject = res('subject_binding', 'weak', 'only the page title or URL names the entity');
      else subject = res('subject_binding', 'weak', 'no alias of the entity near the statement');
    }

    const planChecks = this.planChecks(w, anchorStart, anchorEnd);
    return [subject, competitor, ...planChecks];
  }

  private planChecks(w: Work, vp: number, vEnd: number): CheckResult[] {
    const plan = w.raw.fields.planNorm ?? w.raw.fields.plan;
    if (!plan || (w.raw.kind !== 'price' && w.raw.kind !== 'plan_change'))
      return [res('plan_binding', 'n/a'), res('intervening_tier', 'n/a')];
    const others = w.e.plans.filter(
      (p) => normalizeText(p).toLowerCase() !== normalizeText(plan).toLowerCase(),
    );
    const hits = (list: readonly string[], kind: 'plan' | 'other') =>
      list.flatMap((p) => findPhrase(w.W, p).map((l) => ({ ...l, kind })));
    const planHits = dropContained([...hits([plan], 'plan'), ...hits(others, 'other')]);

    // Table column binding: the price cell's column header names the plan.
    const col = this.columnPlan(w, plan, others);
    if (col) return col;

    const seg = w.seg;
    const inSeg = planHits.filter((h) => seg !== null && h.start >= seg.start && h.end <= seg.end);
    const inHeader = planHits.filter((h) => w.headerUsable && h.end <= w.H - 1);
    const claimedAnywhere = findPhrase(w.qn, plan).length > 0 || findPhrase(w.cn, plan).length > 0;
    if (inSeg.length > 0) {
      const b = inSeg.filter((h) => h.end <= vp);
      const a = inSeg.filter((h) => h.start >= vEnd);
      const nearest =
        b.length > 0
          ? [...b].sort((x, y) => y.end - x.end)[0]
          : [...a].sort((x, y) => x.start - y.start)[0];
      if (nearest?.kind === 'plan')
        return [res('plan_binding', 'pass'), res('intervening_tier', 'pass')];
      const claimedInSeg = inSeg.some((h) => h.kind === 'plan');
      if (claimedInSeg)
        return [
          res('plan_binding', 'fail', 'another plan sits between the plan and the value'),
          res(
            'intervening_tier',
            'fail',
            'another known plan of the entity is closer to the value',
          ),
        ];
      return [
        res('plan_binding', 'fail', 'the value is attached to another plan'),
        res('intervening_tier', 'fail', 'another known plan of the entity is closer to the value'),
      ];
    }
    if (inHeader.some((h) => h.kind === 'plan')) {
      return inHeader.some((h) => h.kind === 'other')
        ? [
            res('plan_binding', 'weak', 'the plan is one of several in the header'),
            res('intervening_tier', 'n/a'),
          ]
        : [res('plan_binding', 'pass'), res('intervening_tier', 'pass')];
    }
    return claimedAnywhere
      ? [
          res('plan_binding', 'weak', 'the plan appears, but not with the value'),
          res('intervening_tier', 'n/a'),
        ]
      : [
          res('plan_binding', 'fail', 'the plan does not appear in the quote or its header'),
          res('intervening_tier', 'n/a'),
        ];
  }

  private columnPlan(w: Work, plan: string, others: readonly string[]): CheckResult[] | null {
    if (!w.headerUsable || !w.occ || !w.seg?.isRow) return null;
    const header = w.cn;
    if (!/[|\t]/.test(header)) return null;
    const rowText = w.W.slice(w.seg.start, w.seg.end);
    const hCells = splitCells(header);
    const rCells = splitCells(rowText);
    if (hCells.length !== rCells.length || hCells.length < 2) return null;
    // Which cell holds the amount: count cell separators before it inside the row.
    const rel = w.occ.start - w.seg.start;
    const before = rowText.slice(0, rel);
    const lead = rowText.length - rowText.replace(/^[\s|\t]+/, '').length;
    const idx = (before.slice(Math.min(lead, before.length)).match(/[|\t]/g) ?? []).length;
    const cell = hCells[idx];
    if (cell === undefined) return null;
    if (findPhrase(cell, plan).length > 0)
      return [res('plan_binding', 'pass'), res('intervening_tier', 'pass')];
    if (others.some((p) => findPhrase(cell, p).length > 0))
      return [
        res('plan_binding', 'fail', "the price sits under another plan's column"),
        res('intervening_tier', 'fail', 'the column header names another plan'),
      ];
    return null;
  }

  // ── dates ──
  private dateCheck(w: Work): {
    check: CheckResult;
    effectiveFrom: Ms | null;
    eventDate: Ms | null;
  } {
    const { effectiveFromText: eff, eventDateText: evt } = w.raw;
    if (!eff && !evt)
      return { check: res('date_presence', 'n/a'), effectiveFrom: null, eventDate: null };
    const hay = `${w.headerUsable ? w.cn : ''}\n${w.qn}`;
    let effectiveFrom: Ms | null = null;
    let eventDate: Ms | null = null;
    const problems: Array<{ o: Outcome; d: string }> = [];
    const resolve = (text: string, needsCue: boolean): Ms | null => {
      const t = normalizeText(text);
      const at = hay.indexOf(t);
      if (t.length === 0 || at < 0) {
        problems.push({ o: 'fail', d: `date text "${text}" is not in the quote or header` });
        return null;
      }
      const dates = parseDates(t);
      const d = dates.find((x) => x.precision === 'day') ?? dates[0];
      if (!d) {
        problems.push({ o: 'weak', d: `"${text}" is not an unambiguous date` });
        return null;
      }
      if (d.precision === 'month') {
        problems.push({ o: 'weak', d: `"${text}" gives only a month` });
        return null;
      }
      if (needsCue && !hasEffectiveCue(hay, at + d.index)) {
        problems.push({ o: 'weak', d: `"${text}" is not marked as an effective date` });
        return null;
      }
      return d.ms;
    };
    if (eff) effectiveFrom = resolve(eff, true);
    if (evt) eventDate = resolve(evt, false);
    const worst: Outcome = problems.some((p) => p.o === 'fail')
      ? 'fail'
      : problems.length > 0
        ? 'weak'
        : 'pass';
    return {
      check: res('date_presence', worst, problems.map((p) => p.d).join('; ') || undefined),
      effectiveFrom: worst === 'fail' ? null : effectiveFrom,
      eventDate: worst === 'fail' ? null : eventDate,
    };
  }

  // ── cues ──
  private tokensBefore(w: Work, upTo: number, n: number): string {
    const from = w.seg?.start ?? 0;
    const words = w.W.slice(from, Math.max(from, upTo)).replace(/\|/g, ' ').trim().split(/\s+/);
    return words.slice(-n).join(' ');
  }

  /** The last match of `re` in the window before the value that is not separated from it by another amount. */
  private boundBefore(w: Work, re: RegExp, n: number): RegExpMatchArray | null {
    const upTo = w.occ ? w.occ.start : (w.seg?.end ?? w.W.length);
    const win = this.tokensBefore(w, upTo, n);
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const ms = [...win.matchAll(new RegExp(re.source, flags))];
    const last = ms[ms.length - 1];
    if (!last) return null;
    const tail = win.slice(last.index + last[0].length);
    return /\d/.test(tail) ? null : last;
  }

  private negationCheck(w: Work): CheckResult {
    const negated = w.raw.polarity === 'negated';
    let cue: boolean;
    if (w.occ) {
      cue = this.boundBefore(w, NEG_BEFORE, 6) !== null;
      if (!cue) {
        const after = w.W.slice(w.occ.end, w.seg?.end ?? w.W.length)
          .replace(/\|/g, ' ')
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(' ');
        cue = NEG_AFTER.test(after);
      }
    } else {
      const sc = w.seg ? w.W.slice(w.seg.start, w.seg.end) : w.qn;
      cue = new RegExp(NEG_BEFORE.source, 'i').test(sc);
    }
    if (cue && !negated)
      return res(
        'negation',
        'fail',
        'a negation cue is bound to the statement but polarity is affirmed',
      );
    if (!cue && negated)
      return res('negation', 'fail', 'polarity is negated but the text has no negation cue');
    return res('negation', cue ? 'pass' : 'n/a');
  }

  private historicalCheck(w: Work): CheckResult {
    const historical = w.raw.modality === 'historical';
    let cue: boolean;
    if (w.occ) {
      cue = this.boundBefore(w, HISTORICAL, 3) !== null;
      if (!cue) {
        const o = w.occ;
        cue =
          w.W.slice(Math.max(0, o.start - 2), o.start) === '~~' ||
          w.W.slice(o.end, o.end + 2) === '~~';
      }
    } else {
      const sc = w.seg ? w.W.slice(w.seg.start, w.seg.end) : w.qn;
      cue = new RegExp(HISTORICAL.source, 'i').test(sc);
    }
    if (cue && !historical)
      return res(
        'historical_cue',
        'fail',
        'a historical cue is bound to the value but modality is not historical',
      );
    if (!cue && historical)
      return res(
        'historical_cue',
        'fail',
        'modality is historical but the text has no historical cue',
      );
    return res('historical_cue', cue ? 'pass' : 'n/a');
  }

  private conditionalCheck(w: Work): CheckResult {
    const m = w.raw.modality;
    if (m === 'planned' || m === 'historical') return res('conditional_cue', 'n/a');
    const seg = w.seg ? w.W.slice(w.seg.start, w.seg.end) : w.qn;
    const problems: string[] = [];
    // value kind
    const v = w.raw.fields.value;
    if (v && w.occ) {
      const pre = this.tokensBefore(w, w.occ.start, 3).trimEnd();
      const lower = LOWER_CUE.test(pre);
      const upper = UPPER_CUE.test(pre);
      const expected = lower ? 'lower_bound' : upper ? 'upper_bound' : 'exact';
      if (v.valueKind !== expected)
        problems.push(`value kind is ${v.valueKind} but the text implies ${expected}`);
    }
    const promo = PROMOTIONAL.test(seg);
    const cond = CONDITIONAL.test(seg);
    const allowed: string[] = [];
    if (promo) allowed.push('promotional');
    if (cond) allowed.push('conditional');
    if (allowed.length === 0 && (m === 'conditional' || m === 'promotional'))
      problems.push(`modality ${m} claimed without a ${m} cue in the text`);
    if (allowed.length > 0 && !allowed.includes(m))
      problems.push(`the text carries a ${allowed.join('/')} cue but modality is ${m}`);
    if ((m === 'conditional' || m === 'promotional') && allowed.includes(m)) {
      const cond0 = w.raw.fields.conditions;
      if (!cond0 || cond0.trim().length === 0) problems.push('conditions text is empty');
      else if (!locateVerbatim(`${w.cn}\n${w.qn}`, normalizeText(cond0)))
        problems.push('conditions text is not verbatim in the quote or header');
    }
    return problems.length > 0
      ? res('conditional_cue', 'fail', problems.join('; '))
      : res('conditional_cue', v || allowed.length > 0 ? 'pass' : 'n/a');
  }

  private plannedCheck(w: Work, effectiveFrom: Ms | null): CheckResult {
    const planned = w.raw.modality === 'planned';
    const seg = w.seg ? w.W.slice(w.seg.start, w.seg.end) : w.qn;
    const hay = `${w.headerUsable ? w.cn : ''}\n${w.qn}`;
    let cue = PLANNED_WORDS.test(seg);
    for (const d of parseDates(hay)) {
      if (d.ms > w.now && hasEffectiveCue(hay, d.index)) cue = true;
    }
    if (planned && !cue)
      return res('planned_cue', 'fail', 'modality is planned but the text has no future cue');
    if (cue && !planned && w.raw.modality !== 'historical')
      return res(
        'planned_cue',
        'fail',
        'the text carries a future cue but modality is not planned',
      );
    if (planned) {
      return effectiveFrom === null
        ? res('planned_cue', 'weak', 'a planned statement needs a parseable effective date')
        : res('planned_cue', 'pass');
    }
    return res('planned_cue', 'n/a');
  }
}

const CHECK_ORDER: VerificationCheck[] = [
  'quote_verbatim',
  'context_verbatim',
  'context_association',
  'subject_binding',
  'competitor_attribution',
  'plan_binding',
  'intervening_tier',
  'value_presence',
  'currency',
  'unit',
  'billing_period',
  'date_presence',
  'negation',
  'historical_cue',
  'conditional_cue',
  'planned_cue',
];

function orderChecks(checks: CheckResult[]): CheckResult[] {
  return [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check));
}

function anchorPhrase(raw: RawEvidence): string | null {
  return raw.fields.releaseTitle ?? raw.fields.planNorm ?? raw.fields.plan ?? null;
}

function dropContained<T extends Located>(hits: T[]): T[] {
  return hits
    .filter(
      (h) =>
        !hits.some(
          (o) =>
            o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start,
        ),
    )
    .sort((a, b) => a.start - b.start);
}

function usageUnitPresent(text: string, usageUnit: string): boolean {
  const parts = usageUnit
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_\\s/]?')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
  return re.test(text);
}

/** A heading-like line: markdown heading, a short Title Case line, or a table header row (followed by a rule). */
function isHeadingLike(line: string, next: string | undefined): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/[|\t]/.test(t) && next !== undefined && /^[\s|:\-\t]+$/.test(next.trim()) && /-/.test(next))
    return true;
  if (t.length < 80 && !/[.!?:,;]$/.test(t)) {
    const words = t.split(/\s+/).filter((x) => /\p{L}/u.test(x));
    return words.length > 0 && words.every((x) => /^\p{Lu}/u.test(x) || x.length <= 3);
  }
  return false;
}

/** Why the header is not an associated header for the quote, or null when it is (R2). */
function associationProblem(
  text: string,
  header: Located,
  quote: Located,
  e: EntityContext,
): string | null {
  if (header.end > quote.start) return 'the header does not come before the quote';
  if (quote.start - header.end > HEADER_MAX_DISTANCE)
    return `the header is more than ${HEADER_MAX_DISTANCE} characters above the quote`;
  const between = text.slice(header.end, quote.start).split('\n');
  for (let i = 0; i < between.length; i++) {
    const line = between[i] ?? '';
    if (!isHeadingLike(line, between[i + 1])) continue;
    if (e.otherEntityAliases.some((a) => findPhrase(line, a).length > 0))
      return "another entity's heading sits between the header and the quote";
  }
  return null;
}

/** Time fields (architecture R3). A fresh fetch proves what the page showed at `observedAt`, nothing more. */
export function timeFields(
  s: SourceSnapshot,
  effectiveFrom: Ms | null,
  eventDate: Ms | null,
): TimeFields {
  // A failed crawl is not a fresh fetch, whatever the provider flagged.
  const freshFetch = s.freshFetch && s.crawlStatus === 'ok';
  let displayedAt: Ms | null = null;
  let displayedAtBasis: TimeFields['displayedAtBasis'] = 'unknown';
  if (freshFetch) {
    displayedAt = s.observedAt;
    displayedAtBasis = 'fresh_fetch';
  } else if (s.providerLastUpdatedAt !== null) {
    displayedAt = s.providerLastUpdatedAt;
    displayedAtBasis = 'provider_last_updated';
  } else if (s.providerPublishedAt !== null) {
    displayedAt = s.providerPublishedAt;
    displayedAtBasis = 'provider_published';
  }
  return {
    observedAt: s.observedAt,
    freshFetch,
    providerPublishedAt: s.providerPublishedAt,
    providerLastUpdatedAt: s.providerLastUpdatedAt,
    effectiveFrom,
    eventDate,
    displayedAt,
    displayedAtBasis,
  };
}
