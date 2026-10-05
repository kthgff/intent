---
schema: 1
id: wp-147
title: Discovery UI — board canvas v2, Understanding Panel, wizard surface
status: todo
priority: high
depth: deep
repos: []
wave: W19
depends_on: [wp-131, wp-136, wp-146]
---

## Description
PRD §15.3/§15.9 surfaces in `packages/ui`: board canvas v2 — typed
sticky notes (type/color/icon per taxonomy), AI classification chip +
one-click correction, relationship suggestion edges (confirmable),
multi-board switcher + org boards, board-type picker on create.
**Understanding Panel** — live sidebar during interviews: confirmed /
interpretation / needs-clarification / decision-required, per-item
provenance popover, correction edits feeding back to statements.
**Wizard surface** — three input modes (conversation / guided choices /
bulk paste-upload, switchable mid-session), question card with "why
this question" provenance, slot-progress (not a % — state chips),
resume briefing modal. Voice input stays a `talk` transcript upload +
extraction (voice capture deferred).

## File ownership
`packages/ui/src/**`, `docs/UI-INVENTORY.md`, `docs/design/mockups/`

## Acceptance criteria
- [ ] All three input modes feed the same session state
- [ ] Understanding Panel updates live via SSE during interview
- [ ] Correction edits write statement versions, not silent overwrites
- [ ] Screens inventoried (UI-INVENTORY S-2x)

## Contract change
None.
