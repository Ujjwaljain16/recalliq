import { describe, expect, it } from 'vitest';
import {
  leadingBreak,
  paragraphStarts,
  paragraphTexts,
  sentenceGap,
  storedParagraphTexts,
} from '../../../web/js/format.js';

describe('answer paragraphs', () => {
  it('starts a paragraph when a streamed sentence follows a line break', () => {
    expect(leadingBreak('\n\nSecond part.')).toEqual({ newParagraph: true, text: 'Second part.' });
    expect(leadingBreak(' Same paragraph.')).toEqual({
      newParagraph: false,
      text: 'Same paragraph.',
    });
    expect(leadingBreak('First.')).toEqual({ newParagraph: false, text: 'First.' });
  });

  it('recovers paragraph starts of stored sentences from the message content', () => {
    const content = 'One. Two.\n\nThree.\n- Four.';
    expect(paragraphStarts(content, ['One.', 'Two.', 'Three.', '- Four.'])).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(paragraphStarts('One. Two.', ['One.', 'Missing.', 'Two.'])).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('one space between the sentences of a paragraph', () => {
  const zoho = 'Zoho CRM: I could not confirm a price through my checks.';
  const g2 = 'According to g2.com, Zoho CRM pricing starts at $14.00 [4].';

  it('puts one space between streamed sentences of one paragraph and a break between paragraphs', () => {
    expect(paragraphTexts([zoho, ` ${g2}`, `\n\nSalesforce: nothing.`, ' Next.'])).toEqual([
      `${zoho} ${g2}`,
      'Salesforce: nothing. Next.',
    ]);
    expect(sentenceGap(false, true)).toBe(' ');
    expect(sentenceGap(true, true)).toBe('');
    expect(sentenceGap(false, false)).toBe('');
  });

  it('does not depend on the model whitespace: a sentence streamed with no lead still gets the space', () => {
    expect(paragraphTexts([zoho, g2])).toEqual([`${zoho} ${g2}`]);
  });

  it('the reloaded message shows the same text as the stream', () => {
    const content = `${zoho} ${g2}\n\nSalesforce: nothing.`;
    expect(storedParagraphTexts(content, [zoho, g2, 'Salesforce: nothing.'])).toEqual([
      `${zoho} ${g2}`,
      'Salesforce: nothing.',
    ]);
  });
});
