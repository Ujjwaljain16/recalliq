/**
 * Small invented rows shaped like the three benchmark files (same columns, quoting and layout). None of
 * them is a real benchmark row.
 */

export const SIMPLEQA_CSV = [
  'metadata,problem,answer',
  `"{'topic': 'Science and technology', 'answer_type': 'Person', 'urls': ['https://example.org/a', 'https://example.org/b']}",Who first described the imaginary Zorblax effect?,Ada Example`,
  `"{'topic': 'Geography', 'answer_type': 'Place', 'urls': ['https://example.org/c']}","What's the capital of the invented province of Northmere, in the story?",Port Lantern`,
  `"{'topic': 'Sports', 'answer_type': 'Number', 'urls': []}",How many laps were in the fictional 1901 Example Cup?,42`,
  `"{'topic': 'Art', 'answer_type': 'Date', 'urls': ['https://example.org/d']}","On which date did the made-up ""Blue Hour"" gallery open?","May 3, 1999"`,
].join('\r\n');

const FRESH_HEADER =
  'id,split,question,effective_year,next_review,false_premise,num_hops,fact_type,source,answer_0,answer_1,answer_2,answer_3,answer_4,answer_5,answer_6,answer_7,answer_8,answer_9,note';

export const FRESHQA_CSV = [
  '"Warning: an invented warning line, as the published sheet has one.",,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,,',
  FRESH_HEADER,
  '0,TEST,What is the name of the first cat to walk on Mars?,before 2022,occasionally,TRUE,one-hop,slow-changing,"https://example.org/x\nhttps://example.org/y",No cat has walked on Mars.,,,,,,,,,,',
  '1,TEST,Who is the current chair of the Example Society?,2025,07/01/2026,FALSE,one-hop,fast-changing,https://example.org/z,Jane Placeholder,J. Placeholder,,,,,,,,,',
  '2,DEV,How many sides does a hexagon have?,before 2022,never,FALSE,one-hop,never-changing,https://example.org/h,6,six,,,,,,,,,',
  '3,TEST,"Which river, in the invented atlas, is longest?",before 2022,hardly_ever,FALSE,multi-hop,never-changing,https://example.org/r,The Long River,,,,,,,,,,"a note, with a comma"',
].join('\n');

export const LONGMEMEVAL_JSON = [
  {
    question_id: 'q_temporal_1',
    question_type: 'temporal-reasoning',
    question: 'What did I ask yesterday about sourdough?',
    answer: 'Whether rye flour works in a sourdough loaf',
    question_date: '2023/05/21 (Sun) 09:00',
    haystack_dates: ['2023/05/20 (Sat) 10:00', '2023/05/18 (Thu) 16:30'],
    haystack_session_ids: ['answer_s1', 's2'],
    haystack_sessions: [
      [
        {
          role: 'user',
          content: 'I am baking a sourdough loaf this weekend. Does rye flour work in it?',
          has_answer: true,
        },
        {
          role: 'assistant',
          content: 'Rye flour works well and gives a denser, tangier crumb with a marmalade note.',
          has_answer: false,
        },
      ],
      [
        { role: 'user', content: 'Can you suggest a name for my new bicycle?' },
        { role: 'assistant', content: 'How about Velocity Vermilion?' },
      ],
    ],
    answer_session_ids: ['answer_s1'],
  },
  {
    question_id: 'q_update_1_abs',
    question_type: 'knowledge-update',
    question: 'How many kayaks do I own now?',
    answer: 2,
    question_date: '2023/06/02 (Fri) 12:00',
    haystack_dates: ['2023/06/01 (Thu) 08:15'],
    haystack_session_ids: ['answer_k1'],
    haystack_sessions: [[{ role: 'user', content: 'I bought a second canoe today.' }]],
    answer_session_ids: ['answer_k1'],
  },
];
