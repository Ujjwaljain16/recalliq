import { claimSignature, repeatsClaim, type ClaimSignature } from './duplicate.js';
import type {
  AnswerPipeline,
  AnswerResult,
  PersistedSentence,
  QuickAnswerInput,
  SentenceIssue,
} from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { Logger, TurnBudget } from '../shared/infrastructure.js';
import { LlmError, type LlmPort } from '../shared/llm.js';
import type { EventSink, SseEvent } from '../shared/sse.js';
import {
  JUDGE_SCHEMA_NAME,
  JUDGE_SYSTEM,
  buildJudgeMessages,
  judgeSchema,
} from '../llm/prompts/judge.js';
import { QUICK_PREFACE, QUICK_SYSTEM, buildQuickMessages } from '../llm/prompts/quick.js';
import {
  SYNTHESIS_CONTINUATION_RULES,
  SYNTHESIS_PROMPT_VERSION,
  SYNTHESIS_SYSTEM,
  buildSynthesisMessages,
  type SynthesisFindingView,
} from '../llm/prompts/synthesis.js';
import { SentenceAssembler, type Candidate } from './assembler.js';
import { PlaceholderParser } from './placeholders.js';
import { buildRecords, resolveRef, type AnswerRecords } from './records.js';
import { defaultRenderer, negativeQualifier, recordCitations, type Renderer } from './render.js';
import type { T3aContext } from './t3a.js';
import { selectExcerpts } from './excerpts.js';
import type { SourcedContext } from './sourced.js';
import { termsOf } from '../shared/terms.js';
import type { SnapshotId } from '../shared/ids.js';

type RunInput = Parameters<AnswerPipeline['run']>[0];
type RunResult = AnswerResult;

export interface AnswerPipelineOptions {
  /** Below this much remaining time, synthesis runs in compact mode (architecture §H). Default 12000. */
  compactBelowMs?: number;
  /** Output limit in compact mode. Default 600. */
  compactMaxTokens?: number;
  /** Output limit otherwise. Default 1200. */
  maxTokens?: number;
  /** Run the T3b judge for comparisons. Default true. */
  judge?: boolean;
  /** Cap for one judge call. Default 4000. */
  judgeCapMs?: number;
  /** Write the quick sourced section (`quick()`). Default true; replay sets it false so fixtures stay valid. */
  quick?: boolean;
  /** Cap for the quick section. Default 8000. */
  quickCapMs?: number;
  /** Output limit of the quick section. Default 400. */
  quickMaxTokens?: number;
  /**
   * Say every finding the model left out in a line written in code. Default false: fixtures and unit tests script
   * the whole answer; the live application turns it on.
   */
  completeFindings?: boolean;
}

export interface AnswerPipelineDeps {
  llm: LlmPort;
  logger?: Logger;
  /** Injectable so the integrity check can be tested against a faulty renderer. */
  renderer?: Renderer;
  options?: AnswerPipelineOptions;
}

export const SYNTH_COMPACT_BELOW_MS = 12_000;

/**
 * The answer pipeline: the model writes a template, code renders the facts, and only validated sentences leave
 * the pipeline (ADR-40). Three states stay distinct: `received` (model text held here, never sent, never
 * stored), `validated` (placeholders authorised, rendered, integrity and free-text checks passed, and the judge
 * agreed where it applies) and `presented` (the browser acknowledged it, which is not this class's business).
 *
 * The release unit is the sentence. At its end a sentence is checked; if it passes, ONE `answer.delta` with its
 * complete rendered text is emitted, then `answer.sentence_end`. A sentence that fails any check, or needs the
 * judge and gets no answer within the judge cap, is WITHHELD: not emitted, not stored, it consumes no sentence
 * index, and a `sentence_withheld` warning names the issue codes. An interrupted stream never releases its
 * incomplete trailing sentence.
 *
 * Failure contract: this method does not throw for model or stream failure. A stream that fails or is aborted
 * yields `interrupted: true` and an `error` event; already released sentences are kept. If nothing was released
 * (`sentences.length === 0`), the caller must write its own deterministic reply: this is also what happens when
 * every sentence was withheld (`interrupted: false`, with an `empty_answer` error event).
 * It never emits `answer.completed` or `turn.completed` (they need ids that exist only after persistence), and
 * it never emits `pending_judge` or `verification` events. It never touches acknowledgement: `streamedThrough`
 * is the highest released sentence whose events reached the sink.
 */
