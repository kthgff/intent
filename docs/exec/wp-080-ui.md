---
schema: 1
id: wp-080
title: Web UI — 14 screens on the conductor API
status: todo
priority: low
depth: deep
repos: []
wave: W8
depends_on: [wp-060]
---

## Description
React+Vite SPA served by the conductor (identical surface in webview
shell + browser per API.md). Screens S-01…S-14 per UI-INVENTORY.md:
inbox (blocking-first ranking), settings, create/import + interview,
Q&A wizard (recommended badges, Other, mic, Accept-all, bail-outs),
ticket detail w/ family rail, doc reviewer w/ diffs, run monitor w/
kill/pause + live usage counters, code review w/ findings triage, PR
panel, escalations, ledger browser, metrics dashboard, workspace
switcher, KB browser. Token bootstrap via loopback ?token= cookie.
Split into sub-tickets at kickoff — too big for one wp; this ticket
is the wave-8 epic.

## File ownership
`packages/ui/**`

## Acceptance criteria
- [ ] Every screen reachable + functional against real conductor API
- [ ] SSE drives inbox/badge/monitor without polling
- [ ] Accessibility basics; empty/error states on all list views
