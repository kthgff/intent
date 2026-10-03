import { describe, expect, it } from 'vitest';
import { structuredDocLint } from '../src/index.js';

const TDD = `# TDD — SR-0001
## File plan
| file | repo | change | why |
| src/a.ts | r | add | x |
`;

const TEST_MD = `# Test plan
## Cases
| case_id | title | type | file | covers |
| c1 | t | unit | f | x |
## Coverage matrix
| item | kind | case_ids |
| f | file | c1 |
`;

describe('structuredDocLint', () => {
  it('accepts well-formed docs', () => {
    expect(structuredDocLint('tdd.md', TDD)).toEqual([]);
    expect(structuredDocLint('test.md', TEST_MD)).toEqual([]);
    expect(
      structuredDocLint(
        'DEVIATIONS.md',
        '# D\n| planned | did | reason | file |\n| a | b | c | d |\n',
      ),
    ).toEqual([]);
  });

  it('validates ticket.md frontmatter keys and enums', () => {
    const bad = '---\nschema: 1\nid: X\nstatus: bogus\n---\nbody\n';
    const vs = structuredDocLint('ticket.md', bad);
    expect(vs.map((x) => x.rule)).toContain('doc.frontmatter');
    expect(vs.map((x) => x.rule)).toContain('doc.bad-enum');
  });

  it('flags wrong pinned columns in tdd.md file plan', () => {
    const bad = TDD.replace(
      '| file | repo | change | why |',
      '| path | repo | change | why |',
    );
    const vs = structuredDocLint('tdd.md', bad);
    expect(vs.map((x) => x.rule)).toContain('doc.table');
  });

  it('flags bad enum values inside test.md tables', () => {
    const bad = TEST_MD.replace(
      '| c1 | t | unit | f | x |',
      '| c1 | t | bogus | f | x |',
    );
    const vs = structuredDocLint('test.md', bad);
    expect(vs.map((x) => x.rule)).toContain('doc.bad-enum');
  });

  it('checks pr-body.md required headings', () => {
    const vs = structuredDocLint('pr-body.md', '## Summary\nhi\n');
    expect(vs.filter((x) => x.rule === 'doc.heading').length).toBe(4);
    const ok =
      '## Summary\ns\n## Acceptance criteria map\na\n## Deviations\nnone\n## Test results\nt\n## Risks / rollout notes\nr\n';
    expect(structuredDocLint('pr-body.md', ok)).toEqual([]);
  });

  it('fails closed on unknown doc names', () => {
    const vs = structuredDocLint('mystery.md', 'anything');
    expect(vs.map((x) => x.rule)).toContain('doc.unknown');
  });
});
