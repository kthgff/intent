/**
 * args.ts — argv parsing for the `sprint-runner` CLI (wp-099).
 *
 * Deliberately tiny — no dependency. `--flag value` and `--flag=value`
 * forms are both accepted; `-h`/`-v` are the only short aliases.
 * Unknown flags fail closed with a usage error (exit 2).
 */
export interface ParsedArgs {
  /** First positional — the command name, or null. */
  command: string | null;
  /** Remaining positionals. */
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that consume the next argv token (or `--flag=value`). */
const VALUE_FLAGS = new Set([
  'config',
  'workspace',
  'project',
  'path',
  'port',
  'bind',
  'ui-dist',
]);

const BOOLEAN_FLAGS = new Set(['json', 'no-project', 'help', 'version']);

const ALL_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

const SHORT: Record<string, string> = { h: 'help', v: 'version' };

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  let flagsDone = false;
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (flagsDone || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) inline = arg.slice(eq + 1);
    } else {
      if (arg.length !== 2) {
        throw new CliUsageError(`unknown flag '${arg}' (short flags: -h, -v)`);
      }
      name = SHORT[arg[1] as string] ?? arg[1] ?? '';
    }
    if (!ALL_FLAGS.has(name)) {
      throw new CliUsageError(`unknown flag '--${name}'`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) {
        throw new CliUsageError(`flag '--${name}' does not take a value`);
      }
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      throw new CliUsageError(`flag '--${name}' requires a value`);
    }
    flags[name] = value;
  }
  const [command, ...rest] = positional;
  return { command: command ?? null, positional: rest, flags };
}

/** Validate that `parsed` only carries flags this command accepts;
 *  throws CliUsageError (fail-closed on typos). */
export function assertFlags(
  parsed: ParsedArgs,
  allowed: readonly string[],
): void {
  const ok = new Set([...allowed, 'help']);
  for (const key of Object.keys(parsed.flags)) {
    if (!ok.has(key)) {
      throw new CliUsageError(
        `flag '--${key}' is not valid for '${parsed.command}'`,
      );
    }
  }
}

export function flagString(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const v = parsed.flags[name];
  return typeof v === 'string' ? v : undefined;
}
