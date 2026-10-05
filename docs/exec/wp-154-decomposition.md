---
schema: 1
id: wp-154
title: Work Decomposition Engine + contract-first tickets + integration coordination
status: todo
priority: medium
depth: deep
repos: []
wave: W21
depends_on: [wp-131, wp-143]
---

## Description
PRD §15.7/§15.10. The existing split machinery gains a real
decomposition pass: logical boundaries, repo/service ownership,
dependencies, API/event contracts, test obligations, security-
sensitive changes, expected complexity, parallel opportunities,
merge-conflict risk. Tickets carry `execution_readiness` +
`parallel_safety` (wp-131 cols) computed from slots+statements+deps.
**Contract-first**: when a feature's tickets share interfaces,
approved API/data/event contracts land as `contract.json` artifacts
BEFORE implement runs; consuming tickets pin the contract version in
`runs.request.baseline`. Integration Coordinator: dependency-aware
scheduling (sequential where contracts demand it), shared-file
conflict prediction, post-merge revalidation of dependent tickets.
Conservative default: one AI execution per ticket; parallelism expands
only on measured low conflict rates.

## File ownership
`packages/conductor/src/decompose/**` (new), split transitions,
`packages/core` contract schemas, `packages/lints` contract checks

## Acceptance criteria
- [ ] Decomposition output includes contracts + readiness/safety attrs
- [ ] Contracts pinned per run; drift → revalidation, not silent proceed
- [ ] Dependency-aware sequencing observable in claim order
- [ ] `pnpm test` green

## Contract change
`contract.json` artifact kind — declare in wp-131 additions.
