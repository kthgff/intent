# Fixtures

Seed content for tests. These are plain files — tests copy them into
tmp dirs and `git init` them (commits, branches, remotes under
`file://` for push/pull coverage).

- `tickets-repo/` — v1-schema tickets repo: `.veto/` config +
  next-id, three tickets at different pipeline stages (`imported`,
  `needs-info`, `ready`).
- `code-repo/` — trivial repo with a repo-card-compatible Makefile
  (`make test|lint|build` all succeed) for verify-task tests.

Helpers that materialize these as git repos live in
`packages/conductor/test/helpers/` (wp-040) — keep this directory free
of anything that requires a git history.
