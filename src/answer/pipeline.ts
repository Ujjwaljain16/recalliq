import type { AnswerPipeline, PersistedSentence } from '../shared/answer.js';
import type { Finding } from '../shared/findings.js';
import type { IanaTz } from '../shared/ids.js';
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
import { SentenceAssembler } from './assembler.js';
import { PlaceholderParser } from './placeholders.js';
import { buildRecords, resolveRef, type AnswerRecords, type RecordsInput } from './records.js';
import { defaultRenderer, recordCitations, type Renderer } from './render.js';
import type { T3aContext } from './t3a.js';
import type { SnapshotId } from '../shared/ids.js';

type RunInput = Parameters<AnswerPipeline['run']>[0] & {
  /** The user's timezone, when the caller has it (the context only exposes one through resolved dates). */
  tz?: IanaTz;
};
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
 * The answer pipeline: the model writes a template, code renders the facts. Streams sentence by sentence,
 * checks each sentence (placeholder authorisation, render integrity, T3a), runs the optional T3b judge off the
 * critical path, and returns what must be persisted.
 *
 * Failure contract: this method does not throw for model or stream failure. A stream that fails, is aborted at
 * the deadline, or produces nothing yields `interrupted: true`; completed sentences keep their statuses, the
 * unfinished sentence is persisted as `truncated`, and an `error` event is emitted. With no sentence at all
 * (`sentences.length === 0`) the caller must produce its own deterministic reply.
 * It never emits `answer.completed` or `turn.completed`: those need ids that exist only after persistence.
 * It never touches acknowledgement: `streamedThrough` is only what was written to the stream.
 */
export class LlmAnswerPipeline implements AnswerPipeline {
  readonly promptVersion = SYNTHESIS_PROMPT_VERSION;
  private readonly renderer: Renderer;

  constructor(private readonly deps: AnswerPipelineDeps) {
    this.renderer = deps.renderer ?? defaultRenderer;
  }

  async run(input: RunInput, budget: TurnBudget, emit: (e: SseEvent) => void): Promise<RunResult> {
    const opts = this.deps.options ?? {};
    const records = buildRecords(input as RecordsInput);
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

    // ── judge bookkeeping (T3b runs off the critical path) ──
    const judgements: Array<Promise<void>> = [];
    const outstanding = new Set<number>();
    let settled = false;
    const judgeOn = opts.judge ?? true;

    const assembler: SentenceAssembler = new SentenceAssembler({
      records,
      renderer: this.renderer,
      t3a,
      emit: safeEmit,
      logger: log,
      requestJudge: (index, sentenceText, facts) => {
        if (!judgeOn || !budget.admit('judge')) return false;
        outstanding.add(index);
        judgements.push(
          this.judge(sentenceText, facts, budget, opts.judgeCapMs ?? 4000).then((v) => {
            if (settled || !outstanding.delete(index)) return;
            if (v === 'supported') assembler.update(index, 'verified', []);
            else if (v === 'partial') assembler.update(index, 'unverified', ['judge_partial']);
            else if (v === 'unsupported')
              assembler.update(index, 'unverified', ['judge_unsupported']);
            else assembler.update(index, 'unchecked', ['judge_unavailable']);
          }),
        );
        return true;
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
        compact,
      });
      const iterator = this.deps.llm
        .stream({
          role: 'synthesis',
          system: SYNTHESIS_SYSTEM,
          messages,
          maxTokens: compact ? (opts.compactMaxTokens ?? 600) : (opts.maxTokens ?? 1200),
          signal,
        })
        [Symbol.asyncIterator]();
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
        assembler.truncate(parser.pending.startsWith('[['));
      }
    }

    if (!interrupted && assembler.sentences.length === 0) {
      interrupted = true;
      safeEmit({
        event: 'error',
        data: { code: 'empty_answer', text: 'The answer came back empty.', recoverable: false },
      });
    }

    // ── late judgements: wait for them, but never past the turn ──
    if (!interrupted && outstanding.size > 0) {
      const turnEnded = new Promise<void>((resolve) => {
        if (budget.signal.aborted) resolve();
        else budget.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([Promise.allSettled(judgements), turnEnded]);
    }
    settled = true;
    for (const index of outstanding) assembler.update(index, 'unchecked', ['judge_unavailable']);
    outstanding.clear();

    const sentences = assembler.sentences;
    return {
      sentences,
      streamedThrough: assembler.streamedThrough,
      interrupted,
      template: join(assembler.seps, sentences, (s) => s.template),
      rendered: join(assembler.seps, sentences, (s) => s.text),
    };
  }

  private async judge(
    sentence: string,
    facts: string[],
    budget: TurnBudget,
    capMs: number,
  ): Promise<'supported' | 'partial' | 'unsupported' | 'unavailable'> {
    try {
      const r = await this.deps.llm.structured({
        role: 'judge',
        system: JUDGE_SYSTEM,
        messages: buildJudgeMessages(sentence, facts),
        schema: judgeSchema,
        schemaName: JUDGE_SCHEMA_NAME,
        maxTokens: 50,
        signal: budget.signalFor('judge', capMs),
      });
      return r.value.verdict;
    } catch {
      return 'unavailable';
    }
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
