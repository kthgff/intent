---
schema: 1
id: wp-060
title: API surface — Fastify REST + SSE per API.md, token auth
status: done
priority: medium
depth: deep
repos: []
wave: W6
depends_on: [wp-031]
---

## Description
Implement API.md: bearer-token middleware on EVERY route incl. SSE +
static (token file bootstrap, ?token= loopback-only cookie path),
all resource routes backed by Store queries, gate writes idempotent
with expected_status → 409, SSE /stream emitting the five event types,
run control routes wired to conductor signals. Serve on ui.bind:port;
remote_access warnings. This is the contract the UI and shell consume —
freeze responses from DB-SCHEMA row shapes.

## File ownership
`packages/api/**`

## Acceptance criteria
- [x] Every route in API.md table exists w/ tests
- [x] Auth: no token → 401 everywhere incl. SSE and static assets
- [x] Stale gate write → 409; claim/release honored
- [x] SSE client reconnect reads durable state (no replay protocol)

## Implementation notes (wp-060)

- `packages/api`: `createServer({store, conductor, config, uiToken})` →
  FastifyInstance (+ `startServer` binding `ui.bind:ui.port`);
  `loadOrCreateToken(path)` (32-byte hex, 0600, fail-closed on
  malformed existing file); `StreamHub` SSE broadcast.
- **Additive conductor hook** (documented here per wp rules):
  `ConductorDeps.notify?: (event: StreamEvent) => void` +
  `StreamEvent` type in `conductor/src/loop/deps.ts`. Emitted AFTER
  each durable write: `run_status` on launch register + kill/pause/
  resume (`launch/index.ts`, `control/index.ts`), `gate_surfaced` +
  `notification` on `surfaceGateItem` (`loop/tools.ts`),
  `usage_partial` on the adapter `on_usage` stream (`launch/index.ts`).
  `run_output` has no producer yet — no conductor path streams log
  chunks; the type is in the union ready for a tail-ing path. The
  import run's `surfaceFailure` (import/run.ts) writes gate rows
  directly and was NOT re-wired (out of wp-030/031 file ownership;
  follow-up should route it through `deps.notify` or
  `tools.surfaceGateItem`).
- **Additive config export**: `parsePartialConfig` re-exported from
  `@sprint-runner/config` (used to fail-closed validate PUT /settings
  merges before writing config.yaml).
- Gate writes = `gate_items.cleared_at` + `gate_cleared` notify +
  durable event row; the conductor's `nextStage` cleared-gate path
  performs the follow-on (status write + re-run), exactly its existing
  mechanics. `expected_status` mismatch or already-cleared gate → 409.
- Actions mapping: `go_implement`/`open_pr`/`merge`/`approve_split`/
  `resume` → clear the matching gate (`test-approved`/`approved`/
  `ci-watch`/`split-plan`/`escalated`); `send_back`/`force_ready`/
  `wont_do` → `applyTicketStatus`; `revert`/`retry` → `queuePendingRun`
  (CLAIM launches pending rows); `handoff` → ledger event. Unknown
  actions → 501 `{error:'not_implemented'}`.
- Run ids contain `/` — `/runs/:id` routes take the URL-encoded id
  (`encodeURIComponent`); `/gate-items/<ws>/<subject>/<gate>/claim`
  uses path segments (subjects never contain `/`).
- POST /workspaces clones the tickets repo (real `git clone`) and
  registers it in-memory on `conductor.deps.workspaces` +
  `config.tickets_repos`; persisting the new entry into config.yaml is
  a follow-up (config.yaml write path exists via PUT /settings).
- Static mount: `GET /` serves a placeholder page behind the same
  auth; real assets land with wp-080.
