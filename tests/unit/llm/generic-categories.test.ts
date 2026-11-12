import { describe, expect, it } from 'vitest';
import { LlmTurnAnalyzer, degradedAnalysis } from '../../../src/llm/analysis/analyzer.js';
import {
  isGenericCategory,
  normaliseMention,
} from '../../../src/llm/analysis/generic-categories.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { LlmError } from '../../../src/shared/llm.js';
import { FakeBudget } from '../../helpers/budget.js';

const base = {
  laneHint: 'research',
  intents: ['pricing'],
  temporal: [],
  references: [],
  topicTerms: [] as string[],
  asksStillCorrect: false,
  queries: [] as string[],
  alternateQueries: [],
  userFacts: [],
};

const entity = (text: string) => ({ text, normalized: text.toLowerCase() });

async function analyse(message: string, output: object) {
  const llm = new FakeLlm().queueStructured({ ...base, ...output });
  return new LlmTurnAnalyzer({ llm }).analyze(
    { userMessage: message, window: [], tz: 'UTC', now: 0 },
    new FakeBudget(60_000),
  );
}

describe('generic categories are topics, not entities', () => {
  it('the observed message: Neon stays an entity, Postgres becomes a topic term, the query is kept', async () => {
    const a = await analyse('What does Neon charge per month for its Postgres plans?', {
      entities: [entity('Neon'), entity('Postgres')],
      queries: ['Neon Postgres pricing'],
    });
    expect(a.entities.map((e) => e.normalized)).toEqual(['neon']);
    expect(a.topicTerms).toContain('postgres');
    expect(a.queries).toEqual(['Neon Postgres pricing']);
    expect(a.degraded).toBe(false);
  });

  it('mixed list: named CRM tools stay, the word CRM moves', async () => {
    const a = await analyse('Compare HubSpot and Zoho as a CRM', {
      entities: [entity('HubSpot'), entity('Zoho'), entity('CRM')],
      topicTerms: ['crm pricing'],
    });
    expect(a.entities.map((e) => e.normalized)).toEqual(['hubspot', 'zoho']);
    expect(a.topicTerms).toEqual(['crm pricing', 'crm']);
  });

  it('a model that returns only categories yields zero entities', async () => {
    const a = await analyse('Which database hosting is cheapest?', {
      entities: [
        entity('database'),
        entity('hosting'),
        entity('Serverless'),
        entity('LLM'),
        entity('SaaS'),
      ],
    });
    expect(a.entities).toEqual([]);
    expect(a.topicTerms).toEqual(['database', 'hosting', 'serverless', 'llm', 'saas']);
  });

  it('exact normalised match only: a name that merely contains a category word stays an entity', async () => {
    const a = await analyse('PostgreSQL Cloud Co pricing', {
      entities: [entity('PostgreSQL Cloud Co'), entity('Postgres Hosting')],
    });
    expect(a.entities.map((e) => e.normalized)).toEqual([
      'postgresql cloud co',
      'postgres hosting',
    ]);
    expect(a.topicTerms).toEqual([]);
  });

  it('matches regardless of case and punctuation', async () => {
    const a = await analyse('x', {
      entities: [entity('K8s'), entity('E-Commerce'), entity('PostgreSQL.'), entity('Acme')],
    });
    expect(a.entities.map((e) => e.normalized)).toEqual(['acme']);
    expect(a.topicTerms).toEqual(['k8s', 'e commerce', 'postgresql']);
  });

  it('moved terms are de-duplicated against the model topic terms and capped at 8', async () => {
    const a = await analyse('x', {
      entities: [entity('Postgres')],
      topicTerms: ['postgres', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    });
    expect(a.topicTerms).toHaveLength(8);
    expect(a.topicTerms.filter((t) => t === 'postgres')).toHaveLength(1);
  });

  it('the degraded path is unchanged', async () => {
    const llm = new FakeLlm().queueStructured(
      new LlmError('unavailable', 'x'),
      new LlmError('unavailable', 'x'),
    );
    const msg = 'What does Neon charge per month for its Postgres plans?';
    const a = await new LlmTurnAnalyzer({ llm }).analyze(
      { userMessage: msg, window: [], tz: 'UTC', now: 0 },
      new FakeBudget(60_000),
    );
    expect(a).toEqual(degradedAnalysis(msg));
    expect(a.degraded).toBe(true);
    expect(a.entities).toEqual([]);
  });

  it('the analysis prompt names the rule and the example', () => {
    const llm = new FakeLlm().queueStructured({ ...base, entities: [] });
    return new LlmTurnAnalyzer({ llm })
      .analyze({ userMessage: 'x', window: [], tz: 'UTC', now: 0 }, new FakeBudget(60_000))
      .then(() => {
        const system = llm.structuredCalls[0]?.system ?? '';
        expect(system).toContain('A generic technology or product category is NOT an entity');
        expect(system).toContain('Neon Postgres pricing');
      });
  });
});

describe('isGenericCategory', () => {
  it('is an exact match of the normalised mention, never a substring', () => {
    expect(isGenericCategory('Postgres')).toBe(true);
    expect(isGenericCategory(' postgresql ')).toBe(true);
    expect(isGenericCategory('Web Hosting')).toBe(true);
    expect(isGenericCategory('web-hosting')).toBe(true);
    expect(isGenericCategory('postgres cloud')).toBe(false);
    expect(isGenericCategory('Neon')).toBe(false);
    expect(isGenericCategory('MongoDB')).toBe(false); // also a vendor: deliberately not listed
    expect(isGenericCategory('')).toBe(false);
    expect(normaliseMention('E-Commerce!')).toBe('e commerce');
  });
});
