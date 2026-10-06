---
schema: 1
id: wp-159
title: Wave close-out — docs reconciliation + full suite green + TRACKER update
status: done
priority: high
depth: standard
repos: []
wave: W23
depends_on: [wp-138, wp-142, wp-147, wp-150, wp-152, wp-153, wp-154, wp-156, wp-157, wp-158]
---

## Description
Final gate for the addendum wave: reconcile every touched spec
(DB-SCHEMA, SCHEMAS, API, CONDUCTOR, SETTINGS, UI-INVENTORY,
INTELLIGENCE, DELIVERY, PRD §15 dispositions → mark landed items),
verify no §15.11-deferred scope leaked in (no billing/RBAC/cloud-
sandbox code paths), run the complete suite (`pnpm typecheck &&
pnpm test && pnpm lint`) on PGlite + real-Postgres where available,
and update all TRACKER rows. Any spec gap hit during the wave must
already be backported — this wp verifies rather than discovers.

## File ownership
`docs/**`, `packages/*/test/**`

## Acceptance criteria
- [x] All specs consistent with landed code (spot-audit per domain)
- [x] No deferred-scope implementation present
- [x] Full suite green; real-Postgres pass recorded
- [x] TRACKER: every wave row `done` or explicitly `cut` w/ reason

## Contract change
None.

## Completion notes (2026-10-07)

- **Spec audit:** API.md was missing the wp-153 register routes —
  `/assumptions`, `/quality-debt`, `/commitments` (+confirm/status
  writes) backported into the Resources table. All other route groups
  (DELIVERY §6, alignment, telemetry/incidents, scope-radar,
  boards/interview-sessions/understanding/statements) verified present.
  Migrations 0001–0008 reconcile with DB-SCHEMA.
- **Deferred scope:** grep audit clean — no billing/RBAC/cloud-sandbox
  code paths (`rbac`/`stripe`/`billing` hits are security-review
  keyword patterns, cost-null comments, and DemoApp fixture data).
  `org` columns remain `nullish()` per design-for-both (D43).
- **Full suite:** `pnpm typecheck` green; `pnpm test` green —
  core 52, gitops, config, prompts, lints, kb, conductor
  **34 files / 488 passed / 11 skipped**, api 124, cli 44, ui 42,
  store. `pnpm lint` green (404 files).
- **Docker e2e:** the 11 skips are `describe.skipIf(!DOCKER_OK)` —
  the daemon was down during the suite run (Docker Desktop 20.10
  crashes under load on this machine). Re-run alone after restart:
  `container-conductor.test.ts` **10/10 incl. the pause test** —
  earlier failures were daemon-load environmental, not a regression.
- **Real-Postgres pass:** PGlite only (no real Postgres configured
  on this machine) — recorded per AC.
- **TRACKER:** every wave row `done`; zero `todo`/`cut` remain.