export class LlmAnswerPipeline implements AnswerPipeline {
  readonly promptVersion = SYNTHESIS_PROMPT_VERSION;
  private readonly renderer: Renderer;

  constructor(private readonly deps: AnswerPipelineDeps) {
    this.renderer = deps.renderer ?? defaultRenderer;
  }

  async run(input: RunInput, budget: TurnBudget, emit: (e: SseEvent) => void): Promise<RunResult> {
    return this.produce(input, budget, emit, null);
  }

  /**
   * The quick sourced section. It is the same release machinery as `run` (same sentence assembler, same
   * sourced-sentence validation against the excerpts the model was shown) over a records set that holds sources
   * and no findings, so only sourced sentences can pass. Differences: its own prompt, its own cap, no judge, and
   * no `error` or `deadline_compacted` event: it is an optional first part and its failure is silent. One
   * sentence written in code opens it, released together with the first sourced sentence.
   */
  async quick(input: QuickAnswerInput, budget: TurnBudget, emit: EventSink): Promise<RunResult> {
    const none: RunResult = {
      sentences: [],
      streamedThrough: -1,
      interrupted: false,
      template: '',
      rendered: '',
    };
    const opts = this.deps.options ?? {};
    if (opts.quick === false || input.cut.aborted) return none;
    if (budget.remaining() < (opts.compactBelowMs ?? SYNTH_COMPACT_BELOW_MS)) return none;
    const own = budget.signalFor('quick', opts.quickCapMs ?? 8_000);
    if (own.aborted) return none;
    return this.produce(
      {
        findings: {
          turnId: input.turnId,
          createdAt: input.createdAt,
          findings: [],
          sources: input.sources,
        },
        recall: new Map(),
        ctx: input.ctx,
        ...(input.entities ? { entities: input.entities } : {}),
        ...(input.releasesChecked ? { releasesChecked: true } : {}),
        userMessage: input.userMessage,
        window: [],
        tz: input.tz,
      },
      budget,
      emit,
      AbortSignal.any([own, input.cut]),
    );
  }

