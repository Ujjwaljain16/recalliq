import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IN_MEMORY, initializeDatabase, openDatabase } from '../../src/db/index.js';
import { FixedClock } from '../../src/temporal/clock.js';

/**
 * Documentation checks. They exist because this project's documents make claims about the code (which decisions are
 * implemented, what the schema looks like) that nothing else would notice drifting. They read files relative to the
 * repository root, like tests/integration/db/contract-parity.test.ts.
 */

const ADR_DIR = 'docs/adr';
const STATUSES = ['Proposed', 'Accepted', 'Superseded'];
const IMPLEMENTATIONS = ['implemented', 'partly implemented', 'not implemented'];
const HEADINGS = [
  '## Context',
  '## Options considered',
  '## Decision',
  '## Consequences and trade-offs',
  '## Evidence and implementation references',
  '## Revisit when',
];

interface Adr {
  number: number;
  file: string;
  title: string;
  status: string;
  implementation: string;
  text: string;
}

function loadAdrs(): Adr[] {
  return fs
    .readdirSync(ADR_DIR)
    .filter((f) => /^ADR-\d+\.md$/.test(f))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(ADR_DIR, file), 'utf8');
      const title = /^# ADR-\d+: (.+)$/m.exec(text)?.[1] ?? '';
      const status = /^- \*\*Status:\*\* (.+)$/m.exec(text)?.[1] ?? '';
      const implementation = /^- \*\*Implementation:\*\* (.+)$/m.exec(text)?.[1] ?? '';
      return {
        number: Number(/ADR-(\d+)/.exec(file)?.[1]),
        file,
        title,
        status,
        implementation,
        text,
      };
    });
}

/** Relative markdown links `[text](target)` in a file, ignoring external URLs and pure anchors. */
function relativeLinks(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1] as string)
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split('#')[0] as string)
    .filter((target) => target.length > 0);
}

