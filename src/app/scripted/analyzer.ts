import type { TurnAnalyzer } from '../../shared/pipeline.js';
import type {
  EntityMention,
  TemporalExpression,
  TemporalMention,
  TurnAnalysis,
} from '../../shared/understanding.js';

/**
 * DEVELOPMENT / SCRIPTED. Not an LLM and not real understanding: a handful of regular expressions that map a
 * message to a canned analysis so the whole path (lanes, streaming, acknowledgement) can be exercised without
 * a model. It is deterministic: the same message always gives the same analysis.
 *
 * What it recognises:
 *   - small talk                                      -> chat lane
 *   - "what did I ask yesterday / today / 2 days ago / last Monday / on 2026-11-10 ..."
 *                                                     -> recall lane (with an optional "about <topic>")
 *   - "price / cost / pricing / plans" plus a capitalised company name
 *                                                     -> research lane
 *   - "that company", "compare them", "which one"     -> clarify lane
 */

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_NUMBER = Object.fromEntries(WEEKDAYS.map((d, i) => [d, i + 1])) as Record<
  string,
  1 | 2 | 3 | 4 | 5 | 6 | 7
>;

const RECALL =
  /\b(what|which|when|remind me what)\b[^?]*\b(did|have|do) (i|we)\b[^?]*\b(ask|asked|say|said|tell|told|talk|talked|discuss|discussed|mention|mentioned|write|wrote|type|typed)\b/i;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RESEARCH =
  /\b(price|prices|pricing|cost|costs|charge|charges|how much|plan|plans|subscription)\b/i;
const CLARIFY = /\b(that|this|the) (company|vendor|product|one)\b|\bcompare them\b|\bwhich one\b/i;
const STILL_CORRECT = /\b(still correct|still right|still true|is that still)\b/i;

const NOT_ENTITIES = new Set([
  'i',
  'what',
  'which',
  'when',
  'where',
  'who',
  'why',
  'how',
  'does',
  'do',
  'is',
  'are',
  'the',
  'a',
  'an',
  'tell',
  'show',
  'can',
  'could',
  'please',
  'hi',
  'hello',
  'hey',
  'thanks',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'unverified',
  'unchecked',
  'offline',
  'unavailable',
]);

/** Set by the scripted analyzer when the message asks to simulate a search outage; read by scripted research. */
export const OUTAGE_MARKER = 'scripted:search_outage';

export function normalizeMention(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function temporalFor(text: string): TemporalMention[] {
  const out: TemporalMention[] = [];
  const add = (matched: string, expr: TemporalExpression): void => {
    out.push({ text: matched, expr, role: 'reference_conversation' });
  };

  const iso = ISO_DATE.exec(text);
  if (iso) {
    add(iso[0], {
      kind: 'calendar_date',
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    });
    return out;
  }
  const lowered = text.toLowerCase();
  const ago = /\b(\d{1,2}) days? ago\b/.exec(lowered);
  if (ago) {
    add(ago[0], { kind: 'days_ago', n: Number(ago[1]) });
    return out;
  }
  if (/\byesterday\b/.test(lowered)) {
    add('yesterday', { kind: 'yesterday' });
    return out;
  }
  if (/\btoday\b|\bearlier\b/.test(lowered)) {
    add(/\btoday\b/.test(lowered) ? 'today' : 'earlier', { kind: 'today' });
    return out;
  }
  if (/\blast week\b/.test(lowered)) {
    add('last week', { kind: 'last_week' });
    return out;
  }
  const weekday = new RegExp(`\\b(?:(last|this|on)\\s+)?(${WEEKDAYS.join('|')})\\b`).exec(lowered);
  if (weekday?.[2]) {
    const modifier = weekday[1] === 'last' ? 'last' : weekday[1] === 'this' ? 'this' : 'none';
    add(weekday[0], { kind: 'weekday', weekday: WEEKDAY_NUMBER[weekday[2]] ?? 1, modifier });
  }
  return out;
}

function topicTermsFor(text: string): string[] {
  const about = /\babout\s+([^?.!]+)/i.exec(text);
  if (!about?.[1]) return [];
  return about[1]
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !['the', 'and', 'that', 'this', 'with'].includes(w))
    .slice(0, 4);
}

function entitiesFor(text: string): EntityMention[] {
  const seen = new Set<string>();
  const out: EntityMention[] = [];
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9&.-]{1,30}\b/g)) {
    // A capitalised word that opens a sentence is just grammar ("Add ...", "What ..."), not a name.
    if (/(^|[.?!]\s+)$/.test(text.slice(0, m.index))) continue;
    const token = m[0].replace(/[.-]+$/, '');
    const normalized = normalizeMention(token);
    if (token.length < 2 || NOT_ENTITIES.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ text: token, normalized });
  }
  return out.slice(0, 3);
}

function baseAnalysis(over: Partial<TurnAnalysis>): TurnAnalysis {
  return {
    laneHint: 'chat',
    intents: [],
    temporal: [],
    entities: [],
    references: [],
    topicTerms: [],
    asksStillCorrect: false,
    queries: [],
    alternateQueries: [],
    userFacts: [],
    degraded: false,
    ...over,
  };
}

/** The pure part, exported for tests. */
export function scriptedAnalysis(message: string): TurnAnalysis {
  const temporal = temporalFor(message);
  if (temporal.length > 0 && (RECALL.test(message) || ISO_DATE.test(message))) {
    return baseAnalysis({
      laneHint: 'recall',
      temporal,
      topicTerms: topicTermsFor(message),
      asksStillCorrect: STILL_CORRECT.test(message),
    });
  }
  if (RECALL.test(message)) {
    // Asked for a recall without saying when: the recall lane asks which day.
    return baseAnalysis({ laneHint: 'recall', topicTerms: topicTermsFor(message) });
  }
  if (CLARIFY.test(message) && entitiesFor(message).length === 0) {
    const ref = CLARIFY.exec(message)?.[0] ?? 'that';
    return baseAnalysis({ laneHint: 'clarify', references: [{ text: ref, kind: 'entity_set' }] });
  }
  if (RESEARCH.test(message)) {
    const entities = entitiesFor(message);
    return baseAnalysis({
      laneHint: 'research',
      intents: ['pricing'],
      entities,
      queries: entities.map((e) => `${e.text} pricing`),
      alternateQueries: /\b(offline|unavailable)\b/i.test(message) ? [OUTAGE_MARKER] : [],
    });
  }
  return baseAnalysis({ laneHint: 'chat' });
}

export class ScriptedAnalyzer implements TurnAnalyzer {
  analyze(input: Parameters<TurnAnalyzer['analyze']>[0]): Promise<TurnAnalysis> {
    return Promise.resolve(scriptedAnalysis(input.userMessage));
  }
}
