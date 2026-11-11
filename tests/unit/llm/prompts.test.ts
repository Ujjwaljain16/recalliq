import { describe, expect, it } from 'vitest';
import { ANALYSIS_PROMPT_VERSION, ANALYSIS_SYSTEM } from '../../../src/llm/prompts/analysis.js';
import { SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SYSTEM } from '../../../src/llm/prompts/synthesis.js';

describe('synthesis prompt', () => {
  it('is version 5 and forbids free-text change language, requiring verdict placeholders', () => {
    expect(SYNTHESIS_PROMPT_VERSION).toBe('synthesis.v5');
    expect(SYNTHESIS_SYSTEM).toContain('CHANGE OVER TIME or a COMPARISON');
    expect(SYNTHESIS_SYSTEM).toContain('[[F3:verdict]]');
    expect(SYNTHESIS_SYSTEM).toContain('Free text must not describe changes');
    expect(SYNTHESIS_SYSTEM).toContain('verdict placeholder of THAT finding');
    expect(SYNTHESIS_SYSTEM).toContain('A plain value placeholder');
    expect(SYNTHESIS_SYSTEM).toContain('must not say again what it says');
    expect(SYNTHESIS_SYSTEM).toContain('ExampleCo: [[F1]].');
  });
});

describe('analysis prompt', () => {
  it('is version 3, defines the three time roles with examples and forbids years the user did not write', () => {
    expect(ANALYSIS_PROMPT_VERSION).toBe('analysis.v3');
    expect(ANALYSIS_SYSTEM).toContain(
      'reference_conversation: a day or time the user says an EARLIER CONVERSATION',
    );
    expect(ANALYSIS_SYSTEM).toContain('"On Monday we shortlisted 5 tools"');
    expect(ANALYSIS_SYSTEM).toContain('"what did I ask on 3 November"');
    expect(ANALYSIS_SYSTEM).toContain('change_since: the lower bound of a "since"');
    expect(ANALYSIS_SYSTEM).toContain('event_time: the date of a real-world event');
    expect(ANALYSIS_SYSTEM).toContain('is never event_time');
    expect(ANALYSIS_SYSTEM).toContain(
      'must NOT contain a year or a date that the user did not write',
    );
    expect(ANALYSIS_SYSTEM).toContain('entity_set');
  });
});