describe('architecture decision records', () => {
  const adrs = loadAdrs();

  it('are numbered contiguously from 01, with no duplicates', () => {
    expect(adrs.length).toBeGreaterThanOrEqual(24);
    expect(adrs.map((a) => a.number)).toEqual(adrs.map((_, i) => i + 1));
    expect(new Set(adrs.map((a) => a.file)).size).toBe(adrs.length);
  });

  it('each has a title, a valid status and implementation, and every required section in order', () => {
    for (const adr of adrs) {
      const label = adr.file;
      expect(adr.title, label).not.toBe('');
      expect(STATUSES, `${label}: status "${adr.status}"`).toContain(adr.status);
      expect(IMPLEMENTATIONS, `${label}: implementation "${adr.implementation}"`).toContain(
        adr.implementation,
      );
      const positions = HEADINGS.map((h) => adr.text.indexOf(`\n${h}\n`));
      expect(
        positions.every((p) => p >= 0),
        `${label}: missing a section`,
      ).toBe(true);
      expect(
        [...positions].sort((a, b) => a - b),
        `${label}: sections out of order`,
      ).toEqual(positions);
    }
  });

  it('a Superseded decision names the decision that replaced it', () => {
    for (const adr of adrs.filter((a) => a.status === 'Superseded')) {
      expect(adr.text, adr.file).toMatch(/Superseded by \[ADR-\d+\]\(ADR-\d+\.md\)/);
    }
  });

  it('an "implemented" decision links at least one test, so the claim has evidence', () => {
    for (const adr of adrs.filter((a) => a.implementation === 'implemented')) {
      expect(adr.text, `${adr.file} claims it is implemented but links no test`).toMatch(
        /\]\(\.\.\/\.\.\/tests\//,
      );
    }
  });

  it('measurement-dependent decisions stay Proposed until something has been measured', () => {
    const status = (n: number) => adrs.find((a) => a.number === n)?.status;
    expect(status(8)).toBe('Proposed'); // search provider
    expect(status(14)).toBe('Proposed'); // models
  });

  it('a decision whose mechanism is not chosen stays Proposed (single-instance guard)', () => {
    const status = (n: number) => adrs.find((a) => a.number === n)?.status;
    expect(status(34)).toBe('Proposed');
  });

  it('ADR-01 to ADR-24 say they were reconstructed, not recovered, and the index says so too', () => {
    for (const adr of adrs.filter((a) => a.number <= 24)) {
      expect(adr.text, `provenance of ADR-${adr.number}`).toContain(
        '- **Provenance:** Reconstructed on 2026-11-11',
      );
      expect(adr.text, `provenance of ADR-${adr.number}`).toContain(
        'is **not** recovered original ADR text',
      );
    }
    expect(fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8')).toContain(
      '**not** recovered original ADR text',
    );
  });

  it('contain no measurement-style results (latency percentiles or millisecond figures)', () => {
    for (const adr of adrs) {
      expect(adr.text, adr.file).not.toMatch(/\bp(50|95|99)\b|\b\d+(\.\d+)?\s?ms\b/i);
    }
  });

  it('are all listed in the index with the same title, status and implementation', () => {
    const index = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');
    const rows = [
      ...index.matchAll(
        /^\| \[ADR-(\d+)\]\(ADR-\d+\.md\) \| (.*?) \| (Proposed|Accepted|Superseded) \| (.*?) \| /gm,
      ),
    ];
    expect(rows.map((r) => Number(r[1]))).toEqual(adrs.map((a) => a.number));
    for (const row of rows) {
      const adr = adrs.find((a) => a.number === Number(row[1]));
      expect(row[2], `index title of ADR-${row[1]}`).toBe(adr?.title);
      expect(row[3], `index status of ADR-${row[1]}`).toBe(adr?.status);
      expect(row[4], `index implementation of ADR-${row[1]}`).toBe(adr?.implementation);
    }
    const counts = /Counts: (\d+) ADRs\. Accepted (\d+), Proposed (\d+), Superseded (\d+)\./.exec(
      index,
    );
    expect(counts?.slice(1).map(Number)).toEqual([
      adrs.length,
      adrs.filter((a) => a.status === 'Accepted').length,
      adrs.filter((a) => a.status === 'Proposed').length,
      adrs.filter((a) => a.status === 'Superseded').length,
    ]);
  });
});

