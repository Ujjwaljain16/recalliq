import type { PersistedSentence, SentenceIssue, SentenceStatus } from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { Logger } from '../shared/infrastructure.js';
import type { SseEvent } from '../shared/sse.js';
import { parsePlaceholderBody, type StreamItem } from './placeholders.js';
import { resolveRef, type AnswerRecords } from './records.js';
import type { Renderer } from './render.js';
import { checkFreeText, type T3aContext } from './t3a.js';

const TERMINATORS = new Set(['.', '!', '?']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|approx|inc|ltd|mr|mrs|dr)\.$/i;
const LIST_MARKER = /^\s*(?:[-*]\s+)?\d{1,2}[.)]$/;
const COMPARATIVE = /\b(?:cheaper|more expensive|best|only|most|least|than)\b/i;
const TOKEN = /\[\[[^\]]*\]\]/g;

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

interface OpenSentence {
  index: number;
  /** Whitespace that separated it from the previous sentence (empty for the first). */
  sep: string;
  template: string;
  text: string;
  placeholders: PersistedSentence['placeholders'];
  refs: Array<{
    ref: NonNullable<ReturnType<typeof parsePlaceholderBody>>;
    finding: Finding | null;
  }>;
  issues: SentenceIssue[];
  /** False once any of its events failed to reach the sink. */
  delivered: boolean;
}

export interface AssemblerDeps {
  records: AnswerRecords;
  renderer: Renderer;
  t3a: T3aContext;
  /** Returns false when the event could not be written to the stream. */
  emit: (e: SseEvent) => boolean;
  /**
   * Called for a sentence that passed T3a and needs the T3b judge. Returns true when a judgement was started;
   * false means none will run, and the sentence becomes `unchecked`.
   */
  requestJudge: (index: number, sentenceText: string, facts: string[]) => boolean;
  logger?: Logger;
}

export interface SentenceSummary {
  sentence: PersistedSentence;
  sep: string;
}

/**
 * Turns parsed stream items into sentences: boundaries are detected on the TEMPLATE (placeholders are opaque
 * tokens, so a decimal in a rendered price never splits a sentence), valid placeholders are rendered by code,
 * each sentence is checked when it ends, and events are emitted in the order the contract promises (deltas of a
 * sentence, then its `sentence_end`). It tracks `streamedThrough` exactly: the highest sentence whose every
 * event reached the sink.
 */
export class SentenceAssembler {
  readonly sentences: PersistedSentence[] = [];
  readonly seps: string[] = [];
  streamedThrough = -1;

  private cur: OpenSentence | null = null;
  private sep = '';
  private endCandidate = false;
  private out = '';
  private carry: SentenceIssue[] = [];
  private judgeSkippedWarned = false;

  constructor(private readonly deps: AssemblerDeps) {}

  /** True while a sentence has started but not ended. */
  get hasOpenSentence(): boolean {
    return this.cur !== null;
  }

  feed(items: readonly StreamItem[]): void {
    for (const item of items) {
      if (item.type === 'text') this.text(item.text);
      else if (item.type === 'malformed') this.issue('malformed_placeholder');
      else this.placeholder(item.token, item.ref);
      this.flushOut();
    }
  }

  /** Normal end of the stream: the open sentence is complete, and issues of dropped fragments are attached. */
  finish(): void {
    if (this.cur) this.close();
    if (this.carry.length > 0) {
      const last = this.sentences[this.sentences.length - 1];
      if (last) this.update(last.index, 'unverified', this.carry);
      this.carry = [];
    }
  }

  /**
   * The stream was cut. The open sentence is kept exactly as streamed and marked `truncated`; it is NOT counted
   * in `streamedThrough` because its last delta was never written. `lostFragment` flags a held `[[`.
   */
  truncate(lostFragment: boolean): void {
    if (lostFragment) this.issue('malformed_placeholder');
    const open = this.cur;
    if (!open) return;
    this.flushOut();
    this.cur = null;
    this.sentences.push(this.build(open, true).sentence);
    this.seps.push(open.sep);
  }

  /**
   * Applies a late result. It may confirm a `verified` sentence or downgrade it; it can never raise the
   * status of a sentence that was not verified. Emits a `verification` event.
   */
  update(index: number, status: SentenceStatus, issues: readonly SentenceIssue[]): void {
    const s = this.sentences[index];
    if (!s || s.status === 'truncated') return;
    const rank: Record<SentenceStatus, number> = {
      verified: 3,
      no_claims: 3,
      unchecked: 2,
      unverified: 1,
      truncated: 0,
    };
    if (rank[status] > rank[s.status]) return; // never an upgrade
    const merged = [...new Set([...s.issues, ...issues])];
    const changed = status !== s.status || merged.length !== s.issues.length;
    s.status = status;
    s.issues = merged;
    if (changed || status === 'verified')
      this.deps.emit({ event: 'verification', data: { index, status, issues: merged } });
  }

  // ── internals ──

  private issue(issue: SentenceIssue): void {
    const list = this.cur ? this.cur.issues : this.carry;
    if (!list.includes(issue)) list.push(issue);
  }

