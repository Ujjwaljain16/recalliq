import { LlmError } from '../../shared/llm.js';
import type {
  LlmPort,
  StreamEvent,
  StreamRequest,
  StructuredRequest,
  StructuredResult,
} from '../../shared/llm.js';
import type { Clock } from '../../shared/infrastructure.js';
import {
  ReplayMissError,
  SearchError,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../../shared/search.js';
import type { ReplaySearchAdapter } from '../../search/replay.js';
import { toSearchHit, type ReplayFixture } from './fixture.js';

/**
 * Replay providers. They are the only components of the replay set that differ from the live set. They hold no
 * credentials, no `fetch` and no reference to any live adapter, so a request they cannot answer can only fail:
 * it is recorded in the MissLog and thrown, never sent anywhere.
 */

/** A request the fixture cannot answer. Not an LlmError: no module may treat it as a provider outage. */
export class FixtureMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureMissError';
  }
}

/** Remembers every miss, so wrappers can make one loud even where a module swallows provider errors. */
export class MissLog {
  readonly misses: string[] = [];

  record(message: string): FixtureMissError {
    this.misses.push(message);
    return new FixtureMissError(message);
  }

  get count(): number {
    return this.misses.length;
  }
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function lastUser(r: { messages: ReadonlyArray<{ role: string; content: string }> }): string {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i];
    if (m?.role === 'user') return m.content;
  }
  return '';
}

const has = (hay: string, needle: string): boolean =>
  hay.toLowerCase().includes(needle.toLowerCase());

function between(text: string, open: string, close: string): string {
  const a = text.indexOf(open);
  if (a === -1) return text;
  const b = text.indexOf(close, a + open.length);
  return text.slice(a + open.length, b === -1 ? undefined : b);
}

const USER_MESSAGE_MARK = "The user's message:\n";

export class FixtureLlm implements LlmPort {
  constructor(
    private readonly rules: ReplayFixture['llm'],
    readonly log: MissLog,
  ) {}

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (r.signal.aborted) return Promise.reject(new LlmError('cancelled', 'aborted'));
    let value: unknown;
    const content = lastUser(r);
    switch (r.role) {
      case 'analysis': {
        const message = between(content, '<user_message>\n', '\n</user_message>');
        const rule = this.rules.analysis.find((x) => has(message, x.whenMessageContains));
        if (!rule) return Promise.reject(this.log.record(`no analysis fixture for: ${message}`));
        value = rule.reply;
        break;
      }
      case 'extraction':
        value = { statements: this.extract(content) };
        break;
      case 'judge': {
        const rule = this.rules.judge.find((x) => has(content, x.whenContains));
        if (!rule) return Promise.reject(this.log.record('no judge fixture for the request'));
        value = rule.reply;
        break;
      }
      default:
        return Promise.reject(this.log.record(`structured ${r.role} is not covered by a fixture`));
    }
    const parsed = r.schema.safeParse(value);
    if (!parsed.success)
      return Promise.reject(new LlmError('invalid_output', 'fixture reply fails the schema'));
    return Promise.resolve({ value: parsed.data, usage: NO_USAGE, model: 'fixture', latencyMs: 0 });
  }

  /** Statements for the entities and sources that are in this prompt. A source nobody wrote a rule for yields none. */
  private extract(prompt: string): unknown[] {
    const entities = [...prompt.matchAll(/^E(\d+): (.*?)(?: \(also: .*\))?$/gm)].map((m) => ({
      ref: `E${m[1] ?? ''}`,
      name: (m[2] ?? '').trim(),
    }));
    const sources = [...prompt.matchAll(/<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)].map(
      (m) => ({ ref: m[1] ?? '', text: m[2] ?? '' }),
    );
    const out: unknown[] = [];
    for (const rule of this.rules.extraction) {
      const e = entities.find((x) => x.name.toLowerCase() === rule.entity.toLowerCase());
      const s = sources.find((x) => x.text.includes(rule.sourceContains));
      if (e && s) out.push({ ...rule.statement, sourceId: s.ref, entityId: e.ref });
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator keeps the port's shape
  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const content = lastUser(r);
    const at = content.indexOf(USER_MESSAGE_MARK);
    const message = at === -1 ? content : content.slice(at + USER_MESSAGE_MARK.length);
    const rule = this.rules.synthesis.find(
      (x) =>
        (x.whenMessageContains === undefined || has(message, x.whenMessageContains)) &&
        (x.whenDataContains === undefined || has(content, x.whenDataContains)),
    );
    if (!rule) throw this.log.record(`no synthesis fixture for: ${message.slice(0, 120)}`);
    const recalled = [...content.matchAll(/\[\[M:(msg_[A-Za-z0-9_-]+)\]\] will say/g)].map(
      (m) => m[1] ?? '',
    );
    for (const raw of rule.deltas) {
      if (r.signal.aborted) throw new LlmError('cancelled', 'aborted');
      const text = raw.replace(/\{\{M(\d+)\}\}/g, (_all, n: string) => {
        const id = recalled[Number(n) - 1];
        if (id === undefined) throw this.log.record(`fixture refers to recalled message ${n}`);
        return id;
      });
      yield { type: 'delta', text };
    }
    if (rule.failWith) throw new LlmError(rule.failWith, 'fixture failure');
    yield { type: 'done', usage: NO_USAGE, model: 'fixture', ttftMs: 0, latencyMs: 0 };
  }
}

export interface FixtureSearchDeps {
  entries: ReplayFixture['search'];
  /** Hash-keyed recorded exchanges, tried when no scripted entry matches the query. */
  recorded?: ReplaySearchAdapter | undefined;
  clock: Clock;
  log: MissLog;
}

export class FixtureSearchPort implements SearchPort {
  readonly provider = 'replay';
  private readonly used = new Map<string, number>();

  constructor(private readonly d: FixtureSearchDeps) {}

  async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    if (signal.aborted) throw new SearchError('cancelled', 'Search call cancelled');
    const q = req.query.trim().toLowerCase();
    const entry = this.d.entries.find((e) => e.query.trim().toLowerCase() === q);
    if (!entry) {
      if (this.d.recorded) {
        try {
          return await this.d.recorded.search(req, signal);
        } catch (e) {
          if (e instanceof ReplayMissError)
            throw this.missFor(`no recorded search for "${req.query}"`);
          throw e;
        }
      }
      throw this.missFor(`no recorded search for "${req.query}"`);
    }
    const n = this.used.get(q) ?? 0;
    const step = entry.steps[n];
    if (step === undefined)
      throw this.missFor(`recorded search "${req.query}" has no call number ${n + 1}`);
    this.used.set(q, n + 1);
    if ('error' in step) throw new SearchError(step.error, 'recorded provider failure');
    return {
      provider: 'replay',
      hits: step.hits.map(toSearchHit),
      droppedMalformed: 0,
      latencyMs: 1,
      costUsd: null,
      observedAt: step.observedAt ?? this.d.clock.now(),
    };
  }

  /** Thrown as the shared ReplayMissError, which the search executor never retries or converts. */
  private missFor(message: string): ReplayMissError {
    this.d.log.record(message);
    return new ReplayMissError(message);
  }
}
