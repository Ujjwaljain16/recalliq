import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { registrableDomain } from '../authority.js';
import type { CalibrationSet } from './gold.js';

/**
 * An optional owner registry for the evaluation: a JSON object mapping an entity name to the domains that entity
 * owns, in the same format as OFFICIAL_DOMAINS_FILE. A domain listed for two names is owned by neither. There is
 * no default registry: without one, no page has an owned domain and the verifier judges subjects as it always did.
 *
 *   { "close": ["close.com"], "hubspot": ["hubspot.com"] }
 */
export type EntityRegistry = ReadonlyMap<string, readonly string[]>;

const registrySchema = z.record(z.string().min(1), z.array(z.string().min(1)));

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function parseRegistry(json: unknown): EntityRegistry {
  const parsed = registrySchema.parse(json);
  const byName = new Map<string, Set<string>>();
  for (const [name, domains] of Object.entries(parsed)) {
    const set = byName.get(norm(name)) ?? new Set<string>();
    for (const d of domains) set.add(registrableDomain(d));
    byName.set(norm(name), set);
  }
  const claims = new Map<string, number>();
  for (const set of byName.values()) for (const d of set) claims.set(d, (claims.get(d) ?? 0) + 1);
  return new Map(
    [...byName].map(([name, set]) => [name, [...set].filter((d) => (claims.get(d) ?? 0) === 1)]),
  );
}

export function loadRegistryFile(file: string): EntityRegistry {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`--registry: cannot read "${file}" as JSON`);
  }
  try {
    return parseRegistry(json);
  } catch {
    throw new Error(`--registry: "${file}" must be an object of entity name to a list of domains`);
  }
}

/** The domains the registry lists for an entity, matched on its name or any alias. */
export function ownedDomainsFor(
  registry: EntityRegistry | undefined,
  names: readonly string[],
): string[] {
  if (!registry) return [];
  const out = new Set<string>();
  for (const n of names) for (const d of registry.get(norm(n)) ?? []) out.add(d);
  return [...out];
}

/**
 * A MEASUREMENT AID, not an owner registry: each gold page's own vendor mapped to the registrable domain of the
 * page's URL. It answers "what would the verifier do if the owner had registered the vendors of these pages",
 * so the ceiling with a registry can be compared with the ceiling without one.
 */
export function registryFromGoldPages(set: CalibrationSet): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of set.pages) {
    const domains = (out[p.gold.entity.name] ??= []);
    const d = registrableDomain(p.page.url);
    if (!domains.includes(d)) domains.push(d);
  }
  return out;
}