  /** `quickSignal` is null for the full answer, the stop signal of the quick section otherwise. */
  private async produce(
    input: RunInput,
    budget: TurnBudget,
    emit: (e: SseEvent) => void,
    quickSignal: AbortSignal | null,
  ): Promise<RunResult> {
    const quick = quickSignal !== null;
    const opts = this.deps.options ?? {};
    const records = buildRecords(input);
    const log = this.deps.logger;

    let sinkBroken = false;
    const safeEmit = (e: SseEvent): boolean => {
      if (sinkBroken) return false;
      try {
        emit(e);
        return true;
      } catch {
        sinkBroken = true;
        log?.warn(
          { event: e.event },
          'event sink failed: later sentences are not counted as streamed',
        );
        return false;
      }
    };

    const findings = input.findings?.findings ?? [];
    const t3a: T3aContext = {
      userMessage: input.userMessage,
      localDates: input.ctx.temporal.flatMap((t) => t.candidates.map((c) => c.localDate)),
      findings,
      nameNumerals: nameNumerals(input.ctx.entities),
      changeSince: input.ctx.temporal.some((t) => t.mention.role === 'change_since'),
    };
    // The excerpts the model is shown are also the only text a sourced sentence may rest on.
    const excerpts = selectExcerpts(
      records.sources,
      termsOf(input.userMessage, ...input.ctx.entities.map((e) => e.name)),
    );
    const sourced: SourcedContext = {
      userMessage: input.userMessage,
      entityNames: [
        ...input.ctx.entities.flatMap((e) => [e.name, ...e.aliases]),
        ...findings.map((f) => f.entityName),
      ],
      shown: new Map(
        excerpts.map((x) => [x.id, { title: x.title, domain: x.domain, text: x.excerpt }]),
      ),
    };

    // ── the release gate: candidates pass through it one at a time, in order ──
    const released: PersistedSentence[] = [];
    const seps: string[] = [];
    let streamedThrough = -1;
    let judgeSkippedWarned = false;
    const judgeOn = opts.judge ?? true;
    let gate: Promise<void> = Promise.resolve();
    const layout = new ParagraphLayout(findings);

    const withhold = (issues: readonly SentenceIssue[]): void => {
      safeEmit({
        event: 'warning',
        data: {
          code: 'sentence_withheld',
          text: `A sentence was withheld because it did not pass validation (${issues.join(', ')}).`,
        },
      });
    };

    // Sourced sentences already said (by the quick section, or earlier in this answer) are not said again.
    const said: ClaimSignature[] = (input.earlier ?? []).map(claimSignature);
    // A recalled message quoted by a sentence written in code is not quoted again by the model.
    const quoted = new Set([
      ...(input.earlier ?? []).flatMap(quotesOf),
      ...(input.quotedBefore ?? []),
    ]);
    const release = async (c: Candidate): Promise<void> => {
      if (c.issues.length > 0) return withhold(c.issues);
      const own = quotesOf(c.text);
      if (own.some((q) => quoted.has(q))) return;
      for (const q of own) quoted.add(q);
      if (c.kind === 'sourced') {
        const sig = claimSignature(c.text);
        // A quick sentence about something other than what the question names (another company's page that
        // matched the search) is not shown as an answer to it.
        const about = input.entities ?? [];
        if (
          quick &&
          about.length > 0 &&
          !about.some((n) => namesEntity(withoutAttribution(c.text), n))
        )
          return withhold(['off_topic']);
        // When the turn checks releases, a release is said once that check has counted it, with its coverage.
        // A quick sentence saying "X launched Y" could otherwise sit above "X: no releases found".
        if (
          quick &&
          input.releasesChecked === true &&
          RELEASE_CLAIM.test(withoutAttribution(c.text))
        )
          return withhold(['unchecked_release']);
        // A repeat is dropped without a warning: nothing the user needs is missing.
        if (said.some((s) => repeatsClaim(sig, s))) return;
        said.push(sig);
      }
      // The quick section holds sourced sentences only: no citation, no release.
      if (quick && c.kind !== 'sourced') return withhold(['ungrounded_source']);
      if (c.judgeFacts) {
        if (!judgeOn || !budget.admit('judge')) {
          if (!judgeSkippedWarned) {
            judgeSkippedWarned = true;
            safeEmit({
              event: 'warning',
              data: {
                code: 'judge_skipped',
                text: 'A comparison could not be double-checked in time.',
              },
            });
          }
          return withhold(['judge_unavailable']);
        }
        const verdict = await this.judge(c.text, c.judgeFacts, budget, opts.judgeCapMs ?? 4000);
        if (verdict === 'partial') return withhold(['judge_partial']);
        if (verdict === 'unsupported') return withhold(['judge_unsupported']);
        if (verdict === 'unavailable') return withhold(['judge_unavailable']);
      }
      if (quick && released.length === 0) {
        emitReleased({
          sep: '',
          template: QUICK_PREFACE,
          text: QUICK_PREFACE,
          placeholders: [],
          issues: [],
          judgeFacts: null,
        });
      }
      deliver(c);
    };

    // A finding line that only says "no verified price" / "couldn't be checked" is held for the sourced sentence
    // that may follow about the same entity, so the two are one statement instead of a contradiction.
    let held: { c: Candidate; entity: string; qualifier: string } | null = null;
    const nameOf = new Map(findings.map((f) => [f.id, f.entityName]));
    const flushHeld = (): void => {
      const h = held;
      held = null;
      if (h) emitReleased(h.c);
    };
    // A finding line written in code can come out the same for two findings of one entity ("couldn't be
    // checked" for both its price and its releases): it is said once.
    const sentLines = new Set<string>();
    const deliver = (c: Candidate): void => {
      const only1 = c.placeholders.length === 1 ? c.placeholders[0] : undefined;
      if (c.kind !== 'sourced' && only1?.findingId) {
        // A bare finding line ("HubSpot: X", or "HubSpot: HubSpot: X"): nothing but the company name around
        // the rendered value. Two such lines with the same rendering are one line.
        const name = nameOf.get(only1.findingId) ?? '';
        const around = c.text
          .replace(only1.rendered, ' ')
          .split(name)
          .join(' ')
          .replace(/[^\p{L}\p{N}]/gu, '');
        if (around === '' || around.toLowerCase() === 'releases') {
          const key = `${name}|${only1.rendered}`;
          if (sentLines.has(key)) return;
          sentLines.add(key);
        }
      }
      const h = held;
      if (h && c.kind === 'sourced' && namesEntity(c.text, h.entity)) {
        held = null;
        emitReleased(mergeQualifier(c, h.c, h.qualifier));
        return;
      }
      flushHeld();
      const only = c.placeholders.length === 1 ? c.placeholders[0] : undefined;
      const qualifier = only ? negativeQualifier(only.rendered) : null;
      const entity = only?.findingId ? nameOf.get(only.findingId) : undefined;
      if (!quick && excerpts.length > 0 && c.kind === 'unconfirmed' && qualifier && entity) {
        held = { c, entity, qualifier };
        return;
      }
      emitReleased(c);
    };

    const emitReleased = (c: Candidate): void => {
      const index = released.length;
      const sep = layout.separator(c, index);
      const status = c.placeholders.length > 0 ? 'verified' : 'no_claims';
      released.push({
        index,
        text: c.text,
        template: c.template,
        status,
        issues: [],
        placeholders: c.placeholders,
        ...(c.kind ? { kind: c.kind } : {}),
      });
      seps.push(sep);
      const sentDelta = safeEmit({
        event: 'answer.delta',
        data: { sentenceIndex: index, text: sep + c.text },
      });
      const sentEnd =
        sentDelta &&
        safeEmit({
          event: 'answer.sentence_end',
          data: { index, status, issues: [], ...(c.kind ? { kind: c.kind } : {}) },
        });
      if (sentEnd && streamedThrough === index - 1) streamedThrough = index;
    };

    const assembler = new SentenceAssembler({
      records,
      renderer: this.renderer,
      t3a,
      sourced,
      logger: log,
      onCandidate: (c) => {
        gate = gate.then(() => release(c));
      },
    });

    // ── synthesis ──
    const compact = !quick && budget.remaining() < (opts.compactBelowMs ?? SYNTH_COMPACT_BELOW_MS);
    if (compact) {
      safeEmit({
        event: 'warning',
        data: { code: 'deadline_compacted', text: 'Time is short, so this answer is brief.' },
      });
    }

    let interrupted = false;
    const parser = new PlaceholderParser();
    if (budget.remaining() <= 0) {
      interrupted = true;
      if (!quick) safeEmit(errorEvent(new LlmError('timeout', 'no time left')));
    } else {
      const signal = quickSignal ?? budget.signalFor('synthesis', budget.remaining());
      const sourceViews = excerpts.map((x) => ({
        id: x.id,
        domain: x.domain,
        title: x.title,
        published:
          x.publishedAt === null ? null : new Date(x.publishedAt).toISOString().slice(0, 10),
        excerpt: x.excerpt,
      }));
      const earlier = input.earlier ?? [];
      const messages = quick
        ? buildQuickMessages({ sources: sourceViews, userMessage: input.userMessage })
        : buildSynthesisMessages({
            ...promptData(findings, records, this.renderer, input),
            sources: sourceViews,
            compact,
            ...(earlier.length > 0 ? { earlier } : {}),
          });
      const stream = this.deps.llm.stream({
        role: 'synthesis',
        system: quick
          ? QUICK_SYSTEM
          : earlier.length > 0
            ? SYNTHESIS_SYSTEM + SYNTHESIS_CONTINUATION_RULES
            : SYNTHESIS_SYSTEM,
        messages,
        maxTokens: quick
          ? (opts.quickMaxTokens ?? 400)
          : compact
            ? (opts.compactMaxTokens ?? 600)
            : (opts.maxTokens ?? 1200),
        signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const aborted = new Promise<never>((_, reject) => {
        const fire = (): void => reject(new LlmError('cancelled', 'synthesis aborted'));
        if (signal.aborted) fire();
        else signal.addEventListener('abort', fire, { once: true });
      });
      aborted.catch(() => undefined);
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) break;
          if (next.value.type === 'delta') assembler.feed(parser.push(next.value.text));
        }
        assembler.feed(parser.flush());
        assembler.finish();
      } catch (e) {
        interrupted = true;
        if (quick)
          log?.warn({ error: String(e) }, 'quick section stopped; what was released stays');
        else safeEmit(errorEvent(e));
        // Do not wait for a stream that may never end: ask it to stop and move on.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        assembler.discardOpen(); // the incomplete trailing sentence is never released
      }
    }

