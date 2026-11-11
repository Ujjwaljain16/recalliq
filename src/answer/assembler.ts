import type {
  PersistedSentence,
  PlaceholderRef,
  SentenceIssue,
  SentenceKind,
} from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { Logger } from '../shared/infrastructure.js';
import { repeatsRenderedText } from './duplicate.js';
import { attribute, checkSourced, type SourcedContext } from './sourced.js';
import { parsePlaceholderBody, type StreamItem } from './placeholders.js';
import { resolveRef, type AnswerRecords } from './records.js';
import type { Renderer } from './render.js';
import { checkFreeText, type T3aContext } from './t3a.js';

const TERMINATORS = new Set(['.', '!', '?']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);
/**
 * A last word that ends in a full stop without ending the sentence: initialisms written with dots (U.S., U.K.,
 * e.g., i.e., a.m., p.m.), a single capital initial ("J. Smith") and common abbreviations (etc., Inc., Ltd., vs.,
 * Mr., Dr., St., No., approx.). Decimals and versions (1.5, v2.3.1) never reach this: no space follows their dot.
 */
const ABBREVIATION =
  /(?:^|[\s([{"'“‘])(?:(?:[a-z]\.){2,}|(?:etc|inc|ltd|corp|co|vs|approx|mr|mrs|ms|dr|st|no|jr|sr|prof)\.)$/i;
/** A single capital initial ("J. Smith"). Case-sensitive: a lower-case letter before a stop ends a sentence. */
const INITIAL = /(?:^|[\s([{"'“‘])[A-Z]\.$/;
/** What may open the next sentence: a capital, a digit, an opening quote or bracket (a placeholder starts with "["). */
const SENTENCE_START = /[\p{Lu}\p{N}"'“‘([]/u;
const LIST_MARKER = /^\s*(?:[-*]\s+)?\d{1,2}[.)]$/;
const COMPARATIVE =
  /\b(?:cheaper|pricier|costlier|more expensive|less expensive|best|only|most|least|than)\b/i;
const TOKEN = /\[\[[^\]]*\]\]/g;
/** Fewer content words than this, once citations and attribution are removed, and a factual sentence says nothing. */
export const MIN_SENTENCE_WORDS = 3;
const ATTRIBUTION = /^\s*according to\s+[^\s:,]+\s*[:,]?/i;

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

interface OpenSentence {
  sep: string;
  template: string;
  text: string;
  placeholders: PersistedSentence['placeholders'];
  refs: Array<{ ref: PlaceholderRef; finding: Finding | null }>;
  issues: SentenceIssue[];
}

/**
 * A sentence that has been received and checked, and is waiting to be released. Nothing of it has been sent
 * or stored: it is in the `received` state until the release gate (the pipeline) lets it through.
 */
export interface Candidate {
  /** Whitespace that separated it from the previous received sentence. */
  sep: string;
  template: string;
  text: string;
  placeholders: PersistedSentence['placeholders'];
  /** Every reason found to refuse it: dropped placeholders, render integrity, free text. Empty means it passed. */
  issues: SentenceIssue[];
  /** When it passed and compares several findings: the facts the judge must be shown. Otherwise null. */
  judgeFacts: string[] | null;
  /** `verified` when it renders a finding, `sourced` when it cites sources and renders none, else absent. */
  kind?: SentenceKind;
}

export interface AssemblerDeps {
  records: AnswerRecords;
  renderer: Renderer;
  t3a: T3aContext;
  /**
   * What a sourced sentence may rest on: the excerpts shown this turn, the user's message and the entity names.
   * Default: nothing shown, so every sourced sentence is withheld (fail closed).
   */
  sourced?: SourcedContext;
  /** Receives each sentence the moment it ends. Never called for a sentence that is still open. */
  onCandidate: (c: Candidate) => void;
  logger?: Logger;
}

/**
 * Turns parsed stream items into candidate sentences. Boundaries are detected on the TEMPLATE (placeholders are
 * opaque tokens, so a decimal in a rendered price never splits a sentence). Valid placeholders are rendered by
 * code, and when a sentence ends the render-integrity check and the free-text check run on it. The assembler
 * emits nothing and stores nothing: that is the release gate's job, after any judge has answered.
 */
export class SentenceAssembler {
  private cur: OpenSentence | null = null;
  private sep = '';
  private seenAny = false;
  private endCandidate = false;
  /**
   * Whitespace seen after a possible sentence end, held until the next character decides: a capital, digit,
   * quote, bracket or placeholder (or the end of the stream) ends the sentence; anything else continues it.
   */
  private pending: string | null = null;
  private carry: SentenceIssue[] = [];
  /** Characters quoted by the sourced sentences that passed so far (the per-answer cap). */
  private sourcedChars = 0;

  constructor(private readonly deps: AssemblerDeps) {}

  /** True while a sentence has started but not ended. */
  get hasOpenSentence(): boolean {
    return this.cur !== null;
  }

  feed(items: readonly StreamItem[]): void {
    for (const item of items) {
      if (item.type === 'text') this.text(item.text);
      else if (item.type === 'malformed') {
        this.settle();
        this.issue('malformed_placeholder');
      } else {
        this.settle();
        this.placeholder(item.token, item.ref);
      }
    }
  }

  /** Normal end of the stream: the open sentence is complete. */
  finish(): void {
    this.pending = null;
    if (this.cur) this.close();
  }

  /**
   * The stream was cut: the open sentence is dropped. It was never complete, so it is never released. A sentence
   * that had already ended (terminator and whitespace seen, only the next sentence's first character missing) is
   * complete and is closed as it would have been.
   */
  discardOpen(): void {
    if (this.pending !== null) {
      this.pending = null;
      this.close();
    }
    this.cur = null;
  }

  /** A sentence end was pending: whatever comes next (a placeholder, a malformed token) starts a new sentence. */
  private settle(): void {
    if (this.pending === null) return;
    const ws = this.pending;
    this.pending = null;
    this.close();
    this.sep += ws;
  }

  // ── internals ──

  private issue(issue: SentenceIssue): void {
    const list = this.cur ? this.cur.issues : this.carry;
    if (!list.includes(issue)) list.push(issue);
  }

  private open(): OpenSentence {
    if (this.cur) return this.cur;
    const sep = this.seenAny ? this.sep : '';
    this.sep = '';
    this.seenAny = true;
    this.cur = {
      sep,
      template: '',
      text: '',
      placeholders: [],
      refs: [],
      issues: this.carry,
    };
    this.carry = [];
    return this.cur;
  }

  private text(chunk: string): void {
    for (const ch of chunk) {
      if (!this.cur) {
        if (isWhitespace(ch)) {
          if (this.seenAny) this.sep += ch;
          continue;
        }
        this.open();
      }
      const cur = this.cur;
      if (!cur) continue;
      if (this.pending !== null) {
        if (ch === '\n' || ch === '\r') {
          this.settle();
          this.sep += ch;
          continue;
        }
        if (isWhitespace(ch)) {
          this.pending += ch;
          continue;
        }
        if (SENTENCE_START.test(ch)) {
          this.settle();
          this.open();
        } else {
          // a lower-case word after the stop: the sentence goes on, with the whitespace that was held
          cur.template += this.pending;
          cur.text += this.pending;
          this.pending = null;
        }
      }
      const now = this.cur;
      if (!now) continue;
      if (ch === '\n' || ch === '\r') {
        this.close();
        this.sep += ch;
        continue;
      }
      if (isWhitespace(ch) && this.endCandidate && this.isBoundary(now.template)) {
        this.pending = ch;
        continue;
      }
      now.template += ch;
      now.text += ch;
      if (TERMINATORS.has(ch)) this.endCandidate = true;
      else if (!CLOSERS.has(ch)) this.endCandidate = false;
    }
  }

  private isBoundary(template: string): boolean {
    const t = template.replace(/["'”’)\]}]+$/, '');
    return !ABBREVIATION.test(t) && !INITIAL.test(t) && !LIST_MARKER.test(t);
  }

  private placeholder(token: string, ref: PlaceholderRef): void {
    const resolved = resolveRef(ref, this.deps.records);
    if (!resolved.ok) {
      this.issue(resolved.issue);
      return;
    }
    const rendered = this.deps.renderer.render(resolved.record, this.deps.records);
    const cur = this.open();
    const rec = resolved.record;
    cur.template += token;
    cur.text += rendered;
    cur.placeholders.push({
      token,
      ...(rec.kind === 'finding' || rec.kind === 'derived' ? { findingId: rec.finding.id } : {}),
      ...(rec.kind === 'message' ? { messageId: rec.messageId } : {}),
      ...(rec.kind === 'source' ? { snapshotId: rec.snapshotId } : {}),
      rendered,
    });
    cur.refs.push({
      ref,
      finding: rec.kind === 'finding' || rec.kind === 'derived' ? rec.finding : null,
    });
    this.endCandidate = false;
  }

  private close(): void {
    const open = this.cur;
    if (!open) return;
    this.cur = null;
    this.endCandidate = false;

    const issues = new Set<SentenceIssue>(open.issues);
    if (!this.integrityHolds(open)) {
      issues.add('render_mismatch');
      this.deps.logger?.error(
        { templateLength: open.template.length },
        'render integrity check failed: rendered text differs from the record',
      );
    }
    // A sourced sentence cites at least one source and renders no finding: its numbers and names must be in
    // the text of the sources it cites (grounding.ts), and T3a still checks its change and comparison words.
    const rendersFinding = open.refs.some((r) => r.finding !== null);
    const sourced = !rendersFinding && open.refs.some((r) => r.ref.kind === 'source');
    for (const i of checkFreeText(
      { template: open.template, refs: open.refs, sourced },
      this.deps.t3a,
    )) {
      issues.add(i);
    }
    const ctx: SourcedContext = this.deps.sourced ?? {
      userMessage: this.deps.t3a.userMessage,
      entityNames: [],
      shown: new Map(),
    };
    const cited = open.placeholders.flatMap((p) => (p.snapshotId ? [p.snapshotId] : []));
    let quoted = 0;
    if (sourced) {
      const checked = checkSourced(open.template, cited, ctx, this.sourcedChars);
      for (const i of checked.issues) issues.add(i);
      quoted = checked.chars;
    }

    if (repeatsRenderedText(open.template, open.placeholders)) issues.add('duplicate_text');
    if ((rendersFinding || sourced) && saysNothing(open)) issues.add('empty_sentence');
    if (sourced && issues.size === 0) {
      this.sourcedChars += quoted;
      const attributed = attribute(open, cited, ctx);
      open.template = attributed.template;
      open.text = attributed.text;
    }

    let judgeFacts: string[] | null = null;
    if (issues.size === 0) {
      const ords = new Set(open.refs.flatMap((r) => (r.finding ? [r.finding.ord] : [])));
      if (ords.size >= 2 && COMPARATIVE.test(open.template.replace(TOKEN, ' '))) {
        judgeFacts = open.refs.flatMap((r, i) =>
          r.finding ? [`${r.finding.entityName}: ${open.placeholders[i]?.rendered ?? ''}`] : [],
        );
      }
    }
    this.deps.onCandidate({
      sep: open.sep,
      template: open.template,
      text: open.text,
      placeholders: open.placeholders,
      issues: [...issues],
      judgeFacts,
      ...(rendersFinding
        ? { kind: 'verified' as const }
        : sourced
          ? { kind: 'sourced' as const }
          : {}),
    });
  }

  /**
   * The render-integrity check (contracts §3): for every placeholder the authorised record, rendered again,
   * must equal the text that was rendered, and the reference must still be authorised.
   */
  private integrityHolds(open: OpenSentence): boolean {
    const tokens = open.template.match(TOKEN) ?? [];
    if (tokens.length !== open.placeholders.length) return false;
    for (const p of open.placeholders) {
      const ref = parsePlaceholderBody(p.token.slice(2, -2));
      const resolved = ref ? resolveRef(ref, this.deps.records) : null;
      if (!resolved?.ok) return false;
      if (this.deps.renderer.render(resolved.record, this.deps.records) !== p.rendered) {
        return false;
      }
    }
    return true;
  }
}

/**
 * True when a factual sentence (verified or sourced) carries no statement of its own: with every citation
 * removed (a source placeholder renders only "[n]"), an opening "According to <domain>" removed and punctuation
 * removed, fewer than `MIN_SENTENCE_WORDS` words are left. A finding placeholder that renders text is a complete
 * statement by itself (it may render a single word, "changed"), so it counts as enough; one that renders nothing
 * counts for nothing. "Vercel: [[F1]]." says something; "According to vercel.com: [[S:a]], [[S:b]]." does not.
 */
export function saysNothing(sentence: {
  template: string;
  placeholders: PersistedSentence['placeholders'];
}): boolean {
  let i = 0;
  let statements = 0;
  const body = sentence.template.replace(TOKEN, () => {
    const p = sentence.placeholders[i++];
    if (p === undefined || p.snapshotId !== undefined) return ' ';
    if (p.findingId !== undefined) {
      if (p.rendered.trim() !== '') statements += 1;
      return ' ';
    }
    return ` ${p.rendered} `;
  });
  if (statements > 0) return false;
  const words = body
    .replace(ATTRIBUTION, ' ')
    .replace(/\[\d+\]/g, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return (words?.length ?? 0) < MIN_SENTENCE_WORDS;
}
