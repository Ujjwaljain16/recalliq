import { MessageRepository } from '../../db/index.js';
import type { ComponentEnv, ComponentFactory, Components } from '../components.js';
import { SqliteMemoryRetriever } from '../memory-adapter.js';
import { LoaderBaselineSource, MessageWindowReader } from '../store-adapters.js';
import { ScriptedAnalyzer } from './analyzer.js';
import { ScriptedAnswer, type ScriptedAnswerOptions } from './answer.js';
import { ScriptedResearch } from './research.js';

export { ScriptedAnalyzer, scriptedAnalysis } from './analyzer.js';
export { ScriptedAnswer } from './answer.js';
export { ScriptedResearch } from './research.js';

/**
 * DEVELOPMENT / SCRIPTED COMPONENT SET. Deterministic canned analysis, findings and sentences: no search, no
 * model, no network. It exists so the application surface (HTTP, streaming, acknowledgement, the browser
 * client) can be exercised end to end. Nothing it says is real research.
 *
 * The stores (memory, baselines, message window) are the real SQLite adapters; only the analyzer, the research
 * service and the answer pipeline are scripted.
 */
export function createScriptedComponents(
  env: ComponentEnv,
  options: ScriptedAnswerOptions = {},
): Components {
  const messages = new MessageRepository(env.db, env.clock);
  return {
    kind: 'scripted',
    analyzer: new ScriptedAnalyzer(),
    research: new ScriptedResearch(env.db, env.clock),
    answer: new ScriptedAnswer(options),
    baselines: new LoaderBaselineSource(env.db),
    window: new MessageWindowReader(messages),
    memory: new SqliteMemoryRetriever(env.db),
  };
}

export const scriptedFactory =
  (options: ScriptedAnswerOptions = {}): ComponentFactory =>
  (env) =>
    createScriptedComponents(env, options);
