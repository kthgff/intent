---
schema: 1
id: wp-137
title: Merge Center + Release Center UI
status: done
priority: high
depth: standard
repos: []
wave: W17
depends_on: [wp-131, wp-136]
---

## Description
Two new UI surfaces (D34 theming rules apply): **Merge Center** —
per-ticket readiness checklist (green/blocked/unknown per row),
merge order queue, conflict cards linking to the `rebase` run, merge
SHA/PR link after merge. **Release Center** — release list + detail:
item membership (feature/ticket, partial-AC badge), manifest diff vs
approved RS scope, approval actions bound to manifest digest,
deployment evidence form (manual MVP), exposure controls, three-
audience notes editor with approve/publish, retro view. Delivery
status chip joins dev-status on ticket cards (two-dimension display).
Build against wp-136 contract; mock the API in `packages/ui` until it
lands (UI-lane rule).

## File ownership
`packages/ui/src/**`, `docs/UI-INVENTORY.md` (screen adds), mockups
under `docs/design/mockups/`

## Acceptance criteria
- [x] Both surfaces render end-to-end on the real API (`/merge-center`,
  `/releases` + `/releases/:ws/:rel` — see D48 for the additive read
  routes the UI needed: release docs, notes draft/run, deployments +
  noteDrafts on the detail payload)
- [x] Stale-approval + partial-release states are visually distinct
  (stale-approval badge on superseded manifest approvals; `unapproved-draft`
  note state when a draft outruns the pinned doc_version; `partial (ac-ids)`
  warn chip on scope items)
- [x] Screens listed in UI-INVENTORY (S-21 Merge Center, S-22 Release
  Center)
- [x] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None.
