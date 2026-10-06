/**
 * cli.ts — command dispatch for the `veto` binary (wp-099).
 *
 * Command table (ticket):
 *   (no args) / daemon  boot config + store → conductor loop → UI+API
 *   init                scaffold config dir + dep report + register project
 *   tick                single reconcile/claim pass (debug; nonzero on errors)
 *   status              queue snapshot — gates, live runs, containers (--json)
 *   doctor              dep detection report (docker respects containers.runtime)
 *   --version / version print version
 *
 * `runCli` returns the exit code — bin.ts maps it to process.exitCode.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '@veto/config';
import { PROMPT_VERSION } from '@veto/core';
import { CliUsageError, assertFlags, flagString, parseArgs } from './args.js';
import { cmdDaemon } from './commands/daemon.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdInit } from './commands/init.js';
import { cmdStatus } from './commands/status.js';
import { cmdTick } from './commands/tick.js';

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
}

const defaultIo: CliIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

function version(): string {
  // Read our own package.json — works from src/ (vitest) and dist/.
  try {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const USAGE = `veto — governance layer for agent-authored code

Usage: veto <command>

Commands:
  (none)/daemon  Boot the conductor + serve the UI on ui.bind:ui.port
  init           Scaffold config dir, detect deps, register a project
  tick           Single reconcile/claim/launch pass (debug surface)
  status         Queue snapshot: gates, live runs, containers
  doctor         Dependency detection report
  version        Print version

Flags:
  --config <path>     override ~/.config/veto/config.yaml
  --workspace <name>  scope status to one workspace
  --json              machine-readable output (status, doctor)
  --project <name>    project name for init (default: repo basename)
  --path <dir>        repo dir for init (default: cwd)
  --no-project        init: scaffold only, skip registration
  --port <n>          daemon: override ui.port
  --bind <addr>       daemon: override ui.bind
  --ui-dist <dir>     daemon: override the built UI bundle path
  -h/--help, -v/--version
`;

/** Per-command flag allow-lists — unknown flags fail closed (exit 2). */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ['config', 'project', 'path', 'no-project'],
  daemon: ['config', 'port', 'bind', 'ui-dist'],
  tick: ['config'],
  status: ['config', 'workspace', 'json'],
  doctor: ['config', 'json'],
};

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.err(`usage: ${e.message}`);
      process.stderr.write(USAGE);
      return 2;
    }
    throw e;
  }

  const { command, flags, positional } = parsed;

  // Bare invocations / help / version — resolved before dispatch.
  // `--version`/`-v`/`version` and `--help`/`-h`/`help` all work.
  if (flags.version === true) {
    io.out(versionLine());
    return 0;
  }
  if (command === 'help' || flags.help === true) {
    io.out(USAGE);
    return 0;
  }
  if (command === null) {
    // no args → daemon (the ticket's bare `veto` command)
    return cmdDaemon({ io });
  }

  const command_ = command;
  const configPath = flagString(parsed, 'config');

  try {
    switch (command_) {
      case 'version':
        io.out(versionLine());
        return 0;
      case 'init': {
        assertFlags(parsed, COMMAND_FLAGS.init ?? []);
        if (positional.length > 1) {
          throw new CliUsageError(
            `init takes at most one positional (project name), got ${positional.length}`,
          );
        }
        const projectFlag = flagString(parsed, 'project');
        const pathFlag = flagString(parsed, 'path');
        return await cmdInit({
          ...(configPath ? { configPath } : {}),
          ...(projectFlag !== undefined ? { project: projectFlag } : {}),
          ...(pathFlag !== undefined ? { path: pathFlag } : {}),
          noProject: flags['no-project'] === true,
          io,
          ...(positional[0] !== undefined ? { project: positional[0] } : {}),
        });
      }
      case 'daemon': {
        assertFlags(parsed, COMMAND_FLAGS.daemon ?? []);
        const port = flagString(parsed, 'port');
        if (port !== undefined) {
          const n = Number(port);
          if (!Number.isInteger(n) || n < 0 || n > 65535) {
            throw new CliUsageError(`--port must be 0-65535, got '${port}'`);
          }
        }
        const bindFlag = flagString(parsed, 'bind');
        const uiDistFlag = flagString(parsed, 'ui-dist');
        return await cmdDaemon({
          ...(configPath ? { configPath } : {}),
          ...(port !== undefined ? { port: Number(port) } : {}),
          ...(bindFlag !== undefined ? { bind: bindFlag } : {}),
          ...(uiDistFlag !== undefined ? { uiDist: uiDistFlag } : {}),
          io,
        });
      }
      case 'tick': {
        assertFlags(parsed, COMMAND_FLAGS.tick ?? []);
        return await cmdTick({
          ...(configPath ? { configPath } : {}),
          io,
        });
      }
      case 'status': {
        assertFlags(parsed, COMMAND_FLAGS.status ?? []);
        const workspaceFlag = flagString(parsed, 'workspace');
        return await cmdStatus({
          ...(configPath ? { configPath } : {}),
          ...(workspaceFlag !== undefined ? { workspace: workspaceFlag } : {}),
          json: flags.json === true,
          io,
        });
      }
      case 'doctor': {
        assertFlags(parsed, COMMAND_FLAGS.doctor ?? []);
        return await cmdDoctor({
          ...(configPath ? { configPath } : {}),
          json: flags.json === true,
          io,
        });
      }
      default:
        io.err(`unknown command '${command_}'`);
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.err(`usage: ${e.message}`);
      return 2;
    }
    if (e instanceof ConfigError) {
      io.err(`config: ${e.message}`);
      return 2;
    }
    io.err(`${command_}: ${(e as Error).message}`);
    return 1;
  }
}

function versionLine(): string {
  return `veto ${version()} (prompts v${PROMPT_VERSION})`;
}