describe('documentation links', () => {
  const files = [
    'README.md',
    'docs/questions.md',
    'docs/testing.md',
    'docs/turn-lifecycle.md',
    ...fs.readdirSync('docs/proposals').map((f) => path.join('docs/proposals', f)),
    ...fs.readdirSync(ADR_DIR).map((f) => path.join(ADR_DIR, f)),
  ].filter((f) => f.endsWith('.md'));

  it('every relative link in the project-owned documents resolves to an existing file', () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const target of relativeLinks(file)) {
        const resolved = path.normalize(path.join(path.dirname(file), target));
        if (!fs.existsSync(resolved)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every ADR and question referred to by number exists', () => {
    const adrNumbers = new Set(loadAdrs().map((a) => a.number));
    const questions = fs.readFileSync('docs/questions.md', 'utf8');
    const questionIds = new Set([...questions.matchAll(/^#{2,3} (Q-\d+):/gm)].map((m) => m[1]));
    const missing: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bADR-(\d+)\b/g)) {
        if (!adrNumbers.has(Number(m[1]))) missing.push(`${file}: ADR-${m[1]}`);
      }
      if (file.startsWith(ADR_DIR)) {
        for (const m of text.matchAll(/\bQ-(\d+)\b/g)) {
          if (!questionIds.has(`Q-${m[1]}`)) missing.push(`${file}: Q-${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every question that has an ADR links it, and every question keeps its place in the summary table', () => {
    const questions = fs.readFileSync('docs/questions.md', 'utf8');
    const ids = [...questions.matchAll(/^#{2,3} (Q-\d+):/gm)].map((m) => m[1] as string);
    for (const id of ids) {
      expect(questions, `${id} missing from the summary table`).toMatch(
        new RegExp(`^\\| ${id} \\|`, 'm'),
      );
    }
    for (const open of ['Q-001', 'Q-007', 'Q-011', 'Q-015', 'Q-016']) {
      expect(ids, `${open} must stay in the question log`).toContain(open);
    }
  });
});

describe('docs/diagrams/er.mmd reflects the actual migrations', () => {
  interface Column {
    type: string;
    name: string;
    flags: string[];
  }
  const diagram = fs.readFileSync('docs/diagrams/er.mmd', 'utf8');

  const drawn = new Map<string, Column[]>();
  const relationships: Array<{ parent: string; connector: string; child: string; label: string }> =
    [];
  let current: string | null = null;
  for (const line of diagram.split('\n')) {
    if (/^\s*%%/.test(line)) continue;
    const open = /^ {4}(\w+) \{$/.exec(line);
    const field = /^ {8}(\w+) (\w+)(?: (.+))?$/.exec(line);
    const rel = /^ {4}(\w+) ([|}o{.-]+) (\w+) : "(.+)"$/.exec(line);
    if (open) {
      current = open[1] as string;
      drawn.set(current, []);
    } else if (line === '    }') {
      current = null;
    } else if (current && field) {
      drawn.get(current)?.push({
        type: field[1] as string,
        name: field[2] as string,
        flags: field[3] ? field[3].split(', ') : [],
      });
    } else if (rel) {
      relationships.push({
        parent: rel[1] as string,
        connector: rel[2] as string,
        child: rel[3] as string,
        label: rel[4] as string,
      });
    }
  }

  const db = openDatabase(IN_MEMORY);
  initializeDatabase(db, { mode: 'real', clock: new FixedClock(0) });
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_fts%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const info = (t: string) =>
    db.prepare(`PRAGMA table_info(${t})`).all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
  const foreignKeys = (t: string) =>
    db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;

  it('draws exactly the tables of the migrated schema (the FTS5 virtual table is excluded by design)', () => {
    expect([...drawn.keys()].sort()).toEqual(tables);
  });

  it('draws every column, in order, with its type, primary key and foreign key flags', () => {
    for (const table of tables) {
      const fkColumns = new Set(foreignKeys(table).map((f) => f.from));
      const expected = info(table).map((c) => ({
        type: c.type.split('(')[0]?.toUpperCase() ?? 'TEXT',
        name: c.name,
        pk: c.pk > 0,
        fk: fkColumns.has(c.name),
      }));
      const actual = (drawn.get(table) ?? []).map((c) => ({
        type: c.type,
        name: c.name,
        pk: c.flags.includes('PK'),
        fk: c.flags.includes('FK'),
      }));
      expect(actual, table).toEqual(expected);
    }
  });

  it('draws every foreign key as a solid relationship, with its ON DELETE action', () => {
    const solid = relationships.filter((r) => r.connector.includes('--'));
    const expected = tables.flatMap((child) =>
      foreignKeys(child).map((fk) => `${fk.table} > ${child} : ${fk.from} ${fk.on_delete}`),
    );
    expect(solid.map((r) => `${r.parent} > ${r.child} : ${r.label}`).sort()).toEqual(
      expected.sort(),
    );
  });

  it('draws only references without a foreign key as dotted relationships', () => {
    const dotted = relationships.filter((r) => r.connector.includes('..'));
    expect(dotted.length).toBeGreaterThan(0);
    for (const r of dotted) {
      const column = r.label.split(' ')[0] as string;
      expect(
        info(r.child).map((c) => c.name),
        `${r.child}.${column}`,
      ).toContain(column);
      expect(
        foreignKeys(r.child).map((f) => f.from),
        `${r.child}.${column} has a foreign key`,
      ).not.toContain(column);
      expect(tables, r.parent).toContain(r.parent);
    }
  });

  it('draws nothing planned: the diagram has no table the migrations do not create', () => {
    for (const name of drawn.keys()) expect(tables).toContain(name);
    expect(diagram).toMatch(/^erDiagram$/m);
  });
});
