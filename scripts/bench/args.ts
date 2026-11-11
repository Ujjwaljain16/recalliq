/** `--name value`, `--name=value` and bare `--flag` (true). Positional arguments are collected in order. */
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const v = args.flags.get(name);
  return v === true || v === 'true' || v === '1';
}

export function intFlag(args: ParsedArgs, name: string, fallback: number): number {
  const v = stringFlag(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

/** Every flag must be one of `known`: a typo is an error, not silently ignored. */
export function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  const unknown = [...args.flags.keys()].filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(`unknown flag(s): ${unknown.map((k) => `--${k}`).join(', ')}`);
  }
}
