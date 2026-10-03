---
schema: 1
id: wp-061
title: GitHub importer — issues → ticket folders
status: todo
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
- [ ] Fixture issues → correct ticket.md frontmatter + folders committed
- [ ] Id collision → inbox item, original untouched
- [ ] Repo map applied; unmapped → needs-info-style flag, not guess
- [ ] Jira/Linear: importer contract seam exists, impls absent (v1-out)
