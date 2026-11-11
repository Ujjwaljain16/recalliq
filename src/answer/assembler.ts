import type { PersistedSentence, PlaceholderRef, SentenceIssue } from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { Logger } from '../shared/infrastructure.js';
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
}

export interface AssemblerDeps {
  records: AnswerRecords;
  renderer: Renderer;
  t3a: T3aContext;
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
  private carry: SentenceIssue[] = [];

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
    }
  }

  /** Normal end of the stream: the open sentence is complete. */
  finish(): void {
    if (this.cur) this.close();
  }

  /** The stream was cut: the open sentence is dropped. It was never complete, so it is never released. */
  discardOpen(): void {
    this.cur = null;
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
      if (TERMINATORS.has(ch)) this.endCandidate = true;
      else if (!CLOSERS.has(ch)) this.endCandidate = false;
    }
  }

  private isBoundary(template: string): boolean {
    const t = template.replace(/["'”’)\]}]+$/, '');
    return !ABBREVIATION.test(t) && !LIST_MARKER.test(t);
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
    for (const i of checkFreeText({ template: open.template, refs: open.refs }, this.deps.t3a)) {
      issues.add(i);
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
