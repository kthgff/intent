/**
 * merge/types.ts — shared shapes for the Merge Center (DELIVERY §2,
 * wp-133).
 *
 * The Merge Center is the deterministic tail of the shepherd: it
 * evaluates a readiness checklist per `ticket_repos` row and — only
 * when every item is green — executes the merge itself via `gh pr
 * merge` (never bypassing branch protection). These types are the
 * contract between the checklist, the executor, the post-merge
 * bookkeeping, and the poll wiring.
 */
import type { GateName } from '@veto/core';
import type { ToolCtx } from '../loop/tools.js';
import type { GhClient } from '../shepherd/gh.js';

/** Context the Merge Center needs: the shepherd's tool context plus the
 *  injectable `gh` client. `ShepherdCtx` (poll.ts) satisfies it
 *  structurally. */
export type MergeCtx = ToolCtx & { gh: GhClient };

/** One readiness checklist row (DELIVERY §2 "Readiness checklist"). */
export interface ChecklistItem {
  /** Stable id — `approval` | `scope` | `ac-evidence` | `checks` |
   *  `security` | `depends-on` | `conflict` | `branch-protection` |
   *  `dod`. */
  id: string;
  /** Human-readable label for the Merge Center UI. */
  label: string;
  ok: boolean;
  /** Why the item failed / extra context (never a secret). */
  detail?: string;
  /** Gate name to surface when this item blocks the merge. Only
   *  `branch-protection` names a gate (`merge`); a git conflict names
   *  `merge_conflict` and drives a `rebase` run. */
  gate?: GateName;
}

/** Per-ticket readiness rollup. */
export interface MergeReadiness {
  ticket_id: string;
  /** True only when every checklist item is `ok`. */
  ready: boolean;
  items: ChecklistItem[];
  /** The failing items (subset of `items`) — the UI's "why not". */
  blockers: ChecklistItem[];
  /** repo → current PR head SHA (approval binding + attempt dedup). */
  heads: Record<string, string | null>;
  /** Evaluation timestamp (`nowIso`). */
  at: string;
}

/** Outcome of an execution attempt for one ticket_repos row. */
export type MergeRowOutcome =
  | { repo: string; kind: 'merged'; sha: string | null }
  | { repo: string; kind: 'queued'; pr_url: string | null }
  | { repo: string; kind: 'conflict'; detail: string }
  | { repo: string; kind: 'blocked'; detail: string }
  | { repo: string; kind: 'skipped'; detail: string };
