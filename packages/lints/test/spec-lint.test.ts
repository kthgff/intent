import { describe, expect, it } from 'vitest';
import { renderSpecLint, specLint } from '../src/index.js';

const GOOD_TICKET = `---
schema: 1
id: SR-0001
title: Add retry logic to the ETL job runner
status: imported
priority: high
repos: [code-repo]
depth: standard
---

## Description
The nightly ETL runner fails permanently on transient S3 errors. Retry
failed downloads with exponential backoff, max 3 attempts, and surface
a per-file error summary in the job log.

## Acceptance criteria
- [ ] Transient S3 errors (5xx, throttling) are retried with exponential backoff, max 3 attempts
- [ ] Non-transient errors (4xx auth) fail immediately with no retry
- [ ] Job log contains per-file outcome lines: file, attempts, result

## Notes
Fixture ticket.
`;

describe('specLint (SCHEMAS §15)', () => {
  it('scores a well-formed ticket 100 with no flags', () => {
    const r = specLint(GOOD_TICKET);
    expect(r.score).toBe(100);
    expect(r.flags).toEqual([]);
  });

  it('flags empty repos (-15)', () => {
    const md = GOOD_TICKET.replace('repos: [code-repo]', 'repos: []');
    const r = specLint(md);
    expect(r.score).toBe(85);
    expect(r.flags.join('\n')).toMatch(/repos/);
  });

  it('flags short description (-15)', () => {
    const md = GOOD_TICKET.replace(
      /## Description[\s\S]*?## Acceptance/,
      '## Description\nShort.\n\n## Acceptance',
    );
    const r = specLint(md);
    expect(r.score).toBe(85);
    expect(r.flags.join('\n')).toMatch(/description only \d+ chars/);
  });

  it('flags missing AC section (-20)', () => {
    const md = GOOD_TICKET.replace(
      /## Acceptance criteria[\s\S]*?## Notes/,
      '## Notes',
    );
    const r = specLint(md);
    expect(r.score).toBe(80);
    expect(r.flags.join('\n')).toMatch(/acceptance-criteria/);
  });

  it('flags vague AC verbs (-15)', () => {
    const md = GOOD_TICKET.replace(
      'are retried with exponential backoff, max 3 attempts',
      'works under transient failure',
    );
    const r = specLint(md);
    expect(r.score).toBe(85);
    expect(r.flags.join('\n')).toMatch(/vague verb: 'works'/);
  });

  it('flags placeholder text once per hit (-15 total)', () => {
    const md = `${GOOD_TICKET}\nTBD more later\nTODO also this\n`;
    const r = specLint(md);
    expect(r.score).toBe(85);
    expect(r.flags.filter((f) => f.startsWith('placeholder'))).toHaveLength(2);
  });

  it('flags missing/invalid frontmatter (-10) and bad enums', () => {
    const md = GOOD_TICKET.replace('status: imported', 'status: bogus');
    const r = specLint(md);
    expect(r.score).toBe(90);
    expect(r.flags.join('\n')).toMatch(/invalid enum/);
    expect(specLint('no frontmatter here').score).toBeLessThanOrEqual(55);
  });

  it('requires DoD only for full specs (depth: deep)', () => {
    const deep = GOOD_TICKET.replace('depth: standard', 'depth: deep');
    const r = specLint(deep);
    expect(r.score).toBe(90);
    expect(r.flags.join('\n')).toMatch(/Definition of Done/);
    // light tickets get the points free — covered by the 100 test
  });

  it('accepts ac_id table rows as ACs', () => {
    const md = GOOD_TICKET.replace(
      /## Acceptance criteria\n[\s\S]*?\n## Notes/,
      `## Acceptance criteria
| ac_id | criterion | verifies-how |
| ac1 | when a 5xx occurs then the download retries with backoff | unit test |
| ac2 | when a 4xx occurs then the job fails immediately | unit test |

## Notes`,
    );
    const r = specLint(md);
    expect(r.score).toBe(100);
  });

  it('renderSpecLint emits the {{SPEC_LINT}} shape', () => {
    const clean = renderSpecLint(specLint(GOOD_TICKET));
    expect(clean).toBe('spec_score: 100/100\nflags: none');
    const dirty = renderSpecLint(specLint(''));
    expect(dirty).toMatch(/^spec_score: \d+\/100\nflags:\n- /);
  });
});
