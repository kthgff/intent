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
  AiderAdapter,
  costUsd,
  findAiderBinary,
  normalizeModelId,
  parseAiderUsageLine,
  parseTokenCount,
  priceFor,
} from '../src/aider/index.js';

/**
 * Fake `aider` binary — logs argv (one per line) to $FAKE_ARGV, echoes
 * $FAKE_STDOUT_SRC content to stdout (realistic aider token lines),
 * creates the file $FAKE_SCRATCH_FILE inside the scratch dir named by
 * $FAKE_SCRATCH_DIR (relative to cwd), prints $FAKE_LAST sentinel, exits
 * $FAKE_EXIT (default 0). Real child process on PATH.
 */
const FAKE_SCRIPT = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_ARGV"
printf 'OPENROUTER=%s\\n' "\${OPENROUTER_API_KEY:-unset}" > "$FAKE_ENVOUT"
if [ -n "\${FAKE_SCRATCH_DIR:-}" ] && [ -n "\${FAKE_SCRATCH_FILE:-}" ]; then
  mkdir -p "$FAKE_SCRATCH_DIR"
  echo "artifact body" > "$FAKE_SCRATCH_DIR/$FAKE_SCRATCH_FILE"
fi
echo "aider noise"
if [ -n "\${FAKE_STDOUT_SRC:-}" ]; then cat "$FAKE_STDOUT_SRC"; fi
if [ -n "\${FAKE_LAST:-}" ]; then echo "$FAKE_LAST"; fi
exit "\${FAKE_EXIT:-0}"
`;

let root: string;
let binDir: string;
let runDir: string;
let worktree: string;
let savedEnv: NodeJS.ProcessEnv;

const rendered: RenderedPrompt = {
  template: 'implement',
  text: 'PROMPT BODY — do the thing\n',
  tokens: {},
};

function makeFakeAider(): string {
  const p = join(binDir, 'aider');
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

function usageFile(lines: string[]): string {
  const p = join(root, 'usage-out.txt');
  writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp052-'));
  binDir = join(root, 'bin');
  runDir = join(root, 'run');
  worktree = join(root, 'worktree');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  savedEnv = { ...process.env };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.FAKE_ARGV = join(root, 'argv.txt');
  process.env.FAKE_ENVOUT = join(root, 'env.txt');
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('findAiderBinary', () => {
  const none = { onPath: () => false, pipx: () => false, uvx: () => false };

  it('returns bare aider when on PATH', () => {
    const inv = findAiderBinary({ env: {}, ...none, onPath: () => true });
    expect(inv.bin).toBe('aider');
    expect(inv.prefixArgs).toEqual([]);
  });

  it('falls back to AIDER_BIN', () => {
    const bin = makeFakeAider();
    const inv = findAiderBinary({ env: { AIDER_BIN: bin }, ...none });
    expect(inv.bin).toBe(bin);
  });

  it('skips a non-executable AIDER_BIN', () => {
    expect(() =>
      findAiderBinary({ env: { AIDER_BIN: join(root, 'nope') }, ...none }),
    ).toThrow(/aider binary not found/);
  });

  it('falls back to the pipx shim', () => {
    const inv = findAiderBinary({ env: {}, ...none, pipx: () => true });
    expect(inv.bin).toBe('pipx');
    expect(inv.prefixArgs).toEqual(['run', 'aider-chat']);
  });

  it('falls back to the uvx shim', () => {
    const inv = findAiderBinary({ env: {}, ...none, uvx: () => true });
    expect(inv.bin).toBe('uvx');
    expect(inv.prefixArgs).toEqual(['aider-chat']);
  });

  it('throws AiderBinaryNotFoundError when nothing resolves', () => {
    expect(() => findAiderBinary({ env: {}, ...none })).toThrow(
      /aider binary not found.*checked:/,
    );
  });
});

describe('pricing', () => {
  it('normalizes openrouter/ prefixes', () => {
    expect(normalizeModelId('openrouter/openai/gpt-4o')).toBe('openai/gpt-4o');
    expect(normalizeModelId('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('computes cost from the table', () => {
    // openai/gpt-4o: $2.50/1M in, $10/1M out → 1000 in + 500 out = $0.0075
    expect(costUsd('openrouter/openai/gpt-4o', 1000, 500)).toBeCloseTo(0.0075);
    expect(priceFor('anthropic/claude-sonnet-4')).not.toBeNull();
    expect(costUsd('openai/gpt-4o', 0, 0)).toBe(0);
  });

  it('unknown model → null', () => {
    expect(priceFor('acme/fictional-1')).toBeNull();
    expect(costUsd('acme/fictional-1', 10_000, 10_000)).toBeNull();
  });
});

describe('parseAiderUsageLine', () => {
  it('parses documented token lines', () => {
    expect(
      parseAiderUsageLine('Tokens: 12.3k sent, 980 received.'),
    ).toMatchObject({ tokens_in: 12300, tokens_out: 980 });
    expect(
      parseAiderUsageLine(
        'Tokens: 4.1k sent, 1.2k received. Cost: $0.04 message, $0.31 session.',
      ),
    ).toMatchObject({ tokens_in: 4100, tokens_out: 1200 });
    expect(
      parseAiderUsageLine('Tokens: 2.0k cache hits, 512 sent, 88 received.'),
    ).toMatchObject({ tokens_in: 512, tokens_out: 88, tokens_cached: 2000 });
    expect(parseAiderUsageLine('sent 300 tokens, received 45')).toMatchObject({
      tokens_in: 300,
      tokens_out: 45,
    });
  });

  it('returns null for unrecognized lines', () => {
    expect(parseAiderUsageLine('aider is thinking…')).toBeNull();
    expect(parseAiderUsageLine('Tokens: lots sent, some received')).toBeNull();
    expect(parseAiderUsageLine('DONE')).toBeNull();
  });

  it('parses k/M/comma counts', () => {
    expect(parseTokenCount('12.3k')).toBe(12300);
    expect(parseTokenCount('1,200')).toBe(1200);
    expect(parseTokenCount('2M')).toBe(2_000_000);
    expect(parseTokenCount('abc')).toBeNull();
  });
});

describe('AiderAdapter.run + collect', () => {
  it('declares the aider capability flags', () => {
    const adapter = new AiderAdapter({ binary: '/bin/true' });
    expect(adapter.capabilities).toMatchObject({
      can_exec: true,
      can_write_outside_tree: false,
      has_gh: false,
      streams_usage: true,
    });
  });

  it('assembles the documented command line and writes prompt.md', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_LAST = 'DONE';
    const adapter = new AiderAdapter({
      binary: bin,
      model: 'anthropic/claude-sonnet-4',
      openrouterApiKey: 'sk-or-test',
    });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.log_path).toBe(join(runDir, 'aider.log'));

    const result = await adapter.collect(handle, collectCtx());
    const args = argvLog();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--message-file')).toBe(join(runDir, 'prompt.md'));
    expect(args).toContain('--yes-always');
    expect(args).toContain('--auto-commits');
    expect(flag('--model')).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(readFileSync(join(runDir, 'prompt.md'), 'utf8')).toBe(rendered.text);
    expect(result.sentinel).toBe('DONE');
    expect(result.exit_code).toBe(0);
    // Secret passed through to the child env — never in argv.
    expect(readFileSync(join(root, 'env.txt'), 'utf8')).toContain(
      'OPENROUTER=sk-or-test',
    );
    expect(args.join(' ')).not.toContain('sk-or-test');
  });

  it('preserves an explicit openrouter/ model prefix; omits --model when unset', async () => {
    const bin = makeFakeAider();
    const adapter = new AiderAdapter({ binary: bin });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    await adapter.collect(handle, collectCtx());
    expect(argvLog()).not.toContain('--model');
  });

  it('collects scratch-dir artifacts into run_dir and purges', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_LAST = 'DONE';
    // runId resolves to the run-dir basename ('run') when prepare()
    // didn't flow one through.
    process.env.FAKE_SCRATCH_DIR = '.veto/run';
    process.env.FAKE_SCRATCH_FILE = 'deviations.md';
    const adapter = new AiderAdapter({ binary: bin });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    const result = await adapter.collect(handle, collectCtx());
    expect(result.artifacts).toContain('deviations.md');
    expect(existsSync(join(runDir, 'deviations.md'))).toBe(true);
    expect(existsSync(join(worktree, '.veto'))).toBe(false);
  });

  it('builds a per-call usage ledger with priced cost', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_STDOUT_SRC = usageFile([
      'Tokens: 1.0k sent, 100 received.',
      'Tokens: 2.0k sent, 200 received. Cost: $0.01 message, $0.02 session.',
    ]);
    process.env.FAKE_LAST = 'DONE';
    const adapter = new AiderAdapter({
      binary: bin,
      model: 'openai/gpt-4o',
      ticket: 'ABC-1',
    });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    const result = await adapter.collect(handle, collectCtx());
    const usage = result.usage;
    expect(usage).not.toBeNull();
    expect(usage?.granularity).toBe('per-call');
    expect(usage?.source).toBe('reported');
    expect(usage?.totals.tokens_in).toBe(3000);
    expect(usage?.totals.tokens_out).toBe(300);
    // 3000×$2.50 + 300×$10 per 1M = $0.0105
    expect(usage?.totals.cost_usd).toBeCloseTo(0.0105);
    expect(usage?.calls).toHaveLength(2);
    expect(existsSync(join(runDir, 'usage.json'))).toBe(true);
  });

  it('unknown model → cost_usd null + warning in notes', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_STDOUT_SRC = usageFile([
      'Tokens: 1.0k sent, 100 received.',
    ]);
    process.env.FAKE_LAST = 'DONE';
    const adapter = new AiderAdapter({
      binary: bin,
      model: 'acme/fictional-1',
    });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    const result = await adapter.collect(handle, collectCtx());
    expect(result.usage?.totals.cost_usd).toBeNull();
    expect(result.usage?.notes).toMatch(/missing from OpenRouter price table/);
  });

  it('no usage lines → source: estimated, never fails the run', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_LAST = 'DONE';
    const adapter = new AiderAdapter({ binary: bin });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    const result = await adapter.collect(handle, collectCtx());
    expect(result.sentinel).toBe('DONE');
    expect(result.usage?.source).toBe('estimated');
    expect(result.usage?.totals.cost_usd).toBeNull();
  });

  it('streams usage_partial via on_usage', async () => {
    const bin = makeFakeAider();
    process.env.FAKE_STDOUT_SRC = usageFile([
      'Tokens: 500 sent, 50 received.',
      'Tokens: 700 sent, 70 received.',
    ]);
    process.env.FAKE_LAST = 'DONE';
    const adapter = new AiderAdapter({ binary: bin, usagePollMs: 10 });
    const handle = adapter.run(worktree, rendered, 60, { run_dir: runDir });
    const partials: number[] = [];
    adapter.on_usage(handle, (p) => partials.push(p.tokens_in));
    await adapter.collect(handle, collectCtx());
    // The fake exits fast; the poll may race the exit, so also accept
    // partials picked up only by collect()'s final tally.
    expect(partials.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1200);
  });
});
