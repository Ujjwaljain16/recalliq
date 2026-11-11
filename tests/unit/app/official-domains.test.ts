import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAppEnv } from '../../../src/app/env.js';
import { replayFactory, ReplayConfigurationError } from '../../../src/app/live.js';
import type { EntityRow } from '../../../src/app/live/entities.js';
import { OfficialDomains, OfficialDomainsError } from '../../../src/app/live/registry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function file(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-registry-'));
  dirs.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const entity = (name: string, domains: string[] = [], aliases: string[] = []): EntityRow => ({
  id: `ent_${name}`,
  name,
  aliases,
  plans: [],
  officialDomains: domains,
});

describe('OfficialDomains', () => {
  it('lists every registered domain for a name, matched on name or alias, and nothing else', () => {
    const r = new OfficialDomains({ 'Acme CRM': ['acme.example', 'www.acme-crm.example'] });
    expect(r.domainsFor(entity('Acme CRM')).sort()).toEqual(['acme-crm.example', 'acme.example']);
    expect(r.domainsFor(entity('Something', [], ['acme crm']))).toHaveLength(2);
    // a domain that looks right but is not listed is not official
    expect(r.domainsFor(entity('Acme CRM'))).not.toContain('acme.sample');
    expect(r.domainsFor(entity('Unlisted Tool'))).toEqual([]);
  });

  it('treats a domain claimed by two names as official for neither', () => {
    const r = new OfficialDomains({
      'acme crm': ['shared.example', 'acme.example'],
      'beta suite': ['shared.example'],
    });
    expect(r.domainsFor(entity('acme crm'))).toEqual(['acme.example']);
    expect(r.domainsFor(entity('beta suite'))).toEqual([]);
    expect(r.conflicting.has('shared.example')).toBe(true);
  });

  it('removes a domain two entities carry, whatever its source, and keeps a domain the row alone carries', () => {
    const r = OfficialDomains.none();
    const a = entity('Acme CRM', ['acme.example', 'dup.example']);
    const b = entity('Beta Suite', ['dup.example']);
    r.apply([a, b]);
    expect(a.officialDomains).toEqual(['acme.example']);
    expect(b.officialDomains).toEqual([]);
  });

  it('with no registry, nothing a name suggests becomes official', () => {
    const e = entity('Neon');
    OfficialDomains.none().apply([e]);
    expect(e.officialDomains).toEqual([]);
  });

  it('only the listed domain is official when two hosts share a name label (neon.tech versus neon.com)', () => {
    const r = new OfficialDomains({ neon: ['neon.example'] });
    const e = entity('Neon');
    r.apply([e]);
    expect(e.officialDomains).toEqual(['neon.example']);
    expect(e.officialDomains).not.toContain('neon.tech');
  });
});

describe('OFFICIAL_DOMAINS_FILE', () => {
  it('a missing file fails at startup naming the variable', () => {
    expect(() => OfficialDomains.fromFile('/no/such/registry.json')).toThrow(OfficialDomainsError);
    expect(() => OfficialDomains.fromFile('/no/such/registry.json')).toThrow(
      /OFFICIAL_DOMAINS_FILE/,
    );
  });

  it('a malformed file fails with a clear message, never silently ignored', () => {
    for (const content of ['not json', '[]', '{"acme": "acme.example"}', '{"acme": [1]}']) {
      const p = file('bad.json', content);
      expect(() => OfficialDomains.fromFile(p), content).toThrow(/OFFICIAL_DOMAINS_FILE/);
    }
  });

  it('the replay set fails before the database is opened when the registry is unusable', () => {
    const fixture = file(
      'fixture.json',
      JSON.stringify({ version: 1, class: 'synthetic', label: '[SYNTHETIC] x' }),
    );
    const env = loadAppEnv({
      APP_MODE: 'demo',
      APP_COMPONENTS: 'replay',
      REPLAY_FIXTURE: fixture,
      OFFICIAL_DOMAINS_FILE: '/no/such/registry.json',
    });
    expect(() => replayFactory(env)).toThrow(/OFFICIAL_DOMAINS_FILE/);
    expect(() => replayFactory(env)).not.toThrow(ReplayConfigurationError);
  });

  it('is optional: without it the replay set starts with no official domains', () => {
    const fixture = file(
      'fixture.json',
      JSON.stringify({ version: 1, class: 'synthetic', label: '[SYNTHETIC] x' }),
    );
    const env = loadAppEnv({ APP_MODE: 'demo', APP_COMPONENTS: 'replay', REPLAY_FIXTURE: fixture });
    expect(env.officialDomainsFile).toBeUndefined();
    expect(replayFactory(env)).toBeTypeOf('function');
  });
});
