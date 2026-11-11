import { describe, expect, it } from 'vitest';
import { SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SYSTEM } from '../../../src/llm/prompts/synthesis.js';

describe('synthesis prompt', () => {
  it('is version 4 and forbids free-text change language, requiring verdict placeholders', () => {
    expect(SYNTHESIS_PROMPT_VERSION).toBe('synthesis.v4');
    expect(SYNTHESIS_SYSTEM).toContain('CHANGE OVER TIME or a COMPARISON');
    expect(SYNTHESIS_SYSTEM).toContain('[[F3:verdict]]');
    expect(SYNTHESIS_SYSTEM).toContain('Free text must not describe changes');
    expect(SYNTHESIS_SYSTEM).toContain('verdict placeholder of THAT finding');
    expect(SYNTHESIS_SYSTEM).toContain('A plain value placeholder');
    expect(SYNTHESIS_SYSTEM).toContain('must not say again what it says');
    expect(SYNTHESIS_SYSTEM).toContain('ExampleCo: [[F1]].');
  });
});