    await gate; // sentences already complete finish their checks (and judge) in order
    flushHeld();

    // Every finding is reported. The model chooses what to write, and it sometimes leaves a company or a check
    // out; a finding no released sentence mentions is then said in a line written in code ("<Company>: [[F3]]."),
    // which passes the same checks as any other sentence. Not after an interruption: there is no time left.
    if (
      opts.completeFindings === true &&
      !quick &&
      !interrupted &&
      released.length > 0 &&
      budget.remaining() > 0
    ) {
      const mentioned = new Set(
        released.flatMap((s) => s.placeholders.flatMap((p) => (p.findingId ? [p.findingId] : []))),
      );
      const missing = findings.filter((f) => !mentioned.has(f.id));
      if (missing.length > 0) {
        const tail = new PlaceholderParser();
        for (const f of missing) assembler.feed(tail.push(`${f.entityName}: [[F${f.ord}]]. `));
        assembler.feed(tail.flush());
        assembler.finish();
        await gate;
        flushHeld();
      }
    }
    if (!quick && !interrupted && released.length === 0) {
      safeEmit({
        event: 'error',
        data: {
          code: 'empty_answer',
          text: 'No sentence of the answer could be released.',
          recoverable: false,
        },
      });
    }

    return {
      sentences: released,
      streamedThrough,
      interrupted,
      template: join(seps, released, (s) => s.template),
      rendered: join(seps, released, (s) => s.text),
    };
  }

  /** The T3b judge. Never throws and never hangs: no answer within the cap is `unavailable`. */
  private async judge(
    sentence: string,
    facts: string[],
    budget: TurnBudget,
    capMs: number,
  ): Promise<'supported' | 'partial' | 'unsupported' | 'unavailable'> {
    const signal = budget.signalFor('judge', capMs);
    const expired = new Promise<'unavailable'>((resolve) => {
      if (signal.aborted) resolve('unavailable');
      else signal.addEventListener('abort', () => resolve('unavailable'), { once: true });
    });
    const answer = this.deps.llm
      .structured({
        role: 'judge',
        system: JUDGE_SYSTEM,
        messages: buildJudgeMessages(sentence, facts),
        schema: judgeSchema,
        schemaName: JUDGE_SCHEMA_NAME,
        maxTokens: 50,
        signal,
      })
      .then((r) => r.value.verdict)
      .catch((): 'unavailable' => 'unavailable');
    return Promise.race([answer, expired]);
  }
}

