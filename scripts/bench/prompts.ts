/**
 * Grader prompts. Each has a version string that is recorded with every grade, so a number can always be
 * traced to the exact prompt that produced it. Changing a prompt's text means changing its version.
 */

// ── SimpleQA ──
//
// GRADER_TEMPLATE from openai/simple-evals, simpleqa_eval.py (MIT License, Copyright (c) 2024 OpenAI),
// https://github.com/openai/simple-evals/blob/main/simpleqa_eval.py — reproduced unchanged.
// `npm run bench -- download` also fetches that file; the grader compares this copy with it and records
// whether they match (see `checkSimpleQaTemplate`).

export const SIMPLEQA_PROMPT_VERSION = 'simple-evals-grader-template';

export const SIMPLEQA_GRADER_TEMPLATE = `
Your job is to look at a question, a gold target, and a predicted answer, and then assign a grade of either ["CORRECT", "INCORRECT", "NOT_ATTEMPTED"].
First, I will give examples of each grade, and then you will grade a new example.


The following are examples of CORRECT predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia Obama and Sasha Obama
Predicted answer 1: sasha and malia obama
Predicted answer 2: most people would say Malia and Sasha, but I'm not sure and would have to double check
Predicted answer 3: Barack Obama has two daughters. Their names are Malia Ann and Natasha Marian, but they are commonly referred to as Malia Obama and Sasha Obama. Malia was born on July 4, 1998, and Sasha was born on June 10, 2001.
\`\`\`
These predicted answers are all CORRECT because:
    - They fully contain the important information in the gold target.
    - They do not contain any information that contradicts the gold target.
    - Only semantic meaning matters; capitalization, punctuation, grammar, and order don't matter.
    - Hedging and guessing are permissible, provided that the gold target is fully included and the response contains no incorrect information or contradictions.


The following are examples of INCORRECT predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: Malia.
Predicted answer 2: Malia, Sasha, and Susan.
Predicted answer 3: Barack Obama does not have any children.
Predicted answer 4: I think it's either Malia and Sasha. Or it could be Malia and Jackie. Or it could be Joey and Malia.
Predicted answer 4: While I don't know their exact names, I can tell you that Barack Obama has three children.
Predicted answer 5: It's possible you may mean Betsy and Olivia. However, you should clarify further details with updated references if necessary. Is that the correct answer?
Predicted answer 6: It may be the case that Obama's child is named James. However, it's recommended to confirm the most accurate and updated information since this could change over time. This model may not always reflect the most current information.
\`\`\`
These predicted answers are all INCORRECT because:
    - A factual statement in the answer contradicts the gold target. Incorrect statements that have some hedging (e.g., "it is possible that", "although i'm not sure, i think") are also considered incorrect.


The following are examples of NOT_ATTEMPTED predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: I don't know.
Predicted answer 2: I need more context about which Obama you are talking about.
Predicted answer 3: Without researching the web, I cannot answer this question. However, I can tell you that Barack Obama has two children.
Predicted answer 4: Barack Obama has two children. I know that one of them is Malia, but I'm not sure about the other one.
\`\`\`
These predicted answers are all NOT_ATTEMPTED because:
    - The important information in the gold target is not included in the answer.
    - No statements in the answer contradict the gold target.


Also note the following things:
- For grading questions where the gold target is a number, the predicted answer needs to be correct to the last significant figure in the gold answer. For example, consider a question "How many citations does the Transformer Paper have?" with gold target "120k".
    - Predicted answers "120k", "124k", and 115k" are all CORRECT.
    - Predicted answers "100k" and "113k" are INCORRECT.
    - Predicted answers "around 100k" and "more than 50k" are considered NOT_ATTEMPTED because they neither confirm nor contradict the gold target.
- The gold target may contain more information than the question. In such cases, the predicted answer only needs to contain the information that is in the question.
    - For example, consider the question "What episode did Derek and Meredith get legally married in Grey's Anatomy?" with gold target "Season 7, Episode 20: White Wedding". Either "Season 7, Episode 20" or "White Wedding" would be considered a CORRECT answer.
- Do not punish predicted answers if they omit information that would be clearly inferred from the question.
    - For example, consider the question "What city is OpenAI headquartered in?" and the gold target "San Francisco, California". The predicted answer "San Francisco" would be considered CORRECT, even though it does not include "California".
    - Consider the question "What award did A pretrainer's guide to training data: Measuring the effects of data age, domain coverage, quality, & toxicity win at NAACL '24?", the gold target is "Outstanding Paper Award". The predicted answer "Outstanding Paper" would be considered CORRECT, because "award" is presumed in the question.
    - For the question "What is the height of Jason Wei in meters?", the gold target is "1.73 m". The predicted answer "1.75" would be considered CORRECT, because meters is specified in the question.
    - For the question "What is the name of Barack Obama's wife?", the gold target is "Michelle Obama". The predicted answer "Michelle" would be considered CORRECT, because the last name can be presumed.
- Do not punish for typos in people's name if it's clearly the same name.
    - For example, if the gold target is "Hyung Won Chung", you can consider the following predicted answers as correct: "Hyoong Won Choong", "Hyungwon Chung", or "Hyun Won Chung".


Here is a new example. Simply reply with either CORRECT, INCORRECT, NOT ATTEMPTED. Don't apologize or correct yourself if there was a mistake; we are just trying to grade the answer.
\`\`\`
Question: {question}
Gold target: {target}
Predicted answer: {predicted_answer}
\`\`\`

Grade the predicted answer of this new question as one of:
A: CORRECT
B: INCORRECT
C: NOT_ATTEMPTED

Just return the letters "A", "B", or "C", with no text around it.
`.trim();

