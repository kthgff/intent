---
schema: 1
id: wp-060
title: API surface — Fastify REST + SSE per API.md, token auth
status: todo
priority: medium
depth: deep
repos: []
wave: W6
depends_on: [wp-031]
---

## Description
Implement API.md: bearer-token middleware on EVERY route incl. SSE +
static (token file bootstrap, ?token= loopback-only cookie path),
all resource routes backed by Store queries, gate writes idempotent
with expected_status → 409, SSE /stream emitting the five event types,
run control routes wired to conductor signals. Serve on ui.bind:port;
remote_access warnings. This is the contract the UI and shell consume —
freeze responses from DB-SCHEMA row shapes.

## File ownership
`packages/api/**`

## Acceptance criteria
- [ ] Every route in API.md table exists w/ tests
- [ ] Auth: no token → 401 everywhere incl. SSE and static assets
- [ ] Stale gate write → 409; claim/release honored
- [ ] SSE client reconnect reads durable state (no replay protocol)
