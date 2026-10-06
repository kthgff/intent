#!/usr/bin/env node
/**
 * veto mock agent — the scripted backend child process (wp-021).
 *
 * Pure Node, no dependencies; spawned DETACHED by MockAdapter.run() as
 *   node agent.mjs
 * All behavior is driven by env vars:
 *
 *   MOCK_SCENARIO     scenario DSL (see src/mock/README.md):
 *                       done
 *                       blocked:<reason>
 *                       needs-info:<n>
 *                       garbage-sentinel
 *                       no-sentinel
 *                       hang                  never exits (kill tests)
 *                       fail-lint             writes malformed artifact
 *                       usage                 emits USAGE lines + total
 *                       artifacts:<json>      {"path": "content"} map
 *   MOCK_ARTIFACT_DIR directory to write artifacts into (ARTIFACT_TARGETS).
 *   MOCK_DELAY_MS     work delay before printing the sentinel (default 50).
 *   MOCK_HEARTBEAT_MS interval for `HEARTBEAT <iso>` noise lines on stdout —
 *                     the log mtime is the conductor-observed heartbeat
 *                     (default 100; 0 disables).
 *   MOCK_TIMEOUT_S    self-imposed timeout → exit 124, no sentinel (0 = off).
 *   MOCK_IGNORE_TERM  when '1', SIGTERM is ignored (tests SIGKILL escalation).
 *
 * Usage stream format (parsed by MockAdapter.collect/on_usage):
 *   USAGE {"tokens_in":n,"tokens_out":n,"tokens_cached":n}
 *   USAGE_TOTAL {"tokens_in":n,"tokens_out":n,"tokens_cached":n,"cost_usd":n|null}
 *
 * The LAST non-empty stdout line is the sentinel (CONDUCTOR contract).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const scenario = process.env.MOCK_SCENARIO || 'done';
const artifactDir = process.env.MOCK_ARTIFACT_DIR || '';
const delayMs = Number(process.env.MOCK_DELAY_MS || 50);
const heartbeatMs = Number(process.env.MOCK_HEARTBEAT_MS || 100);
const timeoutS = Number(process.env.MOCK_TIMEOUT_S || 0);

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = (i, o, c) =>
  say(
    `USAGE ${JSON.stringify({ tokens_in: i, tokens_out: o, tokens_cached: c })}`,
  );

function writeArtifact(name, content) {
  if (!artifactDir) return;
  const path = join(artifactDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Heartbeat noise — keeps the log mtime ticking (CONDUCTOR heartbeats are
// conductor-observed via pid liveness + log/artifact mtime).
if (heartbeatMs > 0) {
  const hb = setInterval(
    () => say(`HEARTBEAT ${new Date().toISOString()}`),
    heartbeatMs,
  );
  hb.unref();
}

if (process.env.MOCK_IGNORE_TERM !== '1') {
  process.on('SIGTERM', () => process.exit(143));
}

const sep = scenario.indexOf(':');
const kind = sep === -1 ? scenario : scenario.slice(0, sep);
const arg = sep === -1 ? '' : scenario.slice(sep + 1);

// hang never exits — the adapter/conductor must kill it.
if (kind === 'hang') {
  say(`MOCK scenario=hang pid=${process.pid}`);
  setInterval(() => {}, 60_000);
  if (timeoutS !== 0) {
    setTimeout(() => process.exit(124), timeoutS * 1000).unref();
  }
  // Forever — setTimeout clamps delays >24.8d to ~1ms, so never await a
  // giant sleep here (that falls through to the switch → exit 2).
  await new Promise(() => {});
}

// Optional self-timeout for timeout-path tests (exit code 124, no sentinel).
if (timeoutS > 0) {
  setTimeout(() => process.exit(124), timeoutS * 1000).unref();
}

say(`MOCK scenario=${scenario} pid=${process.pid}`);

const DEFAULT_ARTIFACT = { 'result.json': { scenario, status: 'done' } };

async function writeArtifacts(map) {
  for (const [name, content] of Object.entries(map)) {
    writeArtifact(
      name,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
}

switch (kind) {
  case 'done':
    await writeArtifacts(DEFAULT_ARTIFACT);
    await sleep(delayMs);
    say('DONE');
    break;

  case 'blocked':
    await writeArtifacts({
      'result.json': { scenario, status: 'blocked', reason: arg },
    });
    await sleep(delayMs);
    say(`BLOCKED: ${arg}`);
    break;

  case 'needs-info':
    await writeArtifacts({
      'result.json': { scenario, status: 'needs-info', questions: Number(arg) },
    });
    await sleep(delayMs);
    say(`NEEDS-INFO: ${arg}`);
    break;

  case 'garbage-sentinel':
    await sleep(delayMs);
    say('?? this is not a sentinel at all !!');
    break;

  case 'no-sentinel':
    await sleep(delayMs);
    // last heartbeat noise line is malformed as a sentinel → detected missing
    process.exit(0);
    break;

  case 'fail-lint':
    writeArtifact('review.json', '{ this is not valid json ');
    await sleep(delayMs);
    say('DONE');
    break;

  case 'usage': {
    await writeArtifacts(DEFAULT_ARTIFACT);
    usage(100, 20, 0);
    await sleep(Math.max(delayMs / 2, 1));
    usage(150, 30, 50);
    await sleep(Math.max(delayMs / 2, 1));
    say(
      `USAGE_TOTAL ${JSON.stringify({ tokens_in: 250, tokens_out: 50, tokens_cached: 50, cost_usd: null })}`,
    );
    say('DONE');
    break;
  }

  case 'artifacts': {
    let map;
    try {
      map = JSON.parse(arg);
    } catch (err) {
      say(`BLOCKED: bad artifacts json: ${err.message}`);
      process.exit(2);
    }
    await writeArtifacts(map);
    await sleep(delayMs);
    say('DONE');
    break;
  }

  default:
    say(`BLOCKED: unknown mock scenario '${scenario}'`);
    process.exit(2);
}

process.exit(0);
