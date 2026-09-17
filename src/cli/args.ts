export interface Args {
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
  has(name: string): boolean;
  str(name: string, fallback: string): string;
  num(name: string, fallback: number): number;
}

/** Parser minimo: --flag, --chave valor, --chave=valor, resto posicional. */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      options.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(body, next);
      i += 1;
    } else {
      flags.add(body);
    }
  }

  return {
    flags,
    options,
    positional,
    has: (name) => flags.has(name) || options.has(name),
    str: (name, fallback) => options.get(name) ?? fallback,
    num: (name, fallback) => {
      const raw = options.get(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
  };
}
