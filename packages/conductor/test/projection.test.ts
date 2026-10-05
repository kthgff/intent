/**
 * ticket.md parser tests (was wp-013 projection tests; wp-093 D29).
 *
 * The projection pass is gone — `tickets`/`doc_versions` rows are
 * truth, nothing is rebuilt from disk. What survives is the standalone
 * frontmatter parser at `src/import/parse.ts` (`parseTicketFile` reads
 * a path, `parseTicketMd` takes content), used wherever a ticket.md
 * *document* needs validating — import tooling, fixtures, doc render
 * checks. It is fail-closed but NEVER throws: malformed input is a
 * structured `{ok:false}` error the caller can surface as a gate item.
 *
 * Fixtures are read straight out of `fixtures/tickets-repo/` — they are
 * canned markdown now, not a repo to project.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTicketFile, parseTicketMd } from '../src/import/parse.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/tickets-repo',
);

const VALID_MINIMAL = [
  '---',
  'schema: 1',
  'id: SR-0100',
  'title: Minimal ticket',
  'status: imported',
  'priority: medium',
  'repos: [code-repo]',
  '---',
  '',
  '## Description',
  'minimal fixture',
  '',
].join('\n');

describe('parseTicketFile', () => {
  it('parses fixture frontmatter + body, applying documented §1 defaults', async () => {
    const path = join(FIXTURE, 'tickets', 'SR-0001', 'ticket.md');
    const r = await parseTicketFile(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter.id).toBe('SR-0001');
    expect(r.value.frontmatter.status).toBe('imported');
    expect(r.value.frontmatter.priority).toBe('high');
    expect(r.value.frontmatter.repos).toEqual(['code-repo']);
    // SCHEMAS §1 documented defaults — omitted keys fill in.
    expect(r.value.frontmatter.depth).toBe('standard');
    expect(r.value.frontmatter.depends_on).toEqual([]);
    expect(r.value.frontmatter.forced).toBe(false);
    expect(r.value.body).toContain('## Description');
    expect(r.value.body).toContain('## Acceptance criteria');
    expect(r.value.raw).toBe(readFileSync(path, 'utf8'));
  });

  it('honors non-default field values (depth: light)', async () => {
    const r = await parseTicketFile(
      join(FIXTURE, 'tickets', 'SR-0003', 'ticket.md'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter.depth).toBe('light');
    expect(r.value.frontmatter.status).toBe('ready');
  });

  it('returns a structured error for an unreadable path, never throws', async () => {
    const path = join(FIXTURE, 'tickets', 'NO-SUCH', 'ticket.md');
    const r = await parseTicketFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.path).toBe(path);
    expect(r.error.error).toContain('unreadable');
  });

  it('parses every fixture ticket.md', async () => {
    const dir = join(FIXTURE, 'tickets');
    const ids = readdirSync(dir).sort();
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      const r = await parseTicketFile(join(dir, id, 'ticket.md'));
      expect(r.ok, `${id}: ${r.ok ? '' : r.error.error}`).toBe(true);
      if (r.ok) expect(r.value.frontmatter.id).toBe(id);
    }
  });
});

describe('parseTicketMd', () => {
  it('parses a minimal valid doc, applying §1 defaults', () => {
    const r = parseTicketMd(VALID_MINIMAL, 'SR-0100/ticket.md');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter.id).toBe('SR-0100');
    expect(r.value.frontmatter.depth).toBe('standard');
    expect(r.value.frontmatter.depends_on).toEqual([]);
    expect(r.value.frontmatter.forced).toBe(false);
    expect(r.value.body).toContain('minimal fixture');
  });

  it('returns a structured error on malformed yaml, never throws', () => {
    const r = parseTicketMd('---\n: : not yaml\n---\nbody\n', 'bad/ticket.md');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.path).toBe('bad/ticket.md');
    expect(r.error.error.length).toBeGreaterThan(0);
  });

  it('errors when the frontmatter block is missing', () => {
    const r = parseTicketMd('# no frontmatter\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toContain('frontmatter');
  });

  it('errors when the frontmatter is not a yaml mapping', () => {
    const r = parseTicketMd('---\n- a\n- b\n---\nbody\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toContain('not a yaml mapping');
  });

  it('schema-invalid values → structured error (bad status)', () => {
    const r = parseTicketMd(
      [
        '---',
        'schema: 1',
        'id: SR-9999',
        'title: bogus status',
        'status: bogus',
        'priority: low',
        'repos: [code-repo]',
        '---',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toContain('schema:');
  });

  it('schema-invalid values → structured error (wrong types)', () => {
    const r = parseTicketMd(
      [
        '---',
        'schema: 1',
        'id: SR-9998',
        'title: wrong types',
        'status: imported',
        'priority: low',
        'repos: not-a-list',
        'depends_on: 42',
        '---',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toContain('schema:');
  });

  it('schema version other than 1 is rejected', () => {
    const r = parseTicketMd(
      [
        '---',
        'schema: 2',
        'id: SR-9997',
        'title: future schema',
        'status: imported',
        'priority: low',
        'repos: [code-repo]',
        '---',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });
});
