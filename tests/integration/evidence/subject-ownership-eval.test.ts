import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import { OracleLlm } from '../../../src/evidence/eval/llm.js';
import { parseRegistry, registryFromGoldPages } from '../../../src/evidence/eval/registry.js';
import { runExtraction } from '../../../src/evidence/eval/runner.js';

/**
 * The evaluation harness with an optional owner registry: the same oracle model, the same pages, with and without
 * owned domains. The registry derived here from the pages' own URLs is a measurement aid, not an owner registry.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const set = loadCalibrationSet(join(ROOT, 'tests', 'fixtures', 'calibration'));
const NOW = Date.UTC(2026, 10, 12, 12);

const passes = (runs: Awaited<ReturnType<typeof runExtraction>>) =>
  runs.flatMap((r) => r.statements).filter((s) => s.verification.status === 'pass').length;

describe('extraction evaluation with an owner registry', () => {
  it("T-EV-OWN-70: by default there is no registry, and with one the oracle model's passes rise as the oracle test says", async () => {
    const llm = () => new OracleLlm(set.pages);
    const none = await runExtraction(set, { llm: llm(), now: NOW });
    const registry = parseRegistry(registryFromGoldPages(set));
    const withIt = await runExtraction(set, { llm: llm(), now: NOW, registry });
    expect(passes(none)).toBe(15);
    expect(passes(withIt)).toBe(40);
  });

  it('T-EV-OWN-71: the command takes --registry, and refuses an unreadable or malformed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recalliq-registry-'));
    try {
      const script = join(ROOT, 'scripts', 'extraction-eval.ts');
      const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            script,
            'run',
            '--adapter',
            'oracle',
            '--pages',
            'close-plans-and-billing',
            ...args,
          ],
          {
            cwd: ROOT,
            env,
            encoding: 'utf8',
            timeout: 60_000,
          },
        );
      const missing = run(['--registry', join(dir, 'nope.json')]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('--registry');
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{"Close": "close.com"}');
      expect(run(['--registry', bad]).status).toBe(2);
      const good = join(dir, 'good.json');
      writeFileSync(good, '{"Close": ["close.com"]}');
      const ok = run(['--registry', good]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('close-plans-and-billing');
      expect(ok.stdout).toContain('owner registry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
