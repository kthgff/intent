# TRACKER — sprint-runner build

Live execution tracker. Updated on every landed work package.
Legend: `todo` · `in-progress` · `review` · `done` · `blocked` · `cut`
Work packages: `docs/exec/wp-*.md` (v1 ticket schema, dogfooded).

## Decision log

| # | Decision | Status |
| --- | --- | --- |
| D1 | Engine stack: **TypeScript/Node** (user ratified 2026-10-03; Go was raised and deferred — revisit only if Tauri-native packaging demands it) | done |
| D2 | Build in-place: `intent/` = product repo, `docs/` stays | done |
| D3 | M1 v0-pilot skipped; engine built first, piloted on its own output | done |
| D4 | First vertical: config → projection → conductor tick → devin adapter → triage → transition → commit | done |
| D5 | Toolchain: Node ≥22, ESM, TS strict, pnpm, vitest, zod, better-sqlite3 | done |
| D6 | Storage: `Store` interface + SQLite impl only; Postgres deferred to M6 | done |
| D7 | Git: shell out to real `git` (no isomorphic-git) | done |
| D8 | HTTP: Fastify + SSE; UI (React+Vite) deferred to its wave | done |
| D9 | Platforms: macOS/Linux only v1 (POSIX signals, worktree paths) | done |
| D10 | Prompts ship in-package + `PROMPT_VERSION` stamped on runs | done |
| D11 | Spec-lint rules + fingerprint formula must be specified in code AND back-ported to SCHEMAS.md | done |
| D12 | Embeddings `local` via onnxruntime-node/transformers.js — spike before commit; `off` always works | open |
| D13 | External binaries (gitleaks, gh, aider, devin) = PATH deps, detected at startup; scanner absent = fail-closed | done |

## Waves (see EXEC-PLAN.md)

| Wave | Package | Scope | Depends | Status |
| --- | --- | --- | --- | --- |
| W0 | wp-001 | Scaffold: pnpm workspace, TS config, vitest, lint, CI, layout | — | done |
| W0 | wp-002 | Contracts freeze: port `docs/prompts` + token table + SCHEMAS types into `packages/core` (zod) | wp-001 | done |
| W1 | wp-010 | Config layer: layered YAML load, precedence, .env, validation | wp-002 | done |
| W1 | wp-011 | Store: `Store` iface + SQLite impl (DB-SCHEMA), migrations | wp-002 | done |
| W1 | wp-012 | Git ops: tickets-repo sync (pull-rebase-retry), worktrees, ref-CAS, next-id | wp-002 | done |
| W1 | wp-013 | Ticket projection: frontmatter parse → `tickets`/`ticket_repos` rows | wp-010,011,012 | todo |
| W2 | wp-020 | Prompt renderer: tokens, ARTIFACT_TARGETS, capability shaping | wp-010 | done |
| W2 | wp-021 | Adapter iface + **mock adapter** (scripted sentinels — the test backend) | wp-020 | todo |
| W2 | wp-022 | Devin adapter: `devin -p`, export parse, usage extract | wp-021 | todo |
| W2 | wp-023 | Runner env-ops: sanitizer (gitleaks), verify tasks, artifact collect | wp-012 | todo |
| W3 | wp-030 | Conductor core: tick loop, reconcile, leases, heartbeats, kill/pause | wp-011,021,023 | todo |
| W3 | wp-031 | State machine: sentinel→transition table, gate items, events.jsonl | wp-030 | todo |
| W3 | wp-032 | Doc lints: spec-lint scorer, coverage-matrix, fail-closed validator | wp-031 | todo |
| W4 | wp-040 | E2E vertical: mock-adapter pipeline imported→triage→…→commit on fixture repo | wp-030,031,032 | todo |
| W5 | wp-050 | Review pipeline: 4-pass merge, fingerprints, review.json, fix rounds | wp-031 | todo |
| W5 | wp-051 | Shepherd: gh poll, ci-fix/comment-fix/rebase runs, DoD gate | wp-050 | todo |
| W5 | wp-052 | Aider adapter + OpenRouter pricing table, usage stream-parse | wp-021 | todo |
| W6 | wp-060 | API: REST + SSE per API.md, token auth | wp-031 | todo |
| W6 | wp-061 | Importers: GitHub issues → ticket folders | wp-013 | todo |
| W7 | wp-070 | KB/survey: dossiers, entities, embeddings spike → impl | wp-011 | todo |
| W8 | wp-080 | UI: 14 screens on the API (React+Vite, served by conductor) | wp-060 | todo |

## Parallel-agent rules

1. One agent = one `wp-*.md` at a time, on branch `wp/<id>` off `main`.
2. Contracts (`packages/core`) merge FIRST — later waves code against
   landed interfaces, never against this doc.
3. File-ownership map in EXEC-PLAN.md — a wp touching files outside its
   map must flag it in the ticket before starting.
4. Every wp ends: tests green, its ticket `status: done`, this table
   updated, PR opened. Agents update ONLY their own row.
5. `blocked` entries get a `## Blocker` section in the wp file — never
   silently dropped.

## Open risks

| Risk | Mitigation |
| --- | --- |
| D12 embeddings spike fails (onnx size/compat) | `embeddings: off` path is fully functional; local becomes `openrouter` fallback |
| Devin `--export` schema unknown | wp-022 starts with a spike run + documented findings |
| Spec-lint underspecified (D11) | wp-032 writes the rule set into SCHEMAS.md before coding |
| Multi-agent interface drift | wp-002 freezes contracts; review enforces no core edits outside wp-002 follow-ups |
