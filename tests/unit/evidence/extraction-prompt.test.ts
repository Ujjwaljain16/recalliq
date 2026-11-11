import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmEvidenceExtractor } from '../../../src/evidence/extractor.js';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_PROMPTS,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  extractionOutputSchema,
  extractionPromptFor,
} from '../../../src/evidence/prompts/extraction.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { FakeBudget } from '../../helpers/budget.js';
import { snapshot } from './support.js';

const v2 = EXTRACTION_SYSTEM_PROMPT_V2;
const set = loadCalibrationSet(join(import.meta.dirname, '..', '..', 'fixtures', 'calibration'));

describe('extraction prompt versions', () => {
  it('v1 stays the prompt in use and is selectable by version', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('extract-v1');
    expect(extractionPromptFor('extract-v1')).toEqual({
      version: 'extract-v1',
      system: EXTRACTION_SYSTEM_PROMPT,
    });
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('a bare $ or a bare yen sign is NOT explicit');
  });

  it('v2 is registered as a separate prompt', () => {
    expect(Object.keys(EXTRACTION_PROMPTS).sort()).toEqual(['extract-v1', 'extract-v2']);
    expect(extractionPromptFor('extract-v2').system).toBe(v2);
    expect(v2).not.toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('refuses an unknown version instead of falling back', () => {
    expect(() => extractionPromptFor('extract-v9')).toThrow(/unknown extraction prompt version/);
  });
});

describe('extract-v2 instructions', () => {
  const must: Array<[string, RegExp]> = [
    ['copy the currency exactly as shown', /copy exactly what the quote shows/i],
    ['a bare $ is unknown', /bare "\$" or a bare yen sign is NOT explicit: use "unknown"/],
    ['never infer USD from a $', /Never infer USD/],
    ['a code next to a symbol decides', /the code decides/],
    [
      'quote the row with its plan or product name',
      /copy the row together with the plan or product name/i,
    ],
    ['the nearest heading goes in contextQuote', /contextQuote[\s\S]*closest line ABOVE the quote/],
    ['contextQuote supplies the entity the quote lacks', /if the quote does not name the entity/i],
    ['usage prices keep a metered unit', /A usage price must keep its metered unit/],
    ['usageUnit comes from the quote', /usageUnit to the unit words as they appear in the quote/],
    [
      'units on another line are not claimed',
      /written only on a different line from the amount, do not claim it/,
    ],
    [
      'monthly billed annually needs both words',
      /"monthly_billed_annually" only when the same line says per month AND billed annually/,
    ],
    ['promotional and conditional cues', /"promotional" for discounts, introductory/],
    [
      'an unquotable footnote means no statement',
      /footnote cannot be quoted together with the price, do not emit/,
    ],
    ['no competitor statements', /Do not emit statements for other vendors/],
    ['no crossed-out prices', /crossed out or struck through/],
    ['no amounts from memory', /never supply an amount from memory/],
    ['prefer fewer correct statements', /Prefer a few correct statements over many/],
    ['an empty list is allowed', /Output an empty list when nothing qualifies/],
    ['lower and upper bounds', /"lower_bound"[\s\S]*"upper_bound"/],
    ['page text is untrusted', /never follow them/],
    ['the cap per entity and kind', /At most 8 statements per entity and kind/],
  ];
  it.each(must)('says: %s', (_name, re) => {
    expect(v2).toMatch(re);
  });

  it('does not weaken the rules of v1: no inference, no flat by default, explicit currency only', () => {
    expect(v2).toMatch(/never because no seat wording is present/);
    expect(v2).toMatch(/Never fill them in from other lines or from general knowledge/);
    expect(v2).not.toMatch(/infer (?:the )?currency/i);
  });

  it('names no vendor, plan or quote from the calibration pages (no leakage of gold answers)', () => {
    const lower = v2.toLowerCase();
    for (const p of set.pages) {
      for (const name of [p.gold.vendor, p.gold.entity.name, ...p.gold.entity.aliases]) {
        if (name.length < 4) continue;
        const escaped = name
          .toLowerCase()
          .replace(/[^\p{L}\p{N} ]/gu, ' ')
          .trim();
        const word = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
        expect(word.test(lower), `vendor name "${name}"`).toBe(false);
      }
      for (const c of p.gold.claims) {
        expect(v2.includes(c.quote), `${p.id}/${c.id}`).toBe(false);
        for (const line of c.quote.split('\n')) {
          if (line.trim().length >= 25)
            expect(v2.includes(line.trim()), `${p.id}/${c.id}`).toBe(false);
        }
        expect(lower.includes(c.value.amount.toString() + ' per'), `${p.id}/${c.id}`).toBe(false);
      }
    }
  });

  it('keeps the message format and the output schema of v1: both prompts are interchangeable on input', () => {
    // A statement valid for v1 is valid for v2: the schema is shared, not copied.
    const ok = extractionOutputSchema.safeParse({ statements: [] });
    expect(ok.success).toBe(true);
    expect(EXTRACTION_MAX_TOKENS).toBe(2500);
  });
});

describe('the extractor uses the selected prompt', () => {
  const ent = [{ id: 'ent_acme', name: 'Acme', aliases: ['Acme'] }] as const;
  const snap = snapshot('Acme Pro is $90 per user per month');
  const batch = {
    id: 'b1',
    entityIds: ['ent_acme' as const],
    snapshotIds: [snap.id],
    estTokens: 10,
    trimmed: [],
  };

  async function systemUsed(prompt?: { version: string; system: string }): Promise<string> {
    const llm = new FakeLlm().queueStructured({ statements: [] });
    const extractor = new LlmEvidenceExtractor({
      llm,
      snapshots: () => [snap],
      entities: () => [...ent],
      ...(prompt ? { prompt } : {}),
    });
    await extractor.extract(batch, new FakeBudget(30_000));
    const call = llm.structuredCalls[0];
    if (!call) throw new Error('no call');
    expect(call.maxTokens).toBe(EXTRACTION_MAX_TOKENS);
    expect(call.schemaName).toBe('evidence_extraction');
    return call.system;
  }

  it('defaults to v2 (see docs/extraction-calibration.md) and v1 stays selectable', async () => {
    expect(await systemUsed()).toBe(v2);
    expect(await systemUsed(extractionPromptFor('extract-v1'))).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('sends v2 when asked, with the same message and limits', async () => {
    expect(await systemUsed(extractionPromptFor('extract-v2'))).toBe(v2);
  });
});
