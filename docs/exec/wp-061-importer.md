---
schema: 1
id: wp-061
title: GitHub importer — issues → ticket folders
status: done
status: in-progress
priority: medium
depth: standard
repos: []
wave: W6
depends_on: [wp-013]
---

## Description
`import:<source>` run path: gh/octokit fetch issues (--repo --milestone
filters per PRD), preview rows → import run → ticket folders per
import.md prompt (status imported, repos mapped via
importers.default_repo_map, source: github:<key>). IMPORTED sentinel →
commit folders → each → imported status. Tracker key preserved as id
where possible; collision → flagged inbox item (never renumber).

## File ownership
`packages/conductor/src/import/**` or `packages/importers/**`

## Acceptance criteria
- [x] Fixture issues → correct ticket.md frontmatter + folders committed
- [x] Id collision → inbox item, original untouched
- [x] Repo map applied; unmapped → needs-info-style flag, not guess
- [x] Jira/Linear: importer contract seam exists, impls absent (v1-out)

## Notes
Landed in `packages/conductor/src/import/`: `github.ts` (`gh` CLI fetch),
`preview.ts` (label→priority heuristic + repo-map application),
`materialize.ts` (ticket.md emit + commitAll + collision gate items),
`run.ts` (`runImport` → `IMPORTED: <n>` / `IMPORT-FAILED: <r>`).
