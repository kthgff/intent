---
schema: 1
id: wp-134
title: Release Center core — entities, lifecycle, manifest freeze, approvals
status: todo
priority: high
depth: deep
repos: []
wave: W17
depends_on: [wp-131, wp-133]
---

## Description
Implement DELIVERY.md §3–§4: `releases`/`release_items`/
`release_manifests`/`release_approvals`/`release_gate_results` tables
(from wp-131 schema) + Store impl + lifecycle engine. Statuses
`draft → ready → approved → released → closed|abandoned`. Feature-first
membership: items are features or standalone tickets; `partial_ac`
non-null requires `approved_by` (invariant 5). `freeze` cuts an
immutable manifest (sha256 digest over item→repo→merged_sha map);
approvals bind to manifest digest — scope change cuts a new version
and resets pending approvals (invariant 3). `release_released` flips
member tickets `→released` transactionally with events. AI may propose
membership/notes but cannot approve (invariant 6). Correction tickets
attach via `origin:'correction'` + `parent` (no new table); a material
open correction blocks its item's release gate.

## File ownership
`packages/store/src/pg.ts`, `packages/core` release schemas,
`packages/conductor/src/release/**` (new), `packages/lints` gate checks

## Acceptance criteria
- [ ] Full lifecycle + manifest immutability enforced fail-closed
- [ ] `release_released` transactionally updates member tickets + events
- [ ] Partial-release approval rule enforced
- [ ] Correction-ticket blocking rule verified by test
- [ ] Store tests green (PGlite)

## Contract change
None beyond wp-131.
