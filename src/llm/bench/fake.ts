import { FakeLlm } from '../fake.js';

const empty = {
  intents: ['pricing'],
  temporal: [],
  entities: [],
  references: [],
  topicTerms: [],
  asksStillCorrect: false,
  queries: [],
  alternateQueries: [],
  userFacts: [],
};

/**
 * A scripted port that answers the fixed benchmark set with canned replies. It exists to test the harness and to
 * let the command run without credentials. Its numbers are NOT a measurement of any model.
 */
export function fakeBenchLlm(): FakeLlm {
  return new FakeLlm()
    .queueStructured(
      {
        ...empty,
        laneHint: 'audit',
        temporal: [
          {
            text: 'Last Tuesday',
            expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
            role: 'reference_conversation',
          },
        ],
        entities: [{ text: 'ExampleCo', normalized: 'exampleco' }],
        asksStillCorrect: true,
      },
      {
        ...empty,
        laneHint: 'audit',
        temporal: [
          {
            text: 'since Monday',
            expr: { kind: 'since', anchor: { kind: 'weekday', weekday: 1, modifier: 'none' } },
            role: 'change_since',
          },
        ],
        entities: [
          { text: 'Widgets', normalized: 'widgets' },
          { text: 'Gadgets', normalized: 'gadgets' },
        ],
      },
      {
        ...empty,
        laneHint: 'research',
        entities: [
          { text: 'ExampleCo', normalized: 'exampleco' },
          { text: 'SampleSoft', normalized: 'samplesoft' },
        ],
        userFacts: [
          {
            kind: 'constraint',
            quote: 'We only have 20 seats',
            data: { kind: 'constraint', constraint: { key: 'seats', value: 20 } },
          },
        ],
      },
      { verdict: 'supported' },
      { verdict: 'unsupported' },
    )
    .queueStream({ deltas: ['I have nothing to report yet.'] });
}
