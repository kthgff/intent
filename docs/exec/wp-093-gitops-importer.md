---
schema: 1
id: wp-093
title: Gitops slim + importer→rows + capture endpoint — delete projection
status: todo
priority: high
depth: standard
repos: []
wave: W10
depends_on: [wp-092]
---

## Description
Slim `packages/gitops` to code-repo operations only (D29): worktrees,
branches, commits, PR/`gh` ops. **Delete** tickets-repo sync
(pull-rebase-retry), the ref-CAS machinery, next-id allocation, and
the wp-013 projection pipeline (`TicketFrontmatterSchema` →
`tickets`/`ticket_repos` upsert) — tickets are DB truth now, not a
projection. The GitHub importer (wp-061) writes rows directly via the
Store (`tickets`, `ticket_repos`, `board_items` tray rows) instead of
materializing ticket folders; keep its fail-closed behavior (unmapped
labels → `repos: []` + `repo-map-unmapped` note, D17). Add the
**capture endpoint** per D27: `POST /capture` creating `board_items`
with `board: null` (project tray) + `feedback` item type — used by
`veto add`, ⌘⇧C, and the mobile route. `board_items.serves` write
path for goal edges (D33) where item creation carries it.

## File ownership
`packages/gitops/**` (deletions + code-repo surface),
`packages/api/**` (importer rewire + `POST /capture`),
`packages/cli` (`veto add` path if it exists yet), fixtures
(importer fixtures → expected rows, not folders)

## Acceptance criteria
- [ ] `gitops` public surface contains no tickets-repo sync/projection/ref-CAS exports; dead code deleted, not deprecated
- [ ] Importer end-to-end: GitHub issue fixture → `tickets` + `ticket_repos` + tray `board_items` rows; label-map and unmapped behavior preserved
- [ ] `POST /capture` creates `board_items(board=null)` with item type; validation fail-closed
- [ ] Frontmatter parser still exists for *file-based* ticket import compatibility OR is deleted per wp-090 contract — decision recorded in TRACKER
- [ ] `pnpm typecheck && pnpm test` green

## Contract change
None expected. If the capture payload needs a new core schema, flag it.
