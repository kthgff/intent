---
schema: 1
id: wp-157
title: Test-environment requests — declarative env spec + conductor provisioning hook
status: todo
priority: low
depth: standard
repos: []
wave: W22
depends_on: [wp-131]
---

## Description
Thin MVP slice of the Test Environment/Data Studio (PRD §15.10):
tickets/features may carry a `test_env` spec (temp DB, synthetic seed
set, mocked externals, fixtures refs — declared in `vs.md`/ticket
metadata, versioned). Conductor `verify`/implement runs materialize
the declared env inside the container before execution (seed scripts
from the repo card, fixtures from `fixtures/` paths — never production
data, sanitizer still applies to anything leaving). Richer studio
(managed multi-service envs, state-request DSL) stays deferred —
recorded in follow-ups.

## File ownership
`packages/conductor/src/envops/**`, `packages/core` test_env schema,
`fixtures/**`

## Acceptance criteria
- [ ] Declared env materializes before verify/implement in-container
- [ ] No production-data path exists in the provisioning code
- [ ] Missing spec → existing behavior (no env step)
- [ ] `pnpm test` green

## Contract change
`test_env` field lands in wp-131.
