import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

describe('runCli dispatch', () => {
  it('--version prints the version and exits 0', async () => {
    const { io, out } = capture();
    expect(await runCli(['--version'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/veto \d+\.\d+\.\d+/);
  });

  it('-v and `version` do the same', async () => {
    const a = capture();
    expect(await runCli(['-v'], a.io)).toBe(0);
    const b = capture();
    expect(await runCli(['version'], b.io)).toBe(0);
    expect(a.out[0]).toBe(b.out[0]);
  });

  it('help prints usage', async () => {
    const { io, out } = capture();
    expect(await runCli(['help'], io)).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(out.join('\n')).toContain('daemon');
  });

  it('unknown commands exit 2 with usage', async () => {
    const { io, err } = capture();
    expect(await runCli(['frobnicate'], io)).toBe(2);
    expect(err.join('\n')).toContain('frobnicate');
  });

  it('unknown flags exit 2', async () => {
    const { io, err } = capture();
    expect(await runCli(['status', '--bogus'], io)).toBe(2);
    expect(err.join('\n')).toContain('bogus');
  });

  it('per-command flag allow-list is enforced', async () => {
    const { io, err } = capture();
    // --json is not a daemon flag
    expect(await runCli(['daemon', '--json'], io)).toBe(2);
    expect(err.join('\n')).toContain('--json');
  });

  it('a missing/invalid config fails closed (exit 2) not a crash', async () => {
    const { io, err } = capture();
    const code = await runCli(
      ['status', '--config', '/nonexistent/dir/config.yaml'],
      io,
    );
    // actor missing → ConfigError → exit 2
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('actor');
  });
});
