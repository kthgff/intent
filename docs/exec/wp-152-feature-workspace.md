---
schema: 1
id: wp-152
title: Feature Workspace — tabs, health rollup, acceptance package, scoped assistant
status: done
priority: medium
depth: standard
repos: []
wave: W21
depends_on: [wp-131, wp-134, wp-146]
---

## Description
PRD §15.7 feature workspace. Six tabs — Overview (objective, status,
owners), Requirements (multi-RS links, one primary, versioned
requirement refs), Design (mockup/TDD/ADR refs), Tickets (grouped by
type + status), Quality (AC evidence matrix, open findings, correction
tickets), Release (memberships, exposure, deployments). Feature Health
= explainable findings list (blockers, unverified ACs, stale approvals)
— never an opaque score. Feature Acceptance Package: approved scope
revision + mockups + actual screens/journeys + test evidence + known
exclusions → human acceptance gate before release assignment. Feature
completion is explicit acceptance, never implied by ticket completion.
`POST /interview` scoped to feature = "Ask About This Feature"
assistant over feature-scoped evidence.

## File ownership
`packages/api` feature routes, `packages/ui/src/features/**`,
`packages/conductor` acceptance-package assembly

## Acceptance criteria
- [x] All six tabs populated from live rows — S-17 `/features/<ws>/<feature>`: Overview/Requirements/Design/Tickets/Quality/Release, all server-computed (`GET /api/v1/features/<ref>` rollup; `/docs/<name>`, `/acs`)
- [x] Health shows findings with evidence links, no score — `conductor/features` `featureHealth`: 8 finding kinds, severity, `refs`; UI `FindingsList` renders refs verbatim (tested)
- [x] Acceptance gate required before release assignment — `POST /features/<ref>/accept` (durable `doc_approved` event + `done`, only path); `addReleaseItem` throws `not-approved` on unaccepted features; merge rollup caps at `active` (D46)
- [x] Feature-scoped assistant answers from its evidence only — `/interview` edit mode accepts `F-*` `subject_ref` (D27); chat-to-edit sessions over `feature|ac|vs|notes` doc targets

## Contract change
None.
