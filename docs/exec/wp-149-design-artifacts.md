---
schema: 1
id: wp-149
title: Design artifacts — structured mockups, visual ACs, design approvals + Mockups UI
status: done
priority: high
depth: deep
repos: []
wave: W20
depends_on: [wp-131, wp-132]
---

## Description
PRD §15.4. Mockups as **structured component trees** (doc kind
`mockup.json` on feature/ticket subjects — screens, components w/ ids,
props, layout, states, `requirement:` links, responsive variants);
rendered previews from the tree; PNG/export is output, never source.
`design_approvals` table (wp-131): approval records mockup revision +
covered requirements + reviewer + rationale; material component change
invalidates only affected approvals. Visual ACs = `statement_artifact_
links`/`relations` edges AC→component+state. Design-approval checklist
(desktop/mobile/flows/error+empty/a11y/linked ACs). `mockup` agent
stage generates/edits trees (screenshot→mockup, sketch→screen via
multimodal model, screen-state generator for loading/empty/error/
permission/mobile). Design-system ingestion: extract component tokens
from the repo's UI library into a `design-system.json` artifact the
generator consumes. Post-merge comparison finding type (`design-drift`
— advisory, human verdict). UI: mockups tab on feature/ticket, canvas
renderer, comment pins, state switcher, approval checklist panel.

## File ownership
`packages/conductor/src/design/**` (new), `packages/core` mockup
schemas, `packages/ui/src/mockups/**`, `packages/api` design routes

## Acceptance criteria
- [ ] Component tree is source of truth; diffs are structural
- [ ] Approval binds to revision; partial invalidation works
- [ ] Screen-state + screenshot/sketch generators produce valid trees
- [ ] Implementation-comparison findings are advisory + human-verdicted
- [ ] UI canvas renders trees + records comments

## Contract change
`mockup.json` doc kind lands in wp-131.