export function simpleQaPrompt(question: string, target: string, predicted: string): string {
  return SIMPLEQA_GRADER_TEMPLATE.replace('{question}', question)
    .replace('{target}', target)
    .replace('{predicted_answer}', predicted);
}

/** As simple-evals does: the first A, B or C in the reply; anything else is NOT_ATTEMPTED. */
export function parseSimpleQaGrade(reply: string): 'CORRECT' | 'INCORRECT' | 'NOT_ATTEMPTED' {
  const letter = /(A|B|C)/.exec(reply)?.[1] ?? 'C';
  return letter === 'A' ? 'CORRECT' : letter === 'B' ? 'INCORRECT' : 'NOT_ATTEMPTED';
}

/** Whitespace-insensitive check that the template above appears verbatim in the upstream source file. */
export function checkSimpleQaTemplate(upstreamSource: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return norm(upstreamSource).includes(norm(SIMPLEQA_GRADER_TEMPLATE));
}

// ── FreshQA ──
//
// Written for this harness from the FreshQA paper's description of FreshEval's RELAXED mode (Vu et al.,
// "FreshLLMs: Refreshing Large Language Models with Search Engine Augmentation", 2023): the primary answer
// must be correct and match an accepted answer; hallucinated or outdated material elsewhere in the response
// is tolerated; a false-premise question is credited only if the response points out the false premise.

export const FRESHQA_PROMPT_VERSION = 'freshqa-relaxed-v1';

export function freshQaPrompt(input: {
  question: string;
  answers: string[];
  falsePremise: boolean;
  askedOn: string;
  response: string;
}): string {
  const accepted = input.answers.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  return `You are grading a response to a question from the FreshQA benchmark, using its RELAXED evaluation mode.

Under relaxed evaluation, hallucinations, outdated information and ill-formed parts of the response are
tolerated as long as the PRIMARY answer is accurate. Grade as follows.

1. Identify the primary answer: the response's main, most direct answer to the question.
2. CORRECT: the primary answer is accurate and matches at least one of the accepted answers below in
   meaning. Wording, formatting and extra detail may differ. A number must match to the precision the
   accepted answer gives. If the question asks for several items, the primary answer must contain all of them.
   Additional statements elsewhere in the response, even outdated or wrong ones, do not change the grade
   unless they contradict or replace the primary answer.
3. INCORRECT: the primary answer is wrong, matches none of the accepted answers, offers several mutually
   exclusive candidates without committing to one, or contradicts itself.
4. NOT_ATTEMPTED: the response gives no answer at all (for example it says it does not know, asks for
   clarification, or only describes how the answer could be found).
5. False premise. ${
    input.falsePremise
      ? 'THIS QUESTION HAS A FALSE PREMISE. The response is CORRECT only if it explicitly points out that the premise is false (as the accepted answers do). A response that answers as if the premise were true is INCORRECT, even if it adds a caveat elsewhere.'
      : 'This question has a valid premise. A response that wrongly claims the premise is false is INCORRECT.'
  }

The accepted answers were recorded on 2026-04-21. The question was asked on ${input.askedOn}. Grade against
the accepted answers only; do not use your own knowledge to replace them.

Question: ${input.question}
Accepted answers:
${accepted}
Response: ${input.response}

Reply with exactly two lines:
Reasoning: <one or two sentences>
Grade: CORRECT | INCORRECT | NOT_ATTEMPTED`;
}

/** The last `Grade:` line; null when the reply has none (the item stays ungraded and is retried). */
export function parseLabelledGrade(
  reply: string,
): 'CORRECT' | 'INCORRECT' | 'NOT_ATTEMPTED' | null {
  const matches = [...reply.matchAll(/Grade:\s*\**\s*(CORRECT|INCORRECT|NOT[_ ]ATTEMPTED)/gi)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  const up = last.toUpperCase().replace(' ', '_');
  return up === 'CORRECT' ? 'CORRECT' : up === 'INCORRECT' ? 'INCORRECT' : 'NOT_ATTEMPTED';
}

// ── LongMemEval ──
//
// Written for this harness after the LLM-judge prompts described in the LongMemEval paper and repository
// (Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", 2024;
// src/evaluation/evaluate_qa.py, MIT): one yes/no judgement per question type. Temporal reasoning
// tolerates off-by-one errors in day counts, knowledge-update accepts the latest answer even when earlier
// information is also mentioned, preference questions are judged against a rubric, and abstention
// questions are credited when the response says the question cannot be answered from what it knows.

export const LONGMEMEVAL_PROMPT_VERSION = 'longmemeval-judge-v1';

export function longMemPrompt(input: {
  questionType: string;
  abstention: boolean;
  question: string;
  answer: string;
  response: string;
}): string {
  const { question, answer, response } = input;
  if (input.abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: ${question}

Explanation: ${answer}

Model Response: ${response}

Does the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  const base =
    'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
  const tail = `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  switch (input.questionType) {
    case 'temporal-reasoning':
      return `${base} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.${tail}`;
    case 'knowledge-update':
      return `${base} If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.${tail}`;
    case 'single-session-preference':
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    default:
      return `${base}${tail}`;
  }
}

/** "yes" anywhere in the reply, as the reference evaluation reads it. */
export function parseYesNo(reply: string): 'CORRECT' | 'INCORRECT' {
  return /\byes\b/i.test(reply) ? 'CORRECT' : 'INCORRECT';
}
