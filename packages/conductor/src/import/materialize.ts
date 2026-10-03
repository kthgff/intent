/**
 * Materialize normalized issues into `tickets/<id>/ticket.md` folders
 * (SCHEMAS §1 frontmatter, status `imported`; import.md rules 1–5) and
 * commit them via gitops.
 *
 * Spec behaviors:
 * - id = `GH-<number>` — tracker key preserved; a collision with an
 *   existing `tickets/<id>/` dir surfaces a flagged `failure` gate item
 *   + notification and the original is left untouched. NEVER renumbered
 *   (CONDUCTOR "Special paths").
 * - `repos` from `default_repo_map`; unmapped → `repos: []` +
 *   `repo-map-unmapped` note for triage.
 * - Issue body lands verbatim under `## Description`; `- [ ]`/`- [x]`
 *   checkbox lines additionally populate `## Acceptance criteria`.
 *   No ACs → section stays empty (never fabricated).
 * - Commit via gitops `commitAll` (pull-rebase first so a concurrent
 *   commit doesn't fail the batch); any commit error is thrown to the
 *   caller, which emits `IMPORT-FAILED`.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Store,
  type TicketFrontmatter,
  TicketFrontmatterSchema,
} from '@sprint-runner/core';
import {
  type Actor,
  DEFAULT_ACTOR,
  commitAll,
  pullRebase,
} from '@sprint-runner/gitops';
import YAML from 'yaml';
import {
  flagsFor,
  priorityFromLabels,
  reposFor,
  sourceFor,
  ticketIdFor,
} from './preview.js';
import type { RawIssue } from './types.js';

/** Gate instance name for import-surface failures (id collision,
 *  commit failure). A human clears it in the inbox. */
export const IMPORT_FAILURE_GATE = 'import';

const CHECKBOX_RE = /^[-*]\s+\[( |x|X)\]\s+(.+)$/;

/** GitHub task-list lines → AC checklist entries (verbatim text). */
export function extractAcceptanceCriteria(body: string): string[] {
  return body
    .split('\n')
    .map((l) => CHECKBOX_RE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `- [ ] ${m[2]}`);
}

/** Render `tickets/<id>/ticket.md` contents. The frontmatter is
 *  schema-validated before emit — fail-closed even though we built it. */
export function renderTicketMd(
  issue: RawIssue,
  repoMap: Record<string, string>,
): { id: string; frontmatter: TicketFrontmatter; contents: string } {
  const id = ticketIdFor(issue);
  const repos = reposFor(issue, repoMap);
  const flags = flagsFor(issue, repos);
  const acs = extractAcceptanceCriteria(issue.body);

  const frontmatter = TicketFrontmatterSchema.parse({
    schema: 1,
    id,
    title: issue.title.trim() || `${issue.repo}#${issue.number}`,
    status: 'imported',
    priority: priorityFromLabels(issue.labels),
    repos,
    depth: 'standard',
    source: sourceFor(issue),
    depends_on: [],
    forced: false,
  });

  const notes: string[] = [
    `- Imported from ${sourceFor(issue)} (${issue.url || 'no url'})`,
  ];
  if (issue.milestone) notes.push(`- Milestone: ${issue.milestone}`);
  for (const f of flags) {
    if (f === 'repo-map-unmapped') {
      notes.push(
        '- repo-map-unmapped: no label matched importers.default_repo_map — triage must verify `repos`',
      );
    } else if (f === 'empty-body') {
      notes.push('- empty-body: source issue has no description');
    } else {
      notes.push(`- ${f}`);
    }
  }

  const contents = [
    '---',
    YAML.stringify(frontmatter).trimEnd(),
    '---',
    '',
    '## Description',
    '',
    issue.body.trim(),
    '',
    '## Acceptance criteria',
    '',
    ...acs,
    '',
    '## Notes',
    '',
    ...notes,
    '',
  ].join('\n');

  return { id, frontmatter, contents };
}

export interface MaterializeOptions {
  ticketsRepoPath: string;
  /** `importers.default_repo_map` — label → repo name. */
  repoMap: Record<string, string>;
  workspace: string;
  store: Store;
  actor?: Actor;
  /** Set false to skip git ops entirely (dry-run/preview callers). */
  commit?: boolean;
}

export interface MaterializedTicket {
  id: string;
  path: string;
}

export interface CollisionItem {
  id: string;
  /** Existing dir that blocked the import — left untouched. */
  path: string;
  source: string;
}

export interface MaterializeResult {
  imported: MaterializedTicket[];
  collisions: CollisionItem[];
  /** New commit sha, or null when commit was skipped/no-op. */
  commit: string | null;
}

export async function materialize(
  issues: RawIssue[],
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const ticketsDir = join(opts.ticketsRepoPath, 'tickets');
  const now = new Date().toISOString();
  const result: MaterializeResult = {
    imported: [],
    collisions: [],
    commit: null,
  };

  for (const issue of issues) {
    const { id, contents } = renderTicketMd(issue, opts.repoMap);
    const dir = join(ticketsDir, id);

    // Id collision → flagged inbox item, NEVER auto-renumber, original
    // untouched (CONDUCTOR "Special paths").
    if (existsSync(dir)) {
      result.collisions.push({
        id,
        path: dir,
        source: sourceFor(issue),
      });
      await opts.store.upsertGateItem({
        workspace: opts.workspace,
        subject: id,
        gate: IMPORT_FAILURE_GATE,
        kind: 'failure',
        surfaced_at: now,
        blocked_agent: false,
      });
      await opts.store.insertNotification({
        workspace: opts.workspace,
        subject: id,
        kind: 'gate:failure',
        payload: JSON.stringify({
          gate: IMPORT_FAILURE_GATE,
          reason: 'id-collision',
          source: sourceFor(issue),
          path: dir,
        }),
        created_at: now,
      });
      continue;
    }

    await mkdir(dir, { recursive: true });
    const path = join(dir, 'ticket.md');
    await writeFile(path, contents, 'utf8');
    result.imported.push({ id, path });
  }

  if (opts.commit !== false && result.imported.length > 0) {
    await pullRebase(opts.ticketsRepoPath).catch(() => {
      /* no remote / offline — local commit still proceeds */
    });
    result.commit = await commitAll(
      opts.ticketsRepoPath,
      `import: ${issues[0]?.repo ?? 'github'} — ${result.imported.length} ticket(s)`,
      opts.actor ?? DEFAULT_ACTOR,
    );
  }

  return result;
}
