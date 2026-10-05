---
schema: 1
id: wp-135
title: Deployments, feature exposure, release notes, outcomes & retrospectives
status: todo
priority: high
depth: standard
repos: []
wave: W17
depends_on: [wp-134]
---

## Description
DELIVERY.md §3 tail + §7. `deployments` (manual evidence only for MVP —
`evidence.type='manual'` + by/note/url required, fail-closed without
it), `feature_exposure` (hidden|limited|available — `available`
requires a linked deployment, invariant 4), `release_notes` (three
audiences; content in doc_versions `notes-<audience>.md`; human approve
before `published_at`), `release_outcomes` (KPI baseline/target/
observed), and `retro.md` retrospectives: a `retro` agent run on
release close comparing delivered behavior vs approved RS + KPIs,
emitting draft board proposals — never committing scope (invariant 6).
New `release-notes` agent stage (doc-only, no repo exec). Events:
`deployment_confirmed`, `feature_exposed`, `release_note_approved`,
`retro_completed`, `correction_filed`.

## File ownership
`packages/store/src/pg.ts`, `packages/conductor/src/release/**`,
`packages/core/templates/release-notes.md` + `retro.md` (new),
`packages/prompts` token table additions

## Acceptance criteria
- [ ] Manual deployment evidence is required and validated
- [ ] Exposure `available` without a deployment fails closed
- [ ] Release notes draft → human approve → publish, per audience
- [ ] Retro run produces proposals + `retro.md`, no silent scope writes
- [ ] `pnpm test` green

## Contract change
New `release-notes` stage + doc kinds land in wp-131/132 — reuse.
