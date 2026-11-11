import { describe, expect, it } from 'vitest';
import { leadingBreak, paragraphStarts } from '../../../web/js/format.js';

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
