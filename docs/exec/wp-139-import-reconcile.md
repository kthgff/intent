---
schema: 1
id: wp-139
title: Import reconciliation — provenance states, clustering, reconciled-before-autonomy
status: todo
priority: medium
depth: standard
repos: []
wave: W19
depends_on: [wp-131, wp-144]
---

## Description
PRD §15.3 import path. The `import` runner task + board gain
reconciliation semantics: imported items land on an `import`-type board
(never directly into autonomous dev), clustered by metadata + explicit
relations + embeddings; human reviews duplicates/conflicts/completed
work/clarification needs before items become executable. Provenance
tri-state on requirements/items: `inferred | source-backed |
stakeholder-verified` — inferred requirements never auto-approve.
Three RS paths: no-spec → reconstructed draft (labeled inferred);
existing spec → attach + map; outdated spec → gap list + proposed
amendments via ChangeSet (wp-140). Imported items keep original source
system + id (`tickets.source` already carries the key — extend to a
`source_ref` json: system, url, imported_at, original_status).
GitHub issues ≠ PRs distinguished; attachments ingested as evidence.
Post-reconciliation the import board can convert to an ordinary
enhancement board with import history preserved.

## File ownership
`packages/conductor/src/import/**`, `packages/conductor/src/semantics/**`,
`packages/api` board/import routes, `packages/core` provenance enums

## Acceptance criteria
- [ ] Imported items cannot enter `ready` until reconciled flag set
- [ ] Provenance tri-state enforced (inferred ≠ approved)
- [ ] Clustering + duplicate/conflict surfacing on the import board
- [ ] source_ref preserves original system identity
- [ ] `pnpm test` green

## Contract change
`source_ref` col + provenance enum land in wp-131.
