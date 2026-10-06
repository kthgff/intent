#!/usr/bin/env node
/**
 * wp-040 E2E scripted agent — a superset of the shipped mock agent
 * (packages/adapters/src/mock/agent.mjs) used by the ScriptedAdapter
 * test helper. Spawned DETACHED by MockAdapter.run(); all behavior is
 * env-driven:
 *
 *   MOCK_SCENARIO     either a builtin DSL word —
 *                       done | hang | garbage-sentinel | no-sentinel
 *                     — or `script:<base64url>` carrying JSON:
 *                       {
 *                         sentinel?: string | null,   // last line, verbatim
 *                         artifacts?: {name: content}, // → MOCK_ARTIFACT_DIR
 *                         files?:    {abspath: content}, // absolute paths
 *                                                          // (ticket dir etc.)
 *                         hang?: boolean,             // never exits
 *                         delayMs?: number,           // work delay
 *                         waitFor?: string,           // poll for this file
 *                                                     // (bind-mounted
 *                                                     // worktree → the
 *                                                     // test releases
 *                                                     // the run on demand)
 *                         exit?: number,              // exit code
 *                       }
 *                     Content values may be strings (written verbatim)
 *                     or any JSON value (serialized pretty).
 *   MOCK_ARTIFACT_DIR directory artifacts are written into.
 *   MOCK_HEARTBEAT_MS heartbeat noise interval on stdout (default 100,
 *                     0 disables) — the conductor-observed heartbeat.
 *
 * MOCK_TIMEOUT_S is deliberately ignored: the conductor must do the
 * killing so the run_killed → retry path is exercised for real.
 * The LAST non-empty stdout line is the sentinel (CONDUCTOR contract).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const scenario = process.env.MOCK_SCENARIO || 'done';
const artifactDir = process.env.MOCK_ARTIFACT_DIR || '';
const heartbeatMs = Number(process.env.MOCK_HEARTBEAT_MS || 100);

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeTarget(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`,
  );
}
const writeArtifact = (name, content) =>
  artifactDir && writeTarget(artifactDir, name, content);
const writeFile = (abspath, content) =>
  writeTarget('/', abspath.replace(/^\//, ''), content);

if (heartbeatMs > 0) {
  const hb = setInterval(
    () => say(`HEARTBEAT ${new Date().toISOString()}`),
    heartbeatMs,
  );
  hb.unref();
}
process.on('SIGTERM', () => process.exit(143));

say(`MOCK scenario=${scenario.slice(0, 60)} pid=${process.pid}`);

let spec = {};
if (scenario.startsWith('script:')) {
  try {
    spec = JSON.parse(
      Buffer.from(scenario.slice(7), 'base64url').toString('utf8'),
    );
  } catch (err) {
    say(`BLOCKED: bad script payload: ${err.message}`);
    process.exit(2);
  }
} else {
  switch (scenario) {
    case 'done':
      spec = {
        sentinel: 'DONE',
        artifacts: { 'result.json': { scenario, status: 'done' } },
      };
      break;
    case 'hang':
      spec = { hang: true };
      break;
    case 'garbage-sentinel':
      spec = { sentinel: '?? this is not a sentinel at all !!' };
      break;
    case 'no-sentinel':
      spec = { sentinel: null };
      break;
    default:
      spec = {
        sentinel: `BLOCKED: unknown e2e mock scenario '${scenario}'`,
        exit: 2,
      };
  }
}

for (const [name, content] of Object.entries(spec.artifacts ?? {}))
  writeArtifact(name, content);
for (const [path, content] of Object.entries(spec.files ?? {}))
  writeFile(path, content);

await sleep(Number(spec.delayMs ?? 30));

if (typeof spec.waitFor === 'string' && spec.waitFor.length > 0) {
  // Poll for a host-written file — the bind mount is path-identical,
  // so the file the test drops in the worktree releases this run.
  while (!existsSync(spec.waitFor)) await sleep(50);
}

if (spec.hang === true) {
  // Never exits — the conductor's timeout sweep must kill us.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

if (typeof spec.sentinel === 'string' && spec.sentinel.length > 0)
  say(spec.sentinel);
process.exit(Number(spec.exit ?? 0));