/**
 * The whitespace before each released sentence. The model's own separator is normalised (spaces never sit before
 * a line break; one line break stays one, two or more become one blank line). When the turn has findings for two
 * or more entities, sentences are grouped one paragraph per entity: a sentence about the same entity as the
 * previous released one continues its paragraph, a sentence about another entity opens a new paragraph. A
 * sentence is about an entity when it renders only that entity's findings, or, with no finding, when its text
 * names exactly one of the finding entities. Withheld sentences never reach this, so they leave no stray lines.
 */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ParagraphLayout {
  private readonly names: Array<{ name: string; re: RegExp }>;
  private readonly byFinding: Map<string, string>;
  private previous: string | null = null;

  constructor(findings: readonly Finding[]) {
    this.byFinding = new Map(findings.map((f) => [f.id, f.entityName]));
    const distinct = [...new Set(findings.map((f) => f.entityName))];
    this.names =
      distinct.length >= 2
        ? distinct.map((name) => ({
            name,
            re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu'),
          }))
        : [];
  }

  separator(c: Pick<Candidate, 'sep' | 'text' | 'placeholders'>, index: number): string {
    const entity = this.entityOf(c);
    const prev = this.previous;
    this.previous = entity;
    if (index === 0) return '';
    if (entity !== null && prev !== null) return entity === prev ? ' ' : '\n\n';
    const breaks = (c.sep.match(/\n/g) ?? []).length;
    if (breaks === 0) return ' ';
    if (this.names.length > 0 || breaks >= 2) return '\n\n';
    return '\n';
  }

  private entityOf(c: Pick<Candidate, 'text' | 'placeholders'>): string | null {
    if (this.names.length === 0) return null;
    const own = new Set(
      c.placeholders.flatMap((p) =>
        p.findingId === undefined ? [] : [this.byFinding.get(p.findingId) ?? ''],
      ),
    );
    if (own.size > 0) return own.size === 1 ? ([...own][0] ?? null) : null;
    const named = this.names.filter((n) => n.re.test(c.text));
    return named.length === 1 ? (named[0]?.name ?? null) : null;
  }
}

