#!/usr/bin/env node
/**
 * `sprint-runner` binary entry (wp-099). The whole surface lives in
 * runCli() so tests can drive it without spawning a child process;
 * this shim only maps the returned exit code.
 */
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2));
