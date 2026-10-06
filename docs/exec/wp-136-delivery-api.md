---
schema: 1
id: wp-136
title: Delivery API — release/merge-center/exposure/notes routes + SSE + API.md backport
status: done
priority: high
depth: standard
repos: []
wave: W17
depends_on: [wp-134, wp-135]
---

## Description
Implement DELIVERY.md §6: REST routes for releases CRUD, items
add/remove (partial_ac), freeze, approve, deployments, exposure,
notes approve, retro trigger; `GET /merge-center` readiness view;
`POST /tickets/:t/corrections` creating an `origin:'correction'`
ticket with parent link. SSE events for every new event name.
Zod `parseBody` on all writes (existing fail-closed convention).
Backport routes + payloads into API.md in the same change.

## File ownership
`packages/api/src/**`, `docs/API.md`

## Acceptance criteria
- [x] Every §6 route implemented with fail-closed body parsing
- [x] SSE emits all W17 event names
- [x] API.md amended; contract tests cover happy + 400/409 paths
- [x] `pnpm test` green

## Contract change
API surface additions — API.md updated same PR (backport rule).
