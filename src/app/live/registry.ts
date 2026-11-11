import fs from 'node:fs';
import { z } from 'zod';
import { registrableDomain } from '../../evidence/authority.js';
import { normalizeEntityName } from '../../orchestration/planner.js';
import type { EntityRow } from './entities.js';

/**
 * The owner's registry of official domains: a JSON object mapping a normalised entity name to the registrable
 * domains that entity owns. It is the only source of official-domain status besides a domain the entity row
 * already carries from an explicit earlier source. There is no default registry and none is downloaded: without
 * one, nothing is official and every page is classified below tier A.
 *
 *   { "acme crm": ["acme.example"], "beta suite": ["beta.example", "beta-suite.example"] }
 *
 * A domain that is not listed is not official, even when it looks right. A domain listed for two entities is
 * official for neither.
 */

export class OfficialDomainsError extends Error {
  constructor(message: string) {
    super(`OFFICIAL_DOMAINS_FILE: ${message}`);
    this.name = 'OfficialDomainsError';
  }
}

const registrySchema = z.record(z.string().min(1), z.array(z.string().min(1)));

export class OfficialDomains {
  private readonly byName: ReadonlyMap<string, readonly string[]>;
  /** Domains claimed by more than one entity name: official for none. */
  readonly conflicting: ReadonlySet<string>;

  constructor(raw: Readonly<Record<string, readonly string[]>> = {}) {
    const byName = new Map<string, Set<string>>();
    for (const [name, domains] of Object.entries(raw)) {
      const key = normalizeEntityName(name);
      const set = byName.get(key) ?? new Set<string>();
      for (const d of domains) set.add(registrableDomain(d));
      byName.set(key, set);
    }
    const claims = new Map<string, number>();
    for (const set of byName.values()) for (const d of set) claims.set(d, (claims.get(d) ?? 0) + 1);
    this.conflicting = new Set([...claims].filter(([, n]) => n > 1).map(([d]) => d));
    this.byName = new Map(
      [...byName].map(([k, set]) => [k, [...set].filter((d) => !this.conflicting.has(d))]),
    );
  }

  static none(): OfficialDomains {
    return new OfficialDomains();
  }

  /** Reads and validates the file. Throws OfficialDomainsError naming the variable. */
  static fromFile(file: string): OfficialDomains {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new OfficialDomainsError(`cannot read the registry file "${file}"`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OfficialDomainsError(`"${file}" is not valid JSON`);
    }
    const parsed = registrySchema.safeParse(json);
    if (!parsed.success) {
      throw new OfficialDomainsError(
        `"${file}" must be an object of entity name to a list of domains (${parsed.error.issues[0]?.message ?? 'invalid'})`,
      );
    }
    return new OfficialDomains(parsed.data);
  }

  /** The registry's official domains for an entity, matched on its name or any alias. */
  domainsFor(entity: Pick<EntityRow, 'name' | 'aliases'>): string[] {
    const out = new Set<string>();
    for (const n of [entity.name, ...entity.aliases]) {
      for (const d of this.byName.get(normalizeEntityName(n)) ?? []) out.add(d);
    }
    return [...out];
  }

  /**
   * Sets `officialDomains` of every entity in place to what the registry and its own row say, and removes a
   * domain that two of these entities both carry. Called on every run, so a registry change takes effect at
   * once and nothing is stored.
   */
  apply(entities: EntityRow[]): void {
    const claims = new Map<string, number>();
    const merged = entities.map((e) => {
      const set = new Set([
        ...e.officialDomains.map((d) => registrableDomain(d)),
        ...this.domainsFor(e),
      ]);
      for (const d of set) claims.set(d, (claims.get(d) ?? 0) + 1);
      return set;
    });
    entities.forEach((e, i) => {
      const unique = (d: string) => (claims.get(d) ?? 0) === 1 && !this.conflicting.has(d);
      e.officialDomains = [...(merged[i] ?? [])].filter(unique);
      // Only what the registry itself maps to this entity: explicit ownership, kept apart from the rest.
      e.ownedDomains = this.domainsFor(e).filter(unique);
    });
  }
}
