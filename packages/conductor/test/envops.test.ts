import { execFileSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestReportSchema } from '@sprint-runner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectArtifacts,
  findScanner,
  runVerifyTask,
  scanArtifacts,
  scanForCommit,
  scratchPath,
} from '../src/envops/index.js';

let root: string;

const FIXTURE_REPO = fileURLToPath(
  new URL('../../../fixtures/code-repo', import.meta.url),
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
}

/** A fake `gitleaks` honoring `dir <path> --report-format json
 *  --report-path <file>`: exit 1 + findings JSON when a file contains
 *  the marker `AKIA` (fake AWS key), else exit 0 + `[]`. */
async function writeMockGitleaks(dir: string): Promise<string> {
  const script = join(dir, 'gitleaks');
  await writeFile(
    script,
    `#!/bin/sh
report=""
target=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--report-path" ]; then report="$a"; fi
  prev="$a"
done
# target is the arg after 'dir'
set -- "$@"
if [ "$1" = "dir" ]; then target="$2"; fi
if grep -rl 'AKIA' "$target" >/dev/null 2>&1; then
  printf '[{"Description":"AWS Access Key","File":"%s/leak.txt","RuleID":"aws-access-key","Secret":"AKIA..."}]' "$target" > "$report"
  exit 1
fi
printf '[]' > "$report"
exit 0
`,
  );
  await chmod(script, 0o755);
  return script;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp023-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sanitizer', () => {
  it('returns scanner-missing when the binary is absent (fail-closed)', async () => {
    const res = await scanArtifacts([root], {
      scanner: 'gitleaks-definitely-not-installed-xyz',
      env: { PATH: join(root, 'empty-bin') },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('scanner-missing');
  });

  it('reports findings from a scanner that emits gitleaks JSON', async () => {
    const scanner = await writeMockGitleaks(root);
    const target = join(root, 'scanme');
    await mkdir(target);
    await writeFile(
      join(target, 'leak.txt'),
      'aws_key = AKIAIOSFODNN7EXAMPLE\n',
    );
    const res = await scanArtifacts([target], { scanner });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('findings');
      expect(res.findings.length).toBeGreaterThan(0);
      expect(res.findings[0]?.RuleID).toBe('aws-access-key');
    }
  });

  it('is clean when the scanner reports no findings', async () => {
    const scanner = await writeMockGitleaks(root);
    const target = join(root, 'clean');
    await mkdir(target);
    await writeFile(join(target, 'ok.txt'), 'nothing secret here\n');
    const res = await scanArtifacts([target], { scanner });
    expect(res).toMatchObject({ ok: true, findings: [] });
  });

  it('scanForCommit scans existing staged files', async () => {
    const scanner = await writeMockGitleaks(root);
    const repo = join(root, 'repo');
    await initRepo(repo);
    await writeFile(join(repo, 'a.txt'), 'AKIAIOSFODNN7EXAMPLE\n');
    const res = await scanForCommit(repo, ['a.txt', 'deleted.txt'], {
      scanner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('findings');
  });
});

describe('verify', () => {
  it('runs card commands and produces a valid test-report.json with case: markers', async () => {
    const repo = join(root, 'code-repo');
    await cp(FIXTURE_REPO, repo, { recursive: true });
    await mkdir(join(repo, 'tests'), { recursive: true });
    await writeFile(
      join(repo, 'tests', 'app.test.js'),
      '// case:c1 happy path\nit("case:c2 works", () => {});\n',
    );

    const runDir = join(root, 'runs', '001-verify');
    const res = await runVerifyTask({
      repoPath: repo,
      runId: '001-verify',
      runDir,
      ticket: 'T-1',
      card: {
        test: 'make test',
        lint: 'make lint',
        build: 'make build',
        forbidden_paths: [],
        verified: true,
      },
      timeoutMs: 60_000,
    });

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.commands.map((c) => c.name)).toEqual(['test', 'lint', 'build']);
    for (const c of res.commands) {
      expect(c.exitCode).toBe(0);
      expect((await readFile(c.logPath, 'utf8')).length).toBeGreaterThan(0);
    }

    const report = TestReportSchema.parse(
      JSON.parse(await readFile(res.reportPath, 'utf8')),
    );
    expect(report.ticket).toBe('T-1');
    const byId = new Map(report.cases.map((c) => [c.case_id, c]));
    expect(byId.get('c1')?.implemented).toBe(true);
    expect(byId.get('c1')?.file).toBe('tests/app.test.js');
    expect(byId.get('c2')?.implemented).toBe(true);
    expect(report.implemented).toBe(2);
    expect(report.pass_pct).toBe(100);
  }, 30_000);

  it('marks planned-but-unimplemented cases and records failures', async () => {
    const repo = join(root, 'code-repo');
    await cp(FIXTURE_REPO, repo, { recursive: true });
    const runDir = join(root, 'runs', '002-verify');
    const res = await runVerifyTask({
      repoPath: repo,
      runId: '002-verify',
      runDir,
      card: { test: 'exit 3', forbidden_paths: [], verified: true },
      plannedCases: ['c1'],
      timeoutMs: 60_000,
    });
    expect(res.exitCode).toBe(3);
    const c1 = res.report.cases.find((c) => c.case_id === 'c1');
    expect(c1?.implemented).toBe(false);
    expect(res.report.pass_pct).toBe(0);
    expect(res.report.planned).toBe(1);
  });
});

describe('collect', () => {
  it('moves scratch artifacts to runDir, purges, leaves clean git status', async () => {
    const worktree = join(root, 'wt');
    await initRepo(worktree);
    await writeFile(join(worktree, '.gitignore'), '.sprint-runner/\n');
    await writeFile(join(worktree, 'README.md'), 'x\n');
    git(['add', '-A'], worktree);
    git(['commit', '-m', 'init'], worktree);

    const scratch = scratchPath(worktree, 'run-1');
    await mkdir(join(scratch, 'nested'), { recursive: true });
    await writeFile(join(scratch, 'triage.json'), '{"schema":1}\n');
    await writeFile(join(scratch, 'nested', 'log.txt'), 'hello\n');

    const runDir = join(root, 'runs', 'run-1');
    const res = await collectArtifacts({
      worktree,
      runId: 'run-1',
      runDir,
      canWriteOutsideTree: false,
    });

    expect(res.ok).toBe(true);
    expect(res.residue).toEqual([]);
    expect(new Set(res.moved)).toEqual(
      new Set(['triage.json', join('nested', 'log.txt')]),
    );
    expect(
      JSON.parse(await readFile(join(runDir, 'triage.json'), 'utf8')),
    ).toEqual({ schema: 1 });
    expect(await readFile(join(runDir, 'nested', 'log.txt'), 'utf8')).toBe(
      'hello\n',
    );

    // scratch fully purged; nothing shows in git status
    await expect(
      readFile(join(scratch, 'triage.json'), 'utf8'),
    ).rejects.toThrow();
    expect(git(['status', '--porcelain'], worktree)).toBe('');
  });

  it('purges emptied ancestor dirs for multi-segment run ids', async () => {
    // Real run ids are `ws/<subject>/<attempt>-<stage>` — the scratch
    // leaf sits under `.sprint-runner/ws/<subject>/`, which must not
    // survive as residue (wp-098 container e2e regression).
    const worktree = join(root, 'wt-ms');
    await initRepo(worktree);
    await writeFile(join(worktree, '.gitignore'), '.sprint-runner/\n');
    git(['add', '-A'], worktree);
    git(['commit', '-m', 'init'], worktree);

    const runId = 'ws/SR-1/001-implement';
    const scratch = scratchPath(worktree, runId);
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, 'result.json'), '{"ok":true}\n');

    const res = await collectArtifacts({
      worktree,
      runId,
      runDir: join(root, 'runs', ...runId.split('/')),
      canWriteOutsideTree: false,
    });

    expect(res.ok).toBe(true);
    expect(res.residue).toEqual([]);
    await expect(readdir(join(worktree, '.sprint-runner'))).rejects.toThrow();
  });

  it('is a no-op (besides scratch purge) for outside-tree backends', async () => {
    const worktree = join(root, 'wt2');
    await initRepo(worktree);
    const runDir = join(root, 'runs', 'run-2');
    const res = await collectArtifacts({
      worktree,
      runId: 'run-2',
      runDir,
      canWriteOutsideTree: true,
    });
    expect(res.ok).toBe(true);
    expect(res.moved).toEqual([]);
  });

  it('findScanner resolves absolute executable paths', async () => {
    const scanner = await writeMockGitleaks(root);
    expect(await findScanner(scanner)).toBe(scanner);
    expect(
      await findScanner('definitely-missing-xyz', { PATH: '/nonexistent' }),
    ).toBeNull();
  });
});
