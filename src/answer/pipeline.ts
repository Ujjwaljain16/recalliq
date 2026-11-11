import type { AnswerPipeline, PersistedSentence, SentenceIssue } from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { Logger, TurnBudget } from '../shared/infrastructure.js';
import { LlmError, type LlmPort } from '../shared/llm.js';
import type { SseEvent } from '../shared/sse.js';
import {
  JUDGE_SCHEMA_NAME,
  JUDGE_SYSTEM,
  buildJudgeMessages,
  judgeSchema,
} from '../llm/prompts/judge.js';
import {
  SYNTHESIS_PROMPT_VERSION,
  SYNTHESIS_SYSTEM,
  buildSynthesisMessages,
  type SynthesisFindingView,
} from '../llm/prompts/synthesis.js';
import { SentenceAssembler, type Candidate } from './assembler.js';
import { PlaceholderParser } from './placeholders.js';
import { buildRecords, resolveRef, type AnswerRecords } from './records.js';
import { defaultRenderer, recordCitations, type Renderer } from './render.js';
import type { T3aContext } from './t3a.js';
import { selectExcerpts } from './excerpts.js';
import type { SourcedContext } from './sourced.js';
import { termsOf } from '../shared/terms.js';
import type { SnapshotId } from '../shared/ids.js';

type RunInput = Parameters<AnswerPipeline['run']>[0];
type RunResult = Awaited<ReturnType<AnswerPipeline['run']>>;

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

    const withhold = (issues: readonly SentenceIssue[]): void => {
      safeEmit({
        event: 'warning',
        data: {
          code: 'sentence_withheld',
          text: `A sentence was withheld because it did not pass validation (${issues.join(', ')}).`,
        },
      });
    };

    const release = async (c: Candidate): Promise<void> => {
      if (c.issues.length > 0) return withhold(c.issues);
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
      const index = released.length;
      const sep = index === 0 ? '' : c.sep;
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
    const compact = budget.remaining() < (opts.compactBelowMs ?? SYNTH_COMPACT_BELOW_MS);
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
      safeEmit(errorEvent(new LlmError('timeout', 'no time left')));
    } else {
      const signal = budget.signalFor('synthesis', budget.remaining());
      const messages = buildSynthesisMessages({
        ...promptData(findings, records, this.renderer, input),
        sources: excerpts.map((x) => ({
          id: x.id,
          domain: x.domain,
          title: x.title,
          published:
            x.publishedAt === null ? null : new Date(x.publishedAt).toISOString().slice(0, 10),
          excerpt: x.excerpt,
        })),
        compact,
      });
      const stream = this.deps.llm.stream({
        role: 'synthesis',
        system: SYNTHESIS_SYSTEM,
        messages,
        maxTokens: compact ? (opts.compactMaxTokens ?? 600) : (opts.maxTokens ?? 1200),
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
        safeEmit(errorEvent(e));
        // Do not wait for a stream that may never end: ask it to stop and move on.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        assembler.discardOpen(); // the incomplete trailing sentence is never released
      }
    }

    await gate; // sentences already complete finish their checks (and judge) in order
    if (!interrupted && released.length === 0) {
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