/** A sentence that reports a launch, release or announcement. */
const RELEASE_CLAIM =
  /\b(?:launch(?:es|ed)?|releas(?:e|es|ed)|ship(?:s|ped)|introduc(?:es|ed)|announc(?:es|ed)|publish(?:es|ed)|unveil(?:s|ed)|roll(?:s|ed)? out|debut(?:s|ed)?)\b/i;

/** The sentence without its "According to <domain>" opening, which names the source, not the subject. */
const withoutAttribution = (text: string): string => text.replace(/according to \S+/gi, ' ');

/** Quoted passages of at least 20 characters, normalised for comparison. */
export function quotesOf(text: string): string[] {
  return [...text.matchAll(/["“]([^"”]{20,})["”]/g)].map((m) =>
    (m[1] ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
  );
}

const namesEntity = (text: string, entity: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(entity)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * One statement from a sourced sentence and the finding line about the same entity that says its own checks found
 * no price: the sourced sentence stays, the finding's negative follows it as a short qualifier. The finding's
 * placeholder stays in the template (so the sentence is typed from it), and its stored rendering is the qualifier.
 */
function mergeQualifier(sourced: Candidate, finding: Candidate, qualifier: string): Candidate {
  const open = (s: string): string => s.replace(/\.\s*$/, '');
  const own = finding.placeholders[0];
  if (!own) return sourced;
  return {
    sep: finding.sep,
    template: `${open(sourced.template)} — ${own.token}.`,
    text: `${open(sourced.text)} — ${qualifier}.`,
    placeholders: [...sourced.placeholders, { ...own, rendered: qualifier }],
    issues: [],
    judgeFacts: null,
    kind: 'sourced',
  };
}

function join(
  seps: readonly string[],
  sentences: readonly PersistedSentence[],
  pick: (s: PersistedSentence) => string,
): string {
  return sentences.map((s, i) => (seps[i] ?? '') + pick(s)).join('');
}

function errorEvent(e: unknown): SseEvent {
  const code = e instanceof LlmError ? e.code : 'synthesis_failed';
  return {
    event: 'error',
    data: { code, text: 'The answer was interrupted before it was finished.', recoverable: false },
  };
}

/** Digits that belong to the names of the entities and plans in play (e.g. the 365 of "Office 365"). */
function nameNumerals(
  entities: ReadonlyArray<{ name: string; aliases: string[]; plans: string[] }>,
): Set<string> {
  const out = new Set<string>();
  for (const e of entities) {
    for (const s of [e.name, ...e.aliases, ...e.plans]) {
      for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, ''));
    }
  }
  return out;
}

function promptData(
  findings: readonly Finding[],
  records: AnswerRecords,
  renderer: Renderer,
  input: RunInput,
): Omit<Parameters<typeof buildSynthesisMessages>[0], 'compact'> {
  const preview = (f: Finding, variant: 'current' | 'baseline' | 'verdict'): string | null => {
    const placeholder = resolveRef({ kind: 'finding', ord: f.ord, variant }, records);
    return placeholder.ok ? renderer.render(placeholder.record, records) : null;
  };
  const views: SynthesisFindingView[] = findings.map((f) => ({
    ord: f.ord,
    entityName: f.entityName,
    intent: f.intent,
    currentStatus: f.currentStatus,
    verdict: f.verdict,
    verdictReason: f.verdictReason,
    direction: f.direction ?? null,
    hasBaseline: f.baseline !== undefined,
    derivedCount: f.derived?.length ?? 0,
    releaseKinds: [...new Set((f.releases ?? []).map((r) => r.kind))],
    noVerifiedValue:
      f.intent === 'pricing' &&
      f.currentStatus !== 'unable_to_verify' &&
      f.current?.value == null &&
      !(f.current?.contested && f.current.contested.length >= 2),
    previews: {
      current: preview(f, 'current') ?? '',
      baseline: preview(f, 'baseline'),
      verdict: preview(f, 'verdict'),
    },
  }));
  const recall = [...records.messages].map(([id, m]) => ({
    id,
    preview: renderer.render(
      { kind: 'message', messageId: id, text: m.text, localTime: m.localTime },
      records,
    ),
  }));
  return {
    findings: views,
    recall,
    sourceIds: Object.keys(records.sources),
    userMessage: input.userMessage,
    window: input.window,
  };
}

/**
 * The snapshots an answer cites, in citation-number order, for `answer.completed`. Re-resolves each placeholder
 * of the persisted sentences against the same data the answer was rendered from.
 */
export function citedSnapshotIds(
  sentences: readonly PersistedSentence[],
  records: AnswerRecords,
): SnapshotId[] {
  const seen = new Set<SnapshotId>();
  for (const s of sentences) {
    for (const p of s.placeholders) {
      const token = p.token.slice(2, -2);
      const m = /^F([1-9]\d{0,2})(?::(baseline|verdict)|:derived:(\d+))?$/.exec(token);
      const ref = m
        ? m[3] !== undefined
          ? ({ kind: 'finding_derived', ord: Number(m[1]), index: Number(m[3]) } as const)
          : ({
              kind: 'finding',
              ord: Number(m[1]),
              variant:
                m[2] === 'baseline' ? 'baseline' : m[2] === 'verdict' ? 'verdict' : 'current',
            } as const)
        : p.snapshotId
          ? ({ kind: 'source', snapshotId: p.snapshotId } as const)
          : null;
      const res = ref ? resolveRef(ref, records) : null;
      if (res?.ok) for (const id of recordCitations(res.record)) seen.add(id);
    }
  }
  return [...seen].sort(
    (a, b) => (records.citationNumber(a) ?? 0) - (records.citationNumber(b) ?? 0),
  );
}

export { buildRecords };
