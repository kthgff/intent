---
schema: 1
id: wp-137
title: Merge Center + Release Center UI
status: todo
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
- [ ] Both surfaces render end-to-end on the real API
- [ ] Stale-approval + partial-release states are visually distinct
- [ ] Screens listed in UI-INVENTORY (S-20+)
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None.
