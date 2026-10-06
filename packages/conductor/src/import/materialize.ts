/**
 * Materialize normalized issues into DB rows (D29 — was ticket folders
 * + a tickets-repo commit under wp-061). For each issue:
 *
 *   - `id = store.allocTicketId(workspace)` — `SR-NNNN` from
 *     `projects.next_ticket_seq`; the tracker key is preserved in
 *     `source` (`github:<owner>/<repo>#<n>`), per SCHEMAS §1.
 *   - one `tickets` truth row (`status: 'imported'`),
 *   - one immutable `ticket.md` `doc_versions` row,
 *   - one `ticket_repos` row per mapped repo (branch/worktree null —
 *     run stages claim them later).
 *
 * No filesystem, no git: Postgres is the ledger. Each ticket's write
 * set lands in one transaction (ARCHITECTURE §4.4).
 *
 * Spec behaviors preserved:
 * - Re-import of an already-imported `source` → flagged `failure`
 *   gate item + notification; the original row is left untouched,
 *   NEVER renumbered or duplicated (was the dir-collision rule).
 * - `repos` from `default_repo_map`; unmapped → `repos: []` +
 *   `repo-map-unmapped` note for triage (D17 — the deterministic
 *   importer never guesses).
 * - Issue body lands verbatim under `## Description`; `- [ ]`/`- [x]`
 *   checkbox lines additionally populate `## Acceptance criteria`.
 *   No ACs → section stays empty (never fabricated).
 */
import { createHash } from 'node:crypto';
import {
  type SourceRef,
  type Store,
  type TicketFrontmatter,
  TicketFrontmatterSchema,
} from '@veto/core';
import YAML from 'yaml';
import {
  flagsFor,
  priorityFromLabels,
  reposFor,
  sourceFor,
} from './preview.js';
import { sourceRefFor } from './source-ref.js';
import type { RawIssue } from './types.js';

/** Gate instance name for import-surface failures (already-imported
 *  collision, store failure). A human clears it in the inbox. */
export const IMPORT_FAILURE_GATE = 'import';

const CHECKBOX_RE = /^[-*]\s+\[( |x|X)\]\s+(.+)$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** GitHub task-list lines → AC checklist entries (verbatim text). */
export function extractAcceptanceCriteria(body: string): string[] {
  return body
    .split('\n')
    .map((l) => CHECKBOX_RE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `- [ ] ${m[2]}`);
}

/** Render the ticket.md doc (frontmatter + body) for an already-
 *  allocated `id`. The frontmatter is schema-validated before emit —
 *  fail-closed even though we built it. */
export function renderTicketMd(
  issue: RawIssue,
  repoMap: Record<string, string>,
  id: string,
): { id: string; frontmatter: TicketFrontmatter; contents: string } {
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
  workspace: string;
  store: Store;
  /** `importers.default_repo_map` — label → repo name. */
  repoMap: Record<string, string>;
  /** `actor:` for `doc_versions.edited_by` + notification attribution. */
  actor?: string;
}

export interface ImportedTicket {
  /** Allocated `SR-NNNN` ticket id. */
  id: string;
  /** Tracker source key (`github:<owner>/<repo>#<n>`). */
  source: string;
  /** ticket.md doc_versions.version written (always 1 on first import). */
  docVersion: number;
  /** Structured provenance (wp-139) — original system + id + kind. */
  sourceRef: SourceRef;
}

export interface ImportCollision {
  /** Source key that was already imported — left untouched. */
  source: string;
  /** Existing ticket_id holding this source. */
  existing: string;
}

export interface MaterializeResult {
  imported: ImportedTicket[];
  collisions: ImportCollision[];
}

export async function materialize(
  issues: RawIssue[],
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const { workspace, store } = opts;
  const actor = opts.actor ?? 'veto';
  const now = new Date().toISOString();
  const result: MaterializeResult = { imported: [], collisions: [] };

  // allocTicketId self-heals a missing projects row with sequences
  // seeded above the existing ids (pg.ts allocSeq) — no caller-side
  // project bootstrap needed.

  // Dedup on the tracker source key — re-importing the same issue is a
  // no-op + gate item (was: existing tickets/<KEY>/ dir blocked it).
  const bySource = new Map<string, string>();
  for (const t of await store.listTickets({ workspace })) {
    if (t.source) bySource.set(t.source, t.ticket_id);
  }

  for (const issue of issues) {
    const source = sourceFor(issue);
    const existing = bySource.get(source);
    if (existing) {
      result.collisions.push({ source, existing });
      await store.upsertGateItem({
        workspace,
        subject: existing,
        gate: IMPORT_FAILURE_GATE,
        kind: 'failure',
        surfaced_at: now,
        blocked_agent: false,
      });
      await store.insertNotification({
        workspace,
        subject: existing,
        kind: 'gate:failure',
        payload: JSON.stringify({
          gate: IMPORT_FAILURE_GATE,
          reason: 'id-collision',
          source,
          existing,
        }),
        created_at: now,
      });
      continue;
    }

    const imported = await store.transaction(async (s) => {
      const id = await s.allocTicketId(workspace);
      const { frontmatter, contents } = renderTicketMd(issue, opts.repoMap, id);
      // wp-139: preserve the original tracker identity — system + kind
      // (issue ≠ PR) + url + import time + original status.
      const sourceRef = sourceRefFor(issue, now);
      await s.upsertTicket({
        workspace,
        ticket_id: id,
        feature: frontmatter.feature ?? null,
        title: frontmatter.title,
        status: 'imported',
        priority: frontmatter.priority,
        depth: frontmatter.depth,
        backend: frontmatter.backend ?? null,
        model: frontmatter.model ?? null,
        repos: frontmatter.repos,
        parent: frontmatter.parent ?? null,
        depends_on: frontmatter.depends_on,
        source,
        source_ref: sourceRef,
        // §15.7 taxonomy (wp-151): the import path stamps origin so no
        // ticket is left unclassified — a tracker issue is human-filed
        // work (`manual`); triage's classification block fills
        // `work_type` (and may override origin, e.g. `review`).
        origin: 'manual',
        forced: frontmatter.forced,
        spec_score: null,
        spec_hash: sha256(contents),
        blocked_reason: frontmatter.blocked_reason ?? null,
        created_at: now,
        updated_at: now,
      });
      const doc = await s.appendDocVersion(
        { workspace, subject: id, doc: 'ticket.md' },
        contents,
        actor,
      );
      for (const repo of frontmatter.repos) {
        await s.upsertTicketRepo({
          workspace,
          ticket_id: id,
          repo,
          branch: null,
          worktree: null,
          pr_url: null,
          pr_state: null,
          ci_state: null,
          merged_sha: null,
        });
      }
      return { id, source, docVersion: doc.version, sourceRef };
    });
    bySource.set(source, imported.id);
    result.imported.push(imported);
  }

  return result;
}
