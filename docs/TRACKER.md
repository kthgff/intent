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
| D12 | Embeddings `local` via onnxruntime-node/transformers.js — spike before commit; `off` always works | done — SPIKE PASSED: `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` loads in ~2.4s, 384-dim normalized vectors; `local` = real bundled path, `openrouter` remote, `off` no-op. See docs/EMBEDDINGS.md |
| D13 | External binaries (gitleaks, gh, aider, devin) = PATH deps, detected at startup; scanner absent = fail-closed | done |
| D14 | Ticket projection (wp-013): SCHEMAS §1 inline defaults (`depth: standard`, `depends_on: []`, `forced: false`) applied before `TicketFrontmatterSchema` — fixtures omit them; parse-error detail rides in the notifications payload (gate_items has no detail column) | done |
| D15 | Conductor (wp-030): per-ticket spend/token "cumulative counters" are computed by summing `runs` rows (DB-SCHEMA `tickets` has no cost columns); cardless/doc stages run with the tickets-repo checkout as cwd (no worktree); `stalled` uses log/artifact mtime only — `heartbeat_at` is conductor-written and would mask silence | done |
| D18 | `'mock'` added to core `BACKENDS` — test backend, never user-configured | done |
| D16 | Devin CLI unauthenticated on this machine → real `--export` schema unverifiable (wp-022 spike); `usageFromExport` parses multiple spellings defensively, `source: estimated` fallback. Re-verify once `devin auth` exists | open |
| D19 | UI (wp-080): SSE auth rides the `sr_session` cookie (EventSource can't set headers); `?token=` fallback appended for shells. Gap recorded in ticket: API has no read route for review.json/diff/test-report — S-08 reads findings from event `data.review` when present, else empty state. Needs an api-package follow-up (`GET /tickets/<ref>/review`) | done |
| D17 | Importer (wp-061) decisions: `importers.default_repo_map` maps **issue labels** → repo names; unmapped → `repos: []` + `repo-map-unmapped` note (importer never guesses — import.md's "best guess" applies to agent-authored runs, the deterministic importer flags for triage). Label→priority heuristic: p0/p1/critical/urgent/blocker/sev1-2/priority:high → high; p3/p4/minor/trivial/nice-to-have/priority:low → low; else medium. `token_env` names the env var — its value is injected as `GH_TOKEN`/`GITHUB_TOKEN` into the `gh` child. | done |
| D20 | Design docs (`docs/design/`): snooze is a UI-level need → new `gate_items.snoozed_until` column + `/inbox` field (snoozed excluded from badge counts); `products:` config gets a dedicated S-02 tab (drives S-14 rollups); CSV import stays **v1** alongside GitHub (UI-INVENTORY WF-02), Jira alone is deferred; finding-verdict labels are `send to fix`/`dismiss`/`wontfix` — SCHEMAS §6 has no "accepted" status; `repair` kind is a first-class S-01 group + S-10 filter (DB enum, was missing from inventory) | done |
| D21 | Idea-board + hierarchy session (2026-10-04, FEATURES.md): **tickets repo dropped → DB-only** (Postgres truth; append-only `events` + immutable `doc_versions` replace git ledger); `workspace`+`product` → **project** (workspace stays internal key); hierarchy project→board→**initiative**(prd+tdd)→**feature**(feature.md+test.md+AC slice, = parent-with-docs)→ticket (+orphans); boards = Miro-style canvas, typed items, zones, icebox, **kanban work layer w/ FULL card actions + Jira-style filter**; synthesis = whole-board→Q&A→PRD+`provenance.json`, consumed→frozen→`shipped`; split machinery reused at both decompose levels; plan-package default + batch approvals + trust inheritance for initiative work; loop = shipped state + retro cards + spec-bug→board notes; new metrics (idea→merge lead time, cost/feature, board yield); S-15/16/17; sequencing = launch-fixes first | done |
| D21 | Home = **Board + Inbox tabs** (board default): 5 phase columns (Backlog·Spec·Build·Review·Done), unified workspaces, cards = id/title/priority/sub-status + attention badges; failed/blocked stay in-phase flagged (needs derived `phase` field); drag-drop = human-meaningful drops only, server-validated via `drop_targets`; drawer = hybrid (inline gate action + chat-to-edit via interview `ticket_ref`; monitor/review/ledger pop out); ranking now **human-anxiety-first** (supersedes blocking-first) for inbox list + badge emphasis; KPI strip = column counts + WIP only, S-12 stays separate. See `docs/design/s-01-board.md`, wp-081 | done |
| D22 | Board details (2026-10-03 interview): Done capped ~20 + "show more"; in-column sort attention-first→priority→age; non-ticket gate items = ops strip above columns (no fake column); board snooze hides the card; WIP warnings = configurable per-column soft limits; chat-to-edit = multi-turn on `main_model` via `POST /interview` + `ticket_ref`; drawer deep-linkable via `?ticket=<ref>`; claims = initials on badges + "only my moves" toggle; full keyboard nav deferred | done |
| D23 | Card → **full-page ticket focus** (`/tickets/<ref>/focus`), not a slide-out drawer — sidebar/topbar persist, two-column layout (work + context rail); drawer rejected for space. Drawer references in D21/D22 superseded | done |
| D24 | Focus page **replaces S-05** and is the centerpiece (`/tickets/<ref>`): pinned stepper + Your-move panel (current gate only); tabs Overview·Documents·Activity·Runs + status-conditional spotlight (full S-08 embedded in review, Failure, Split plan); persistent right-rail AI assistant scoped to the ticket (edits ticket.md + docs — needs `target` field on `/interview`); **every persisted doc change = a version**, history + MR-style diffs; Activity = full S-11 embedded. See `docs/design/s-05-ticket-focus.md`; mockups `s-01-board-ticket*.png` | done |
| D25 | Ticket Focus redesign (2026-10-04, **supersedes D24 layout only**): keep the Board; remove the horizontal phase strip and permanent AI rail. S-05 is a two-column operational hub with a wide workbench + narrow Status/What's-left rail; Next action is completed inline; tabs are Overview·Documentation·Activity·Runs + conditional spotlight; AI appears only in contextual ticket/doc/code-review editing flows. See `docs/design/s-05-ticket-focus.md` and `docs/design/mockups/dashboard-focus/` | done |

## Waves (see EXEC-PLAN.md)

| Wave | Package | Scope | Depends | Status |
| --- | --- | --- | --- | --- |
| W0 | wp-001 | Scaffold: pnpm workspace, TS config, vitest, lint, CI, layout | — | done |
| W0 | wp-002 | Contracts freeze: port `docs/prompts` + token table + SCHEMAS types into `packages/core` (zod) | wp-001 | done |
| W1 | wp-010 | Config layer: layered YAML load, precedence, .env, validation | wp-002 | done |
| W1 | wp-011 | Store: `Store` iface + SQLite impl (DB-SCHEMA), migrations | wp-002 | done |
| W1 | wp-012 | Git ops: tickets-repo sync (pull-rebase-retry), worktrees, ref-CAS, next-id | wp-002 | done |
| W2 | wp-020 | Prompt renderer: tokens, ARTIFACT_TARGETS, capability shaping | wp-010 | done |
| W2 | wp-021 | Adapter iface + **mock adapter** (scripted sentinels — the test backend) | wp-020 | done |
| W3 | wp-030 | Conductor core: tick loop, reconcile, leases, heartbeats, kill/pause | wp-011,021,023 | done |
| W2 | wp-022 | Devin adapter: `devin -p`, export parse, usage extract | wp-021 | done |
| W2 | wp-023 | Runner env-ops: sanitizer (gitleaks), verify tasks, artifact collect | wp-012 | done |
| W1 | wp-013 | Ticket projection: frontmatter parse → `tickets`/`ticket_repos` rows | wp-010,011,012 | done |
| W3 | wp-031 | State machine: sentinel→transition table, gate items, events.jsonl | wp-030 | done |
| W3 | wp-032 | Doc lints: spec-lint scorer, coverage-matrix, fail-closed validator | wp-031 | done |
| W4 | wp-040 | E2E vertical: mock-adapter pipeline imported→triage→…→commit on fixture repo | wp-030,031,032 | done |
| W5 | wp-050 | Review pipeline: 4-pass merge, fingerprints, review.json, fix rounds | wp-031 | done |
| W5 | wp-051 | Shepherd: gh poll, ci-fix/comment-fix/rebase runs, DoD gate | wp-050 | done |
| W5 | wp-052 | Aider adapter + OpenRouter pricing table, usage stream-parse | wp-021 | done |
| W6 | wp-060 | API: REST + SSE per API.md, token auth | wp-031 | done |
| W6 | wp-061 | Importers: GitHub issues → ticket folders | wp-013 | done |
| W7 | wp-070 | KB/survey: dossiers, entities, embeddings spike → impl | wp-011 | done |
| W8 | wp-080 | UI: 14 screens on the API (React+Vite, served by conductor) | wp-060 | done |
| W9 | wp-081 | Board home: Kanban + card drawer + validated drag-drop (D21) | wp-080 | todo |

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

## Follow-ups (post-MVP backlog, surfaced by work packages)

| Item | Source |
| --- | --- |
| `GET /tickets/<ref>/review` route missing — S-08 fails soft reading findings from event payloads | wp-080 |
| `run_output` SSE event has no producer (conductor doesn't stream log chunks) | wp-060 |
| `import/run.ts` `surfaceFailure` writes gate rows directly, bypasses `deps.notify` | wp-060 |
| POST `/workspaces` registers in-memory only — not persisted to config.yaml | wp-060 |
| `devin auth` absent on this machine → real `--export` schema + aider flag set unverified (D16; verify on first real run) | wp-022/052 |
| `packages/cli` commands still stubs (init/daemon/tick/status) — wire to conductor + api | — |
| `gate_items.snoozed_until` column + `/inbox` field needed for S-01 snooze (D20) | design review |
| `GET /board` + derived `phase` + `drop_targets` per card; `/interview` edit mode (`ticket_ref`/`target`/`session_id`) + `/interview/<session>/approve` + `doc_edited` event — API additions for board+focus (D21/D24, SCHEMAS §16) | wp-081 |

## Open risks

| Risk | Mitigation |
| --- | --- |
| D12 embeddings spike fails (onnx size/compat) | `embeddings: off` path is fully functional; local becomes `openrouter` fallback |
| Devin `--export` schema unknown | wp-022 starts with a spike run + documented findings |
| Spec-lint underspecified (D11) | wp-032 writes the rule set into SCHEMAS.md before coding |
| Multi-agent interface drift | wp-002 freezes contracts; review enforces no core edits outside wp-002 follow-ups |
