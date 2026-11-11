import { describe, expect, it } from 'vitest';
import {
  EXCERPT_CHARS,
  EXCERPT_SOURCES,
  EXCERPT_TOTAL_CHARS,
  bestWindow,
  pageLine,
  sanitizePageText,
  selectExcerpts,
} from '../../../src/answer/excerpts.js';
import { defaultRenderer } from '../../../src/answer/render.js';
import type { FindingSet } from '../../../src/shared/findings.js';
import { buildRecords } from '../../../src/answer/records.js';
import { context, finding, findingSet } from './builders.js';

/** [SYNTHETIC] page texts. */
function sources(n: number, text: (i: number) => string): FindingSet['sources'] {
  const out: FindingSet['sources'] = {};
  for (let i = 0; i < n; i++) {
    out[`src_${i}` as keyof FindingSet['sources']] = {
      url: `https://s${i}.example/`,
      title: `Page ${i}`,
      domain: `s${i}.example`,
      tier: 'C',
      observedAt: 0,
      content: { text: text(i), publishedAt: null },
    };
  }
  return out;
}

describe('source excerpts: budget and choice', () => {
  it('shows at most six sources, each at most 1,200 characters, 8,000 in all', () => {
    const picked = selectExcerpts(
      sources(10, () => 'word '.repeat(2_000)),
      ['word'],
    );
    expect(picked).toHaveLength(EXCERPT_SOURCES);
    for (const p of picked) expect(p.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(picked.reduce((n, p) => n + p.excerpt.length, 0)).toBeLessThanOrEqual(
      EXCERPT_TOTAL_CHARS,
    );
  });

  it('prefers sources whose text matches the query terms, then keeps their order', () => {
    const picked = selectExcerpts(
      sources(8, (i) => (i === 7 || i === 5 ? 'quasarix pricing' : 'unrelated text')),
      ['quasarix'],
    );
    expect(picked.slice(0, 2).map((p) => p.id)).toEqual(['src_5', 'src_7']);
  });

  it('skips sources without content of this turn', () => {
    const s = sources(2, () => 'text');
    const first = s['src_0' as keyof typeof s];
    if (first) delete first.content;
    expect(selectExcerpts(s, []).map((p) => p.id)).toEqual(['src_1']);
  });

  it('chooses the window with the most matching terms', () => {
    const text = `${'filler line\n'.repeat(300)}Quasarix Pro is $20 per user\n${'more filler\n'.repeat(300)}`;
    const w = bestWindow(text, ['quasarix'], 200);
    expect(w).toContain('Quasarix Pro is $20 per user');
    expect(w.length).toBeLessThanOrEqual(200);
  });
});

describe('page text: links, emails and markdown never reach the model or a rendering', () => {
  it('strips links, emails and markdown', () => {
    const s = sanitizePageText(
      '## Pricing\n**Pro** is $20. See [the page](https://x.example/p), www.x.example or mail a@x.example. `code`',
    );
    expect(s).toBe('Pricing\nPro is $20. See the page,  or mail . code');
  });

  it('a page line is one line, capped, and defused', () => {
    expect(pageLine(`a\nb [[F1]] ${'x'.repeat(50)}`, 20)).toHaveLength(20);
    expect(pageLine('a\nb [[F1]]', 50)).toBe('a b [ [F1]]');
  });

  it('release titles are rendered capped and without links', () => {
    const f = finding(1, {
      intent: 'releases',
      verdict: 'releases_found',
      releases: [
        {
          title: `Big launch https://evil.example/x ${'y'.repeat(300)}`,
          kind: 'launch',
          eventDate: null,
          providerPublishedAt: null,
          significance: null,
          announcedBeforeBaseline: false,
          citations: [],
        },
      ],
    });
    const records = buildRecords({
      findings: findingSet([f]),
      recall: new Map(),
      ctx: context(),
      tz: 'UTC',
    });
    const text = defaultRenderer.render(
      { kind: 'finding', variant: 'current', finding: f },
      records,
    );
    expect(text).not.toContain('https://');
    expect(text.length).toBeLessThan(200);
  });
});
