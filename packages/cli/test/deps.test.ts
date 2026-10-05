import { describe, expect, it } from 'vitest';
import {
  type DepCheck,
  type ProbeRun,
  containerRuntimeFor,
  formatDepsReport,
  missingRequired,
  probeDeps,
} from '../src/deps.js';

/** Probe where every binary resolves + exits 0. */
const allOk: ProbeRun = (bin) => ({ ok: true, stdout: `${bin} 1.0.0` });

const finders = {
  devin: () => '/usr/local/bin/devin',
  aider: () => ({ bin: 'aider', prefixArgs: [], source: 'PATH' }),
};

function byName(checks: DepCheck[], name: string): DepCheck {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check '${name}'`);
  return c;
}

describe('probeDeps', () => {
  it('reports every dependency the ticket names', () => {
    const checks = probeDeps({
      backend: 'devin',
      run: allOk,
      finders,
    });
    for (const name of ['node', 'git', 'gitleaks', 'gh', 'docker', 'devin']) {
      expect(byName(checks, name).ok, name).toBe(true);
    }
    expect(missingRequired(checks)).toEqual([]);
  });

  it('a missing gitleaks is required while scan_on_commit is on', () => {
    const run: ProbeRun = (bin) =>
      bin === 'gitleaks' ? { ok: false, stdout: '' } : allOk(bin);
    const checks = probeDeps({ backend: 'devin', run, finders });
    expect(byName(checks, 'gitleaks').required).toBe(true);
    expect(missingRequired(checks).map((c) => c.name)).toContain('gitleaks');

    const off = probeDeps({
      backend: 'devin',
      scanOnCommit: false,
      run,
      finders,
    });
    expect(byName(off, 'gitleaks').required).toBe(false);
    expect(missingRequired(off)).toEqual([]);
  });

  it('the configured backend CLI is required, the other is not', () => {
    const run: ProbeRun = allOk;
    const checks = probeDeps({
      backend: 'aider',
      run,
      finders: {
        devin: finders.devin,
        aider: () => {
          throw new Error('no aider on PATH');
        },
      },
    });
    const aider = byName(checks, 'aider');
    expect(aider.ok).toBe(false);
    expect(aider.required).toBe(true);
    expect(byName(checks, 'devin').required).toBe(false);
    expect(missingRequired(checks).map((c) => c.name)).toEqual(['aider']);
  });

  it('docker daemon is required only for runtime: container', () => {
    // binary fine, daemon down
    const run: ProbeRun = (bin, args) => {
      if (bin === 'docker' && args[0] === 'info') {
        return { ok: false, stdout: '' };
      }
      return allOk(bin);
    };
    const container = probeDeps({
      backend: 'aider',
      containersRuntime: 'container',
      run,
      finders,
    });
    const d = byName(container, 'docker');
    expect(d.ok).toBe(false);
    expect(d.required).toBe(true);

    const proc = probeDeps({
      backend: 'devin',
      containersRuntime: 'process',
      run,
      finders,
    });
    expect(byName(proc, 'docker').required).toBe(false);
    expect(missingRequired(proc)).toEqual([]);
  });

  it('missing docker binary is optional under runtime: process', () => {
    const run: ProbeRun = (bin) =>
      bin === 'docker' ? { ok: false, stdout: '' } : allOk(bin);
    const checks = probeDeps({
      backend: 'devin',
      containersRuntime: 'process',
      run,
      finders,
    });
    expect(byName(checks, 'docker').required).toBe(false);
  });

  it('defaults aider to the container runtime (D30)', () => {
    const run: ProbeRun = (bin, args) => {
      if (bin === 'docker' && args[0] === 'info') {
        return { ok: false, stdout: '' };
      }
      return allOk(bin);
    };
    const checks = probeDeps({ backend: 'aider', run, finders });
    expect(byName(checks, 'docker').required).toBe(true);
  });
});

describe('containerRuntimeFor', () => {
  it('honors an explicit containers.runtime', () => {
    expect(
      containerRuntimeFor({
        backend: 'devin',
        containers: { runtime: 'container' },
      }),
    ).toBe('container');
    expect(
      containerRuntimeFor({
        backend: 'aider',
        containers: { runtime: 'process' },
      }),
    ).toBe('process');
  });

  it('falls back to the backend default (aider=container)', () => {
    expect(containerRuntimeFor({ backend: 'aider' })).toBe('container');
    expect(containerRuntimeFor({ backend: 'devin' })).toBe('process');
  });
});

describe('formatDepsReport', () => {
  it('renders names, states, and remediation', () => {
    const text = formatDepsReport([
      { name: 'git', ok: true, required: true, why: 'commits', version: '2.x' },
      {
        name: 'gitleaks',
        ok: false,
        required: true,
        why: 'sanitizer',
        remediation: 'brew install gitleaks',
      },
    ]);
    expect(text).toContain('git');
    expect(text).toContain('ok');
    expect(text).toContain('MISSING (required)');
    expect(text).toContain('brew install gitleaks');
  });
});
