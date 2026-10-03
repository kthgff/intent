import { describe, expect, it } from 'vitest';
import { coverageLint, filePlanVsDiff } from '../src/index.js';

const TDD = `---
schema: 1
---
# TDD — SR-0001: retry logic

## Architecture
Text.

## Execution plan
| step | description | verify-with |
| 1 | add backoff helper | unit test |

## File plan
| file | repo | change | why |
| src/retry.ts | code-repo | add | backoff helper |
| src/runner.ts | code-repo | modify | call helper |
| docs/ops.md | code-repo | untestable: docs only | runbook update |

## Risks / open items
None.
`;

const TEST = `# Test plan — SR-0001

## Cases
| case_id | title | type | file | covers |
| c1 | retries on 5xx | unit | src/retry.ts | src/retry.ts |
| c2 | no retry on 4xx | unit | src/runner.ts | src/runner.ts |

## Coverage matrix
| item | kind | case_ids |
| src/retry.ts | file | c1 |
| src/runner.ts | file | c2 |
| docs/ops.md | file | n/a |
| ac1 | ac | c1 |

## Definition of Done
| criterion | verified_by |
| suite green | cmd:make verify |
`;

describe('coverageLint (SCHEMAS §4)', () => {
  it('passes when every file-plan row is covered or untestable', () => {
    expect(coverageLint(TDD, TEST)).toEqual([]);
  });

  it('flags a file-plan row with no case_id', () => {
    const test = TEST.replace('| src/runner.ts | file | c2 |\n', '');
    const vs = coverageLint(TDD, test);
    expect(vs.map((x) => x.rule)).toContain('coverage.uncovered-file');
    expect(
      vs.find((x) => x.rule === 'coverage.uncovered-file')?.message,
    ).toMatch(/src\/runner\.ts/);
  });

  it('exempts untestable: rows without requiring a matrix row', () => {
    const test = TEST.replace('| docs/ops.md | file | n/a |\n', '');
    expect(coverageLint(TDD, test)).toEqual([]);
  });

  it('detects fake case_ids not present in the cases table', () => {
    const test = TEST.replace(
      '| src/retry.ts | file | c1 |',
      '| src/retry.ts | file | c99 |',
    );
    const vs = coverageLint(TDD, test);
    expect(vs.map((x) => x.rule)).toContain('coverage.unknown-case');
  });

  it('fails closed on unparseable tables', () => {
    const badPlan = TDD.replace(
      '| file | repo | change | why |',
      '| path | repo | change | why |',
    );
    const vs = coverageLint(badPlan, TEST);
    expect(vs.map((x) => x.rule)).toContain('coverage.file-plan-unparseable');

    const noMatrix = TEST.replace('## Coverage matrix', '## Whatever');
    const vs2 = coverageLint(TDD, noMatrix);
    expect(vs2.map((x) => x.rule)).toContain('coverage.matrix-unparseable');

    const noCases = TEST.replace('## Cases', '## Scenarios');
    const vs3 = coverageLint(TDD, noCases);
    expect(vs3.map((x) => x.rule)).toContain('coverage.cases-unparseable');
  });

  it('flags bad matrix kind values', () => {
    const test = TEST.replace('| ac1 | ac | c1 |', '| ac1 | bogus | c1 |');
    const vs = coverageLint(TDD, test);
    expect(vs.map((x) => x.rule)).toContain('coverage.bad-kind');
  });
});

describe('filePlanVsDiff', () => {
  it('reports unplanned diff files and missing planned files', () => {
    const r = filePlanVsDiff(TDD, ['src/retry.ts', 'src/extra.ts']);
    expect(r.unplanned).toEqual(['src/extra.ts']);
    expect(r.missing).toEqual(['src/runner.ts', 'docs/ops.md']);
    expect(r.error).toBeUndefined();
  });

  it('empty when plan and diff match', () => {
    const r = filePlanVsDiff(TDD, [
      'src/retry.ts',
      'src/runner.ts',
      'docs/ops.md',
    ]);
    expect(r.unplanned).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('fails closed on unparseable plan', () => {
    const r = filePlanVsDiff('garbage', ['a.ts']);
    expect(r.error).toBeDefined();
    expect(r.unplanned).toEqual(['a.ts']);
  });
});
