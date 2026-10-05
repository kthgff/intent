#!/usr/bin/env node
import { PROMPT_VERSION } from '@sprint-runner/core';

const USAGE = `sprint-runner — governance layer for agent-authored code

Usage: sprint-runner <command>

Commands:
  init        Create ~/.config/sprint-runner config + .env scaffolding
  daemon      Run the conductor loop (same loop the app embeds)
  tick        Run a single conductor reconcile/claim/launch pass
  status      Print ticket + live-run summary for a workspace
  version     Print version

Flags: --config <path>  override global config path
`;

const cmd = process.argv[2];

switch (cmd) {
  case 'version':
  case '--version':
  case '-v':
    console.log(`sprint-runner 0.0.1 (prompts v${PROMPT_VERSION})`);
    break;
  case 'init':
  case 'daemon':
  case 'tick':
  case 'status':
    console.error(`${cmd}: not yet implemented (see docs/exec/ wave plan)`);
    process.exit(2);
    break;
  default:
    process.stdout.write(USAGE);
    process.exit(
      cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2,
    );
}
