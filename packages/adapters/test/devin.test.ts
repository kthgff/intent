import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderedPrompt } from '@veto/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DevinAdapter,
  DevinBinaryNotFoundError,
  findDevinBinary,
  mapPermissionMode,
  parseSentinel,
} from '../src/devin/index.js';

/**
 * Fake `devin` binary — logs argv (one per line) to $FAKE_ARGV, copies
 * $FAKE_EXPORT_SRC to the --export path, prints noise then the $FAKE_LAST
 * sentinel line, exits $FAKE_EXIT (default 0). Real child process on PATH.
 */
const FAKE_SCRIPT = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_ARGV"
exp=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--export" ]; then exp="$a"; fi
  prev="$a"
done
if [ -n "$exp" ] && [ -n "\${FAKE_EXPORT_SRC:-}" ]; then
  cp "$FAKE_EXPORT_SRC" "$exp"
fi
echo "agent noise line"
echo "more noise"
if [ -n "\${FAKE_LAST:-}" ]; then echo "$FAKE_LAST"; fi
exit "\${FAKE_EXIT:-0}"
`;

let root: string;
let binDir: string;
let runDir: string;
let savedEnv: NodeJS.ProcessEnv;

const rendered: RenderedPrompt = {
  template: 'implement',
  text: 'PROMPT BODY — do the thing\n',
  tokens: {},
};

function makeFakeDevin(): string {
  const p = join(binDir, 'devin');
  writeFileSync(p, FAKE_SCRIPT);
  chmodSync(p, 0o755);
  return p;
}

function argvLog(): string[] {
  return readFileSync(join(root, 'argv.txt'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

function collectCtx() {
  return {
    workspace: root,
    run_dir: runDir,
    run_id: '001-implement',
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp022-'));
  binDir = join(root, 'bin');
  runDir = join(root, 'run');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  savedEnv = { ...process.env };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.FAKE_ARGV = join(root, 'argv.txt');
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('findDevinBinary', () => {
  const noPath = () => false;

  it('returns "devin" when on PATH', () => {
    expect(findDevinBinary({ env: {}, onPath: () => true })).toBe('devin');
  });

  it('falls back to DEVIN_BIN', () => {
    const bin = makeFakeDevin();
    expect(findDevinBinary({ env: { DEVIN_BIN: bin }, onPath: noPath })).toBe(
      bin,
    );
  });

  it('falls back to the Devin.app bundle path', () => {
    const bundle = join(root, 'bundle-devin');
    writeFileSync(bundle, '#!/bin/sh\n');
    chmodSync(bundle, 0o755);
    expect(
      findDevinBinary({ env: {}, onPath: noPath, appBundlePath: bundle }),
    ).toBe(bundle);
  });

  it('skips a non-executable DEVIN_BIN and uses the bundle', () => {
    const bad = join(root, 'not-there');
    const bundle = join(root, 'bundle-devin');
    writeFileSync(bundle, '#!/bin/sh\n');
    chmodSync(bundle, 0o755);
    expect(
      findDevinBinary({
        env: { DEVIN_BIN: bad },
        onPath: noPath,
        appBundlePath: bundle,
      }),
    ).toBe(bundle);
  });

  it('throws DevinBinaryNotFoundError when nothing resolves', () => {
    expect(() =>
      findDevinBinary({
        env: {},
        onPath: noPath,
        appBundlePath: join(root, 'nope'),
      }),
    ).toThrow(DevinBinaryNotFoundError);
  });
});

describe('mapPermissionMode', () => {
  it('maps config modes', () => {
    expect(mapPermissionMode('smart')).toBe('smart');
    expect(mapPermissionMode('bypass')).toBe('dangerous');
    expect(mapPermissionMode('accept-edits')).toBe('accept-edits');
  });

  it('passes through real devin modes', () => {
    expect(mapPermissionMode('auto')).toBe('auto');
    expect(mapPermissionMode('dangerous')).toBe('dangerous');
  });

  it('errors on unknown modes', () => {
    expect(() => mapPermissionMode('yolo')).toThrow(/permission_mode/);
  });
});

describe('DevinAdapter.run + collect', () => {
  it('assembles the documented command line and writes prompt.md', async () => {
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'DONE';
    const adapter = new DevinAdapter({
      binary: bin,
      permissionMode: 'bypass',
      model: 'opus',
    });
    const handle = adapter.run(root, rendered, 60, runDir);
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.log_path).toBe(join(runDir, 'devin.log'));

    const result = await adapter.collect(handle, collectCtx());
    const args = argvLog();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe('-p');
    expect(flag('--prompt-file')).toBe(join(runDir, 'prompt.md'));
    expect(flag('--permission-mode')).toBe('dangerous');
    expect(flag('--export')).toBe(join(runDir, 'export.json'));
    expect(flag('--respect-workspace-trust')).toBe('false');
    expect(flag('--model')).toBe('opus');
    expect(readFileSync(join(runDir, 'prompt.md'), 'utf8')).toBe(rendered.text);
    expect(result.sentinel).toBe('DONE');
    expect(result.exit_code).toBe(0);
  });

  it('omits --model when unset', async () => {
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'READY';
    const adapter = new DevinAdapter({ binary: bin });
    const handle = adapter.run(root, rendered, 60, runDir);
    await adapter.collect(handle, collectCtx());
    expect(argvLog()).not.toContain('--model');
  });

  it('parses the LAST non-empty line as sentinel; unknown → null', async () => {
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'NEEDS-INFO: 3';
    const adapter = new DevinAdapter({ binary: bin });
    const handle = adapter.run(root, rendered, 60, runDir);
    const result = await adapter.collect(handle, collectCtx());
    expect(result.sentinel).toBe('NEEDS-INFO');
    expect(result.sentinel_raw).toBe('NEEDS-INFO: 3');
  });

  it('returns null sentinel for an unrecognized last line', async () => {
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'I am confused';
    const adapter = new DevinAdapter({ binary: bin });
    const handle = adapter.run(root, rendered, 60, runDir);
    const result = await adapter.collect(handle, collectCtx());
    expect(result.sentinel).toBeNull();
    expect(result.sentinel_raw).toBe('I am confused');
  });

  it('extracts usage from export.json → run-aggregate, cost_usd null', async () => {
    const fixture = join(root, 'export-fixture.json');
    writeFileSync(
      fixture,
      JSON.stringify({
        model: 'claude-sonnet-4',
        duration_s: 42,
        usage: {
          input_tokens: 12000,
          output_tokens: 800,
          cache_read_input_tokens: 5000,
        },
        messages: [],
      }),
    );
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'DONE';
    process.env.FAKE_EXPORT_SRC = fixture;
    const adapter = new DevinAdapter({ binary: bin, ticket: 'T-1' });
    const handle = adapter.run(root, rendered, 60, runDir);
    const result = await adapter.collect(handle, collectCtx());

    const u = result.usage;
    expect(u).not.toBeNull();
    if (u === null) throw new Error('usage null');
    expect(u.schema).toBe(1);
    expect(u.backend).toBe('devin');
    expect(u.run).toBe('001-implement');
    expect(u.ticket).toBe('T-1');
    expect(u.granularity).toBe('run-aggregate');
    expect(u.source).toBe('reported');
    expect(u.totals).toMatchObject({
      tokens_in: 12000,
      tokens_out: 800,
      tokens_cached: 5000,
      cost_usd: null,
      duration_s: 42,
    });
    expect(u.calls).toHaveLength(1);
    expect(u.calls[0]).toMatchObject({
      seq: 1,
      tokens_in: 12000,
      source: 'reported',
    });
    expect(existsSync(join(runDir, 'usage.json'))).toBe(true);
  });

  it('sums per-message usage when present', async () => {
    const fixture = join(root, 'export-fixture.json');
    writeFileSync(
      fixture,
      JSON.stringify({
        messages: [
          { usage: { tokens_in: 100, tokens_out: 10 } },
          { usage: { tokens_in: 200, tokens_out: 20 } },
        ],
      }),
    );
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'DONE';
    process.env.FAKE_EXPORT_SRC = fixture;
    const adapter = new DevinAdapter({ binary: bin });
    const handle = adapter.run(root, rendered, 60, runDir);
    const result = await adapter.collect(handle, collectCtx());
    expect(result.usage?.totals.tokens_in).toBe(300);
    expect(result.usage?.totals.tokens_out).toBe(30);
    expect(result.usage?.source).toBe('reported');
  });

  it('falls back to estimated when the export has no usage', async () => {
    const bin = makeFakeDevin();
    process.env.FAKE_LAST = 'DONE';
    const adapter = new DevinAdapter({ binary: bin });
    const handle = adapter.run(root, rendered, 60, runDir);
    const result = await adapter.collect(handle, collectCtx());
    const u = result.usage;
    if (u === null) throw new Error('usage null');
    expect(u.source).toBe('estimated');
    expect(u.granularity).toBe('run-aggregate');
    expect(u.totals.cost_usd).toBeNull();
    expect(u.totals.tokens_in).toBeGreaterThan(0); // prompt.md rendered
  });

  it('collect() without a tracked child → exit_code null', async () => {
    const adapter = new DevinAdapter({ binary: '/bin/true' });
    writeFileSync(join(runDir, 'devin.log'), 'noise\nDONE\n');
    const result = await adapter.collect(
      { pid: 999999, log_path: join(runDir, 'devin.log') },
      collectCtx(),
    );
    expect(result.sentinel).toBe('DONE');
    expect(result.exit_code).toBeNull();
  });
});

describe('DevinAdapter.control', () => {
  it('pause/resume/kill signal the child', async () => {
    const sleeper = join(binDir, 'devin');
    writeFileSync(sleeper, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(sleeper, 0o755);
    const adapter = new DevinAdapter({ binary: sleeper, killGraceMs: 50 });
    const handle = adapter.run(root, rendered, 0, runDir);
    await adapter.control(handle, 'pause');
    await adapter.control(handle, 'resume');
    await adapter.control(handle, 'kill');
    const result = await adapter.collect(handle, collectCtx());
    expect(result.exit_code).not.toBe(0);
  });
});

describe('parseSentinel', () => {
  it('handles missing log', () => {
    expect(parseSentinel(join(root, 'none.log'))).toEqual({
      sentinel: null,
      sentinel_raw: null,
    });
  });
});
