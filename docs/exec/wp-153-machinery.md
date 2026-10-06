---
schema: 1
id: wp-153
title: Process machinery — DoR/DoD engines, Assumption Register, Quality Debt, Delivery Commitments
status: done
priority: medium
depth: deep
repos: []
wave: W21
depends_on: [wp-131, wp-134]
---

## Description
PRD §15.10. **DoR engine**: configurable per-type checklist evaluated
at `ready` transition (objective, requirements linked, ACs testable,
dependencies resolved, repo context available, security considered,
budget/permissions adequate) — failures land as gate items, not blocks
with no reason. **DoD engine**: merge-side checklist (extends
`merge.json` into per-type policy). **Assumption Register**
(`assumptions` table): auto-captured when stages record unverified
dependencies — owner, affected artifacts, impact-if-false, evidence
needed, status; high-impact unverified assumptions gate or get
risk-accepted by a human. **Quality Debt Register** (`quality_debt`):
accepted risk, deferred refactors, security exceptions w/ expiry, weak
tests, doc gaps — owner + revisit condition + approval trail;
consolidation suggestions (grouped → modernization board item) are
AI proposals only. **Delivery Commitments** (`delivery_commitments`):
versioned committed scope (features + requirement versions), target,
success criteria, exclusions, assumptions, accountable owner — planned
≠ committed ≠ implemented ≠ verified ≠ delivered.

## File ownership
`packages/store/src/pg.ts`, `packages/conductor/src/gates/**` (DoR/DoD),
`packages/conductor/src/registers/**` (new), `packages/api` routes,
`packages/core` schemas

## Acceptance criteria
- [x] DoR blocks `ready` with named missing checks
- [x] Assumptions surface in ticket/RS context; high-impact ones gate
- [x] Debt items carry owner + expiry; exceptions expire loudly
- [x] Commitments versioned; drift vs plan is visible on radar

## Contract change
None beyond wp-131.
