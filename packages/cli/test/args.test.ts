import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  assertFlags,
  flagString,
  parseArgs,
} from '../src/args.js';

describe('parseArgs', () => {
  it('parses a bare invocation as command=null', () => {
    const p = parseArgs([]);
    expect(p.command).toBeNull();
    expect(p.positional).toEqual([]);
    expect(p.flags).toEqual({});
  });

  it('parses a command', () => {
    expect(parseArgs(['init']).command).toBe('init');
    expect(parseArgs(['status']).command).toBe('status');
  });

  it('parses --flag value and --flag=value', () => {
    const a = parseArgs(['init', '--config', '/tmp/x.yaml']);
    expect(a.flags.config).toBe('/tmp/x.yaml');
    const b = parseArgs(['init', '--config=/tmp/y.yaml']);
    expect(b.flags.config).toBe('/tmp/y.yaml');
  });

  it('parses boolean flags', () => {
    const p = parseArgs(['status', '--json']);
    expect(p.flags.json).toBe(true);
  });

  it('keeps positionals after the command', () => {
    const p = parseArgs(['init', 'myproj', '--config', '/x']);
    expect(p.command).toBe('init');
    expect(p.positional).toEqual(['myproj']);
    expect(flagString(p, 'config')).toBe('/x');
  });

  it('maps -h/-v to help/version', () => {
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['-v']).flags.version).toBe(true);
  });

  it('fails closed on unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(CliUsageError);
    expect(() => parseArgs(['-x'])).toThrow(CliUsageError);
    expect(() => parseArgs(['status', '--bogus'])).toThrow(CliUsageError);
  });

  it('fails closed when a value flag has no value', () => {
    expect(() => parseArgs(['status', '--config'])).toThrow(CliUsageError);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['status', '--json=x'])).toThrow(CliUsageError);
  });

  it('honors -- as end-of-flags', () => {
    const p = parseArgs(['init', '--', '--json']);
    expect(p.positional).toEqual(['--json']);
    expect(p.flags.json).toBeUndefined();
  });
});

describe('assertFlags', () => {
  it('accepts allowed flags + help', () => {
    const p = parseArgs(['status', '--json', '--workspace', 'w']);
    expect(() => assertFlags(p, ['json', 'workspace'])).not.toThrow();
    expect(() =>
      assertFlags(parseArgs(['status', '--help']), ['json']),
    ).not.toThrow();
  });

  it('rejects flags the command does not know', () => {
    const p = parseArgs(['status', '--port', '5']);
    expect(() => assertFlags(p, ['json'])).toThrow(CliUsageError);
  });
});
