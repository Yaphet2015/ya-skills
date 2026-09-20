export type FlagTokens = {
  values: Record<string, string | undefined>;
  repeatable: Record<string, string[]>;
  positional: string[];
};

export type FlagParserOptions = {
  allowed: ReadonlySet<string>;
  known?: ReadonlySet<string>;
  boolean?: ReadonlySet<string>;
  repeatable?: ReadonlySet<string>;
  fail?: (message: string) => never;
};

function defaultFail(message: string): never {
  throw new Error(message);
}

/** Parse the shared `--flag value` / `--flag=value` command-line shape. */
export function tokenizeFlags(argv: string[], options: FlagParserOptions): FlagTokens {
  const fail = options.fail ?? defaultFail;
  const boolean = options.boolean ?? new Set<string>();
  const repeatable = options.repeatable ?? new Set<string>();
  const known = options.known ?? new Set([...options.allowed, ...boolean]);
  const out: FlagTokens = { values: {}, repeatable: {}, positional: [] };

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]!;
    if (!raw.startsWith("--")) {
      out.positional.push(raw);
      continue;
    }

    const body = raw.slice(2);
    const equals = body.indexOf("=");
    const flag = equals === -1 ? body : body.slice(0, equals);
    if (flag === "") fail(`unknown flag syntax: ${raw}`);
    if (!options.allowed.has(flag)) {
      fail(known.has(flag) ? `--${flag} is not valid for this action` : `unknown flag: --${flag}`);
    }

    if (boolean.has(flag)) {
      if (equals !== -1) fail(`--${flag} does not take a value`);
      if (out.values[flag] !== undefined) fail(`--${flag} given twice`);
      out.values[flag] = "true";
      continue;
    }

    let value: string;
    if (equals !== -1) {
      value = body.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail(`--${flag} requires a value`);
      value = next;
      index++;
    }

    if (repeatable.has(flag)) {
      (out.repeatable[flag] ??= []).push(value);
    } else {
      if (out.values[flag] !== undefined) fail(`--${flag} given twice`);
      out.values[flag] = value;
    }
  }

  return out;
}