  private open(): OpenSentence {
    if (this.cur) return this.cur;
    const sep = this.sentences.length === 0 ? '' : this.sep;
    this.sep = '';
    this.cur = {
      index: this.sentences.length,
      sep,
      template: '',
      text: '',
      placeholders: [],
      refs: [],
      issues: this.carry,
      delivered: true,
    };
    this.carry = [];
    this.out += sep;
    return this.cur;
  }

  private text(chunk: string): void {
    for (const ch of chunk) {
      if (!this.cur) {
        if (isWhitespace(ch)) {
          if (this.sentences.length > 0) this.sep += ch;
          continue;
        }
        this.open();
      }
      const cur = this.cur;
      if (!cur) continue;
      if (ch === '\n' || ch === '\r') {
        this.close();
        this.sep += ch;
        continue;
      }
      if (isWhitespace(ch) && this.endCandidate && this.isBoundary(cur.template)) {
        this.close();
        this.sep += ch;
        continue;
      }
      cur.template += ch;
      cur.text += ch;
      this.out += ch;
      if (TERMINATORS.has(ch)) this.endCandidate = true;
      else if (!CLOSERS.has(ch)) this.endCandidate = false;
    }
  }

  private isBoundary(template: string): boolean {
    const t = template.replace(/["'”’)\]}]+$/, '');
    return !ABBREVIATION.test(t) && !LIST_MARKER.test(t);
  }

  private placeholder(
    token: string,
    ref: NonNullable<ReturnType<typeof parsePlaceholderBody>>,
  ): void {
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
    this.out += rendered;
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

  private flushOut(): void {
    if (this.out === '' || !this.cur) return;
    const ok = this.deps.emit({
      event: 'answer.delta',
      data: { sentenceIndex: this.cur.index, text: this.out },
    });
    if (!ok) this.cur.delivered = false;
    this.out = '';
  }

  private close(): void {
    const open = this.cur;
    if (!open) return;
    this.flushOut();
    this.cur = null;
    this.endCandidate = false;
    const { sentence, judgeFacts } = this.build(open, false);
    this.sentences.push(sentence);
    this.seps.push(open.sep);

    let announced: SentenceStatus | 'pending_judge' = sentence.status;
    if (judgeFacts) {
      if (this.deps.requestJudge(sentence.index, sentence.text, judgeFacts))
        announced = 'pending_judge';
      else {
        sentence.status = 'unchecked';
        sentence.issues = [...sentence.issues, 'judge_unavailable'];
        announced = 'unchecked';
        if (!this.judgeSkippedWarned) {
          this.judgeSkippedWarned = true;
          this.deps.emit({
            event: 'warning',
            data: {
              code: 'judge_skipped',
              text: 'A comparison could not be double-checked in time.',
            },
          });
        }
      }
    }
    const ok = this.deps.emit({
      event: 'answer.sentence_end',
      data: { index: sentence.index, status: announced, issues: sentence.issues },
    });
    if (ok && open.delivered) this.streamedThrough = sentence.index;
  }

  /** Runs the integrity check and T3a, and derives the status. Pure apart from logging. */
  private build(
    open: OpenSentence,
    truncated: boolean,
  ): { sentence: PersistedSentence; judgeFacts: string[] | null } {
    const issues = new Set<SentenceIssue>(open.issues);
    if (!this.integrityHolds(open)) {
      issues.add('render_mismatch');
      this.deps.logger?.error(
        { sentenceIndex: open.index },
        'render integrity check failed: rendered text differs from the record',
      );
    }
    for (const i of checkFreeText({ template: open.template, refs: open.refs }, this.deps.t3a))
      issues.add(i);

    const status: SentenceStatus = truncated
      ? 'truncated'
      : issues.size > 0
        ? 'unverified'
        : open.placeholders.length > 0
          ? 'verified'
          : 'no_claims';

    let judgeFacts: string[] | null = null;
    if (status === 'verified') {
      const ords = new Set(open.refs.flatMap((r) => (r.finding ? [r.finding.ord] : [])));
      if (ords.size >= 2 && COMPARATIVE.test(open.template.replace(TOKEN, ' '))) {
        judgeFacts = open.refs.flatMap((r, i) =>
          r.finding ? [r.finding.entityName + ': ' + (open.placeholders[i]?.rendered ?? '')] : [],
        );
      }
    }
    return {
      sentence: {
        index: open.index,
        text: open.text,
        template: open.template,
        status,
        issues: [...issues],
        placeholders: open.placeholders,
      },
      judgeFacts,
    };
  }

  /**
   * The render-integrity check (contracts §3): for every placeholder the authorised record, rendered again,
   * must equal the text that was delivered, and the reference must still be authorised.
   */
  private integrityHolds(open: OpenSentence): boolean {
    const tokens = open.template.match(TOKEN) ?? [];
    if (tokens.length !== open.placeholders.length) return false;
    for (const p of open.placeholders) {
      const ref = parsePlaceholderBody(p.token.slice(2, -2));
      const resolved = ref ? resolveRef(ref, this.deps.records) : null;
      if (!resolved?.ok) return false;
      if (this.deps.renderer.render(resolved.record, this.deps.records) !== p.rendered)
        return false;
    }
    return true;
  }
}
